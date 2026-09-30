// 의존성 없는 LAN 채팅 서버 (Node http + Server-Sent Events)
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

let PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const HISTORY_LIMIT = 200;
const MAX_TEXT = 2000;
const MAX_NICK = 20;
const MAX_AGENT_TEXT = 8000;
const MAX_LOG_TEXT = 500;
const AGENT = { nick: 'claude', color: '#d7875f' };
const DEFAULT_CHANNELS = ['general', 'random', 'dev'];

// ---------- 전송 정책 ----------
// 종류별 토큰 버킷. handleSend 입구에서 단 한 번 적용하므로 특정 타입만 빠져나가는 경로가 없다.
// POLICY에 없는 타입은 거부되므로, 새 타입을 추가하면서 제한을 빠뜨릴 수 없다.
const BUCKETS = {
  say: { capacity: 6, refillMs: 300 }, // 사람이 직접 보내는 메시지
  hint: { capacity: 2, refillMs: 1000 }, // 저장되지 않는 일시 신호
  agent: { capacity: 30, refillMs: 200 }, // 에이전트 출력 — 도구 로그가 연달아 온다
  auth: { capacity: 5, refillMs: 10000 }, // 비밀번호 시도 — 무차별 대입 방어
};

const POLICY = {
  chat: { bucket: 'say', maxText: MAX_TEXT },
  action: { bucket: 'say', maxText: MAX_TEXT },
  cli: { bucket: 'say', maxText: MAX_TEXT },
  nick: { bucket: 'say' },
  join: { bucket: 'say' },
  typing: { bucket: 'hint', quiet: true },
  'agent-typing': { bucket: 'hint', quiet: true },
  'agent-idle': { bucket: 'hint', quiet: true },
  'agent-text': { bucket: 'agent', maxText: MAX_AGENT_TEXT },
  'agent-log': { bucket: 'agent', maxText: MAX_LOG_TEXT },
};

// 1000자마다 토큰을 하나 더 쓴다 — 긴 메시지가 짧은 메시지와 같은 값이 되지 않도록.
const costOf = (text) => 1 + Math.floor(text.length / 1000);

function take(holder, name, amount) {
  const spec = BUCKETS[name];
  const now = Date.now();
  const b = (holder.buckets[name] ||= { tokens: spec.capacity, ts: now });
  b.tokens = Math.min(spec.capacity, b.tokens + (now - b.ts) / spec.refillMs);
  b.ts = now;
  if (b.tokens < amount) return false;
  b.tokens -= amount;
  return true;
}

// ---------- 방 비밀번호 ----------
// 비밀번호를 정한 방은 토큰 없이는 이벤트 스트림에 붙을 수 없다. 정적 파일(앱 껍데기)은
// 누구나 받을 수 있지만, 대화 내용은 전부 스트림으로만 나가므로 경계는 여기 하나다.
let roomAuth = null; // { salt, hash } — null 이면 비밀번호 없는 방
const tokens = new Set();
const authTries = new Map(); // ip -> { buckets }

function setPassword(pw) {
  const s = String(pw || '');
  tokens.clear();
  // 이전 실패 횟수는 지금 없어진 비밀번호에 대한 것이므로 함께 비운다.
  // 비밀번호를 바꿀 수 있는 건 방장뿐이라 이 초기화가 공격자에게 열려 있지 않다.
  authTries.clear();
  for (const c of clients.values()) c.res.end(); // 규칙이 바뀌면 전원 재인증
  clients.clear();
  if (!s) {
    roomAuth = null;
    return false;
  }
  const salt = crypto.randomBytes(16);
  roomAuth = { salt, hash: crypto.scryptSync(s, salt, 64) };
  return true;
}

// scrypt 는 느리게 설계된 해시라 대입 공격 자체가 비싸고, 비교는 길이·내용 모두
// 상수 시간으로 한다.
function passwordOk(pw) {
  if (!roomAuth) return true;
  const got = crypto.scryptSync(String(pw || ''), roomAuth.salt, 64);
  return crypto.timingSafeEqual(got, roomAuth.hash);
}

