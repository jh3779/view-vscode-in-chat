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
};

const POLICY = {
  chat: { bucket: 'say', maxText: MAX_TEXT },
  action: { bucket: 'say', maxText: MAX_TEXT },
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

function take(client, name, amount) {
  const spec = BUCKETS[name];
  const now = Date.now();
  const b = (client.buckets[name] ||= { tokens: spec.capacity, ts: now });
  b.tokens = Math.min(spec.capacity, b.tokens + (now - b.ts) / spec.refillMs);
  b.ts = now;
  if (b.tokens < amount) return false;
  b.tokens -= amount;
  return true;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// channel -> message[]
const history = new Map(DEFAULT_CHANNELS.map((c) => [c, []]));
// clientId -> { id, nick, color, res, kind, buckets }
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

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event, data) {
  for (const c of clients.values()) send(c.res, event, data);
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
  const client = { id, nick, color, res, kind, buckets: {} };
  clients.set(id, client);

  send(res, 'welcome', {
    id,
    nick,
    color,
    channels: channelList(),
    history: Object.fromEntries(history),
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
  // 에이전트 출력 중계: 에이전트는 요청한 사람의 PC에서 그 사람의 키로 실행되고, 결과만 방에 공유됩니다.
  if (type.startsWith('agent-')) return relayAgent(res, client, body, type, channel, text, now);

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

function relayAgent(res, client, body, type, channel, text, now) {
  const base = { userId: `agent:${client.id}`, nick: AGENT.nick, color: AGENT.color, agent: true, via: client.nick };
  if (type === 'agent-typing') {
    broadcast('typing', { ...base, channel, detail: String(body.detail || '생각 중').slice(0, 120), since: Number(body.since) || now, ts: now });
  } else if (type === 'agent-idle') {
    broadcast('typing-end', { userId: base.userId, channel });
  } else if (type === 'agent-text') {
    if (!text.trim()) return json(res, 400, { error: 'empty' });
    pushMessage(channel, { id: crypto.randomUUID(), type: 'chat', channel, ts: now, text, ...base });
  } else {
    pushMessage(channel, { id: crypto.randomUUID(), type: 'system', channel, ts: now, text, agent: true, via: client.nick });
  }
  json(res, 200, { ok: true });
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
async function start({ port = PORT, host = '0.0.0.0' } = {}) {
  PORT = await listen(port, host, 20);
  return { port: PORT, addresses: lanAddresses().map((a) => `http://${a}:${PORT}`) };
}

function stop() {
  for (const c of clients.values()) c.res.end();
  clients.clear();
  return new Promise((resolve) => server.close(() => resolve()));
}

module.exports = { start, stop, lanAddresses, stats: () => ({ users: clients.size }) };

if (require.main === module) {
  start({ host: process.env.HOST || '0.0.0.0' }).then(({ port, addresses }) => {
    console.log(`\n  채팅 서버가 실행 중입니다.\n`);
    console.log(`  로컬:          http://localhost:${port}`);
    for (const a of addresses) console.log(`  같은 네트워크: ${a}`);
    console.log('');
  });
}
