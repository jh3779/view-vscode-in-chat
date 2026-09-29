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
const DEFAULT_CHANNELS = ['general', 'random', 'dev'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// channel -> message[]
const history = new Map(DEFAULT_CHANNELS.map((c) => [c, []]));
// clientId -> { id, nick, color, res, lastSent, lastTyping }
const clients = new Map();

const COLORS = ['#4fc1ff', '#c586c0', '#dcdcaa', '#4ec9b0', '#ce9178', '#b5cea8', '#d7ba7d', '#9cdcfe', '#f48771'];

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

function sanitizeNick(nick) {
  return String(nick || '').replace(/[\s\u0000-\u001f]+/g, '').slice(0, MAX_NICK);
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
  return [...clients.values()].map((c) => ({ id: c.id, nick: c.nick, color: c.color }));
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

function system(channel, text) {
  pushMessage(channel, { id: crypto.randomUUID(), type: 'system', channel, text, ts: Date.now() });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 16 * 1024) {
        reject(new Error('payload too large'));
        req.destroy();
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

  const client = { id, nick, color, res, lastSent: 0 };
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
    return json(res, 400, { error: e.message });
  }
  const client = clients.get(body.id);
  if (!client) return json(res, 401, { error: 'unknown client' });

  const now = Date.now();
  if (body.type === 'typing') {
    if (now - (client.lastTyping || 0) > 1000) {
      client.lastTyping = now;
      const channel = sanitizeChannel(body.channel) || 'general';
      broadcast('typing', { userId: client.id, nick: client.nick, color: client.color, channel, ts: now });
    }
    return json(res, 200, { ok: true });
  }
  if (now - client.lastSent < 150) return json(res, 429, { error: '너무 빠르게 보내고 있습니다.' });
  client.lastSent = now;

  const channel = sanitizeChannel(body.channel) || 'general';

  if (body.type === 'nick') {
    const nick = sanitizeNick(body.nick);
    if (!nick) return json(res, 400, { error: '사용할 수 없는 닉네임입니다.' });
    const old = client.nick;
    client.nick = nick;
    broadcast('users', userList());
    system(channel, `Rename(${old} → ${nick})\n⎿  닉네임이 변경되었습니다`);
    return json(res, 200, { ok: true, nick });
  }

  if (body.type === 'join') {
    if (!history.has(channel)) {
      history.set(channel, []);
      broadcast('channels', channelList());
      system(channel, `CreateChannel(#${channel})\n⎿  ${client.nick} 님이 채널을 만들었습니다`);
    }
    return json(res, 200, { ok: true, channel });
  }

  const text = String(body.text || '').slice(0, MAX_TEXT);
  if (!text.trim()) return json(res, 400, { error: 'empty' });

  pushMessage(channel, {
    id: crypto.randomUUID(),
    type: body.type === 'action' ? 'action' : 'chat',
    channel,
    userId: client.id,
    nick: client.nick,
    color: client.color,
    text,
    ts: now,
  });
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