const isLocked = () => Boolean(roomAuth);
const tokenOk = (t) => !roomAuth || tokens.has(String(t || ''));

function issueToken() {
  const t = crypto.randomBytes(24).toString('base64url');
  tokens.add(t);
  return t;
}

function authAllowed(ip) {
  const key = String(ip || '?');
  const holder = authTries.get(key) || { buckets: {} };
  authTries.set(key, holder);
  return take(holder, 'auth', 1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// channel -> message[]   (일반 대화창 — 방 전체 공유)
const history = new Map(DEFAULT_CHANNELS.map((c) => [c, []]));
// key -> message[]       (CLI 대화창 — 소유자에게만 전송, 방 히스토리와 절대 섞이지 않는다)
const cliHistory = new Map();
// clientId -> { id, nick, color, res, kind, key, buckets }
const clients = new Map();

const COLORS = ['#4fc1ff', '#c586c0', '#dcdcaa', '#4ec9b0', '#ce9178', '#b5cea8', '#d7ba7d', '#9cdcfe', '#f48771'];

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

function sanitizeNick(nick) {
  const n = String(nick || '').replace(/[\s\u0000-\u001f]+/g, '').slice(0, MAX_NICK);
  return n.toLowerCase() === AGENT.nick ? '' : n; // 에이전트 이름은 예약
}

function sanitizeChannel(ch) {
  return String(ch || '').toLowerCase().replace(/[^a-z0-9가-힣_-]/g, '').slice(0, 24);
}

// CLI 대화창 소유권 키. 기기에 저장된 값을 그대로 쓰되, 형식이 맞지 않으면 새로 발급한다.
function sanitizeKey(k) {
  return /^[A-Za-z0-9_-]{16,64}$/.test(String(k || '')) ? String(k) : null;
}

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event, data) {
  for (const c of clients.values()) send(c.res, event, data);
}

// CLI 대화창 전용 전송. 같은 키를 가진 연결(본인의 터미널·브라우저)에만 보낸다.
// 다른 참가자는 SSE에 직접 붙어도 이 이벤트를 받지 못한다.
function sendToOwner(key, event, data) {
  for (const c of clients.values()) if (c.key === key) send(c.res, event, data);
}

function pushCli(key, msg) {
  const list = cliHistory.get(key) || [];
  list.push(msg);
  if (list.length > HISTORY_LIMIT) list.shift();
  cliHistory.set(key, list);
  sendToOwner(key, 'cli-message', msg);
}

function userList() {
  return [...clients.values()].map((c) => ({ id: c.id, nick: c.nick, color: c.color, kind: c.kind }));
}

function channelList() {
  return [...history.keys()];
}

function pushMessage(channel, msg) {
  if (!history.has(channel)) {
    history.set(channel, []);
    broadcast('channels', channelList());
  }
  const list = history.get(channel);
  list.push(msg);
  if (list.length > HISTORY_LIMIT) list.shift();
  broadcast('message', msg);
}

function system(channel, text, extra = {}) {
  pushMessage(channel, { id: crypto.randomUUID(), type: 'system', channel, text, ts: Date.now(), ...extra });
}

// POLICY가 허용하는 가장 긴 본문(agent-text 8000자)을 UTF-8 최악(문자당 3바이트)으로
// 담고도 남는 크기. 이 값이 작으면 정책상 허용된 메시지가 전송 계층에서 먼저 잘린다.
const MAX_BODY = 32 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let over = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (over) return; // 남은 본문은 버리되 소켓은 살려 둔다 — 응답을 보내야 하므로
      size += chunk.length;
      if (size > MAX_BODY) {
        over = true;
        chunks.length = 0;
        const err = new Error('본문이 너무 큽니다.');
        err.status = 413;
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function handleEvents(req, res, url) {
  // 비밀번호가 걸린 방은 여기서 막는다. 대화 내용은 전부 이 스트림으로만 나가므로
  // 이 한 곳만 지키면 방 안의 어떤 것도 인증 없이 새지 않는다.
  if (!tokenOk(url.searchParams.get('token'))) return json(res, 401, { error: '인증이 필요합니다.' });

  const nick = sanitizeNick(url.searchParams.get('nick')) || `guest${Math.floor(Math.random() * 9000 + 1000)}`;
  const id = crypto.randomUUID();
  const color = COLORS[clients.size % COLORS.length];

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');

  const kind = url.searchParams.get('client') === 'cli' ? 'cli' : 'web';
  const key = sanitizeKey(url.searchParams.get('key')) || crypto.randomUUID().replace(/-/g, '');
  const client = { id, nick, color, res, kind, key, buckets: {} };
  clients.set(id, client);

  send(res, 'welcome', {
    id,
    nick,
    color,
    key, // 클라이언트가 없거나 형식이 틀렸으면 새로 발급된 값 — 기기에 저장해 두면 다음에도 같은 CLI 대화창을 연다
    channels: channelList(),
    history: Object.fromEntries(history),
    cli: cliHistory.get(key) || [], // 내 CLI 대화창만. 남의 것은 이 응답에 들어가지 않는다
    users: userList(),
    addresses: lanAddresses().map((a) => `http://${a}:${PORT}`),
  });
  broadcast('users', userList());
  system('general', `Join(${nick})\n⎿  #general 에 접속했습니다`);

  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(id);
    broadcast('users', userList());
    system('general', `Leave(${nick})\n⎿  연결이 종료되었습니다`);
  });
}

async function handleSend(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return json(res, e.status || 400, { error: e.message });
  }
  const client = clients.get(body.id);
  if (!client) return json(res, 401, { error: 'unknown client' });

  const type = body.type || 'chat';
  const rule = POLICY[type];
  if (!rule) return json(res, 400, { error: `알 수 없는 요청 종류: ${type}` });

  const text = rule.maxText ? String(body.text || '').slice(0, rule.maxText) : '';
  if (!take(client, rule.bucket, costOf(text))) {
    // 일시 신호는 놓쳐도 곧 다음 신호가 오므로 조용히 버린다.
    if (rule.quiet) return json(res, 200, { ok: true, dropped: true });
    return json(res, 429, { error: '너무 빠르게 보내고 있습니다.' });
  }

  const now = Date.now();
  const channel = sanitizeChannel(body.channel) || 'general';

  if (type === 'typing') {
    broadcast('typing', { userId: client.id, nick: client.nick, color: client.color, channel, ts: now });
    return json(res, 200, { ok: true });
  }
  // CLI 대화창: 일반 대화창과 완전히 분리된 개인 창. 소유자에게만 전송·저장된다.
  if (type === 'cli') {
    if (!text.trim()) return json(res, 400, { error: 'empty' });
    pushCli(client.key, {
      id: crypto.randomUUID(), type: 'cli', ts: now,
      userId: client.id, nick: client.nick, color: client.color, text,
    });
    return json(res, 200, { ok: true });
  }
  // 에이전트 출력 중계: 요청한 사람의 PC에서 그 사람의 키로 실행된 결과를 본인 CLI 창에만 되돌려준다.
  if (type.startsWith('agent-')) return relayAgent(res, client, body, type, text, now);

  if (type === 'nick') {
    const nick = sanitizeNick(body.nick);
    if (!nick) return json(res, 400, { error: '사용할 수 없는 닉네임입니다.' });
    const old = client.nick;
    client.nick = nick;
    broadcast('users', userList());
    system(channel, `Rename(${old} → ${nick})\n⎿  닉네임이 변경되었습니다`);
    return json(res, 200, { ok: true, nick });
  }

  if (type === 'join') {
    if (!history.has(channel)) {
      history.set(channel, []);
      broadcast('channels', channelList());
      system(channel, `CreateChannel(#${channel})\n⎿  ${client.nick} 님이 채널을 만들었습니다`);
    }
    return json(res, 200, { ok: true, channel });
  }

  if (!text.trim()) return json(res, 400, { error: 'empty' });

  const msg = {
    id: crypto.randomUUID(),
    type,
    channel,
    userId: client.id,
    nick: client.nick,
    color: client.color,
    text,
    ts: now,
  };
  pushMessage(channel, msg);
  json(res, 200, { ok: true });
}

function relayAgent(res, client, body, type, text, now) {
  const base = { userId: `agent:${client.key}`, nick: AGENT.nick, color: AGENT.color, agent: true };
  // 어느 가지도 broadcast를 쓰지 않는다 — 에이전트 출력이 방으로 새는 경로를 두지 않기 위해.
  if (type === 'agent-typing') {
    sendToOwner(client.key, 'cli-typing', { ...base, detail: String(body.detail || '생각 중').slice(0, 120), since: Number(body.since) || now, ts: now });
  } else if (type === 'agent-idle') {
    sendToOwner(client.key, 'cli-typing-end', { userId: base.userId });
  } else if (type === 'agent-text') {
    if (!text.trim()) return json(res, 400, { error: 'empty' });
    pushCli(client.key, { id: crypto.randomUUID(), type: 'agent', ts: now, text, ...base });
  } else {
    pushCli(client.key, { id: crypto.randomUUID(), type: 'agent-log', ts: now, text, ...base });
  }
  json(res, 200, { ok: true });
}

// 방 상태 조회. 로그인 화면을 그리려면 인증 전에도 읽을 수 있어야 하므로 열어 둔다.
// 비밀번호 유무와, 가진 토큰이 아직 유효한지만 알려 준다.
function handleRoomInfo(res, url) {
  json(res, 200, { locked: isLocked(), authed: tokenOk(url.searchParams.get('token')) });
}

async function handleAuth(req, res) {
  const ip = req.socket.remoteAddress;
  if (!authAllowed(ip)) return json(res, 429, { error: '시도가 너무 잦습니다. 잠시 후 다시 해 주세요.' });

  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return json(res, e.status || 400, { error: e.message });
  }
  if (!isLocked()) return json(res, 200, { token: '', locked: false });
  if (!passwordOk(body.password)) return json(res, 401, { error: '비밀번호가 맞지 않습니다.' });
  json(res, 200, { token: issueToken(), locked: true });
}

function serveStatic(req, res, url) {
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/events') return handleEvents(req, res, url);
  if (req.method === 'GET' && url.pathname === '/api/room') return handleRoomInfo(res, url);
  if (req.method === 'POST' && url.pathname === '/auth') return handleAuth(req, res);
  if (req.method === 'POST' && url.pathname === '/send') return handleSend(req, res);
  if (req.method === 'GET') return serveStatic(req, res, url);
  res.writeHead(405);
  res.end();
});

function listen(port, host, attempts) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listening', onListening);
      if (err.code === 'EADDRINUSE' && attempts > 1) resolve(listen(port + 1, host, attempts - 1));
      else reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server.address().port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

// 포트가 사용 중이면 다음 포트로 최대 20번까지 넘어갑니다.
async function start({ port = PORT, host = '0.0.0.0', password = '' } = {}) {
  setPassword(password);
  PORT = await listen(port, host, 20);
  return { port: PORT, locked: isLocked(), addresses: lanAddresses().map((a) => `http://${a}:${PORT}`) };
}

function stop() {
  for (const c of clients.values()) c.res.end();
  clients.clear();
  tokens.clear();
  authTries.clear();
  const closed = new Promise((resolve) => server.close(() => resolve()));
  // res.end() 만으로는 keep-alive 소켓이 남아 close 콜백이 늦어질 수 있다.
  // 브라우저는 스트림이 끝나도 소켓을 재사용하려 붙들고 있으므로 명시적으로 끊는다.
  server.closeAllConnections?.();
  return closed;
}

module.exports = {
  start,
  stop,
  lanAddresses,
  setPassword,
  isLocked,
  stats: () => ({ users: clients.size, locked: isLocked() }),
};

if (require.main === module) {
  start({ host: process.env.HOST || '0.0.0.0', password: process.env.ROOM_PASSWORD || '' }).then(({ port, addresses, locked }) => {
    console.log(`\n  채팅 서버가 실행 중입니다.${locked ? '  🔒 비밀번호 있음' : ''}\n`);
    console.log(`  로컬:          http://localhost:${port}`);
    for (const a of addresses) console.log(`  같은 네트워크: ${a}`);
    console.log('');
  });
}
