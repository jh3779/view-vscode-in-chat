// Electron 메인 프로세스: 앱 안에서 채팅 서버를 열고(호스트), LAN에서 방을 찾아 참가합니다.
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const os = require('os');
const dgram = require('dgram');
const server = require('../server');

const DISCOVERY_PORT = 41234;
const BEACON_MS = 2000;
const ROOM_TTL_MS = 6500;
const IS_MAC = process.platform === 'darwin';

let launcher = null;
let chat = null;
let chatOrigin = ''; // 채팅 창이 머물러도 되는 origin. 방을 옮기면 갱신된다.
let hosting = null; // { port, name, timer }
const rooms = new Map(); // "ip:port" -> { ip, port, name, users, seen }

// ---------- LAN discovery (UDP broadcast) ----------
function broadcastTargets() {
  const targets = new Set(['255.255.255.255']);
  for (const i of Object.values(os.networkInterfaces()).flat()) {
    if (!i || i.family !== 'IPv4' || i.internal || !i.netmask) continue;
    const a = i.address.split('.').map(Number);
    const m = i.netmask.split('.').map(Number);
    targets.add(a.map((x, k) => (x | (~m[k] & 255))).join('.'));
  }
  return [...targets];
}

const beaconSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
beaconSocket.on('error', () => {});
beaconSocket.bind(() => beaconSocket.setBroadcast(true));

function sendBeacon() {
  if (!hosting) return;
  const msg = Buffer.from(JSON.stringify({
    app: 'lan-agent-chat', v: 1, name: hosting.name, port: hosting.port,
    users: server.stats().users, locked: server.isLocked(),
  }));
  for (const t of broadcastTargets()) beaconSocket.send(msg, DISCOVERY_PORT, t, () => {});
}

const listenSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
listenSocket.on('error', (err) => console.error('discovery:', err.message));
listenSocket.on('message', (buf, rinfo) => {
  try {
    const b = JSON.parse(buf.toString('utf8'));
    if (b.app !== 'lan-agent-chat' || !Number.isInteger(b.port)) return;
    const key = `${rinfo.address}:${b.port}`;
    rooms.set(key, {
      ip: rinfo.address, port: b.port, name: String(b.name || '').slice(0, 40),
      users: Number(b.users) || 0, locked: Boolean(b.locked), seen: Date.now(),
    });
  } catch {}
});
listenSocket.bind(DISCOVERY_PORT);

setInterval(() => {
  const now = Date.now();
  for (const [k, r] of rooms) if (now - r.seen > ROOM_TTL_MS) rooms.delete(k);
  const list = roomList();
  if (launcher && !launcher.isDestroyed()) launcher.webContents.send('rooms', list);
  if (chat && !chat.isDestroyed()) chat.webContents.send('rooms', list);
}, 1000);

// 내가 연 방도 목록에 포함시킨다 — 자기 비콘은 받지 못하기 때문이다.
function roomList() {
  const list = [...rooms.values()];
  if (hosting) {
    const mineKey = `${hosting.port}`;
    if (!list.some((r) => String(r.port) === mineKey && isLoopbackOrSelf(r.ip))) {
      list.unshift({
        ip: 'localhost', port: hosting.port, name: hosting.name,
        users: server.stats().users, locked: server.isLocked(), self: true, seen: Date.now(),
      });
    }
  }
  return list;
}

const selfAddresses = () => new Set(['localhost', '127.0.0.1', ...server.lanAddresses()]);
const isLoopbackOrSelf = (ip) => selfAddresses().has(ip);

// ---------- windows ----------
function createLauncher() {
  launcher = new BrowserWindow({
    width: 720,
    height: 520,
    resizable: false,
    backgroundColor: '#1e1e1e',
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'default',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  launcher.loadFile(path.join(__dirname, 'launcher.html'));
  launcher.on('closed', () => { launcher = null; });
}

function openChat(baseUrl, nick, token) {
  const url = new URL(baseUrl);
  url.searchParams.set('nick', nick);
  if (token) url.searchParams.set('token', token);
  chat = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 480,
    minHeight: 360,
    backgroundColor: '#1e1e1e',
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 12, y: 9 },
    webPreferences: {
      preload: path.join(__dirname, 'chat-preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  // 외부 링크는 기본 브라우저로, 채팅 서버 밖으로의 이동은 차단
  chat.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });
  chatOrigin = url.origin;
  chat.webContents.on('will-navigate', (e, target) => {
    if (new URL(target).origin !== chatOrigin) e.preventDefault();
  });
  chat.loadURL(url.toString());
  // 채팅 창을 닫으면 앱을 끝낸다. 방을 옮길 때는 창을 닫는 대신 채팅 화면 안의
  // ROOMS 목록에서 고른다(switch-room). 창이 0개가 되면 window-all-closed 가
  // 받아 처리하므로 여기서 따로 종료를 부르지 않는다.
  chat.on('closed', () => { chat = null; });
  if (launcher) launcher.close();
}

// 서버가 완전히 닫히기 전에 다시 열면 포트가 겹치므로, 진행 중인 종료를 붙잡아 둔다.
let stopping = null;

function stopHosting() {
  if (!hosting) return Promise.resolve();
  clearInterval(hosting.timer);
  hosting = null;
  stopping = server.stop().finally(() => { stopping = null; });
  return stopping;
}

// ---------- IPC from launcher ----------
// 어떤 단계도 무한정 기다리지 않는다. 런처가 '서버를 시작하는 중…'에 갇히면
// 사용자는 원인을 알 수 없고 앱을 강제 종료하는 수밖에 없다.
function withTimeout(promise, ms, what) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_r, reject) => { t = setTimeout(() => reject(new Error(`${what} 시간 초과 (${ms / 1000}초)`)), ms); }),
  ]);
}

ipcMain.handle('host', async (_e, { nick, port, password }) => {
  // 직전 방이 닫히는 중이면 잠깐 기다리되, 끝나지 않아도 진행한다.
  if (stopping) await withTimeout(stopping, 5000, '이전 방 종료').catch(() => {});
  const res = await withTimeout(
    server.start({ port: Number(port) || 3000, host: '0.0.0.0', password: String(password || '') }),
    10000,
    '서버 시작',
  );
  hosting = { port: res.port, name: `${nick}의 방`, timer: setInterval(sendBeacon, BEACON_MS) };
  sendBeacon();
  // 방장도 같은 문을 통과한다 — 비밀번호를 건 방이면 본인 토큰을 발급받아 들어간다.
  const token = res.locked ? await fetchToken(`http://localhost:${res.port}`, password) : '';
  openChat(`http://localhost:${res.port}`, nick, token);
  return res;
});

// 비밀번호를 확인하고 입장 토큰을 받아 온다.
async function fetchToken(origin, password) {
  const r = await fetch(`${origin}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: String(password || '') }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `인증 실패 (${r.status})`);
  return d.token || '';
}

ipcMain.handle('join', async (_e, { nick, address, password }) => {
  let target = String(address || '').trim();
  if (!/^https?:\/\//.test(target)) target = `http://${target}`;
  const url = new URL(target);
  if (!url.port) url.port = '3000';
  // 서버가 살아있는지 확인
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 3000);
  let room;
  try {
    const r = await fetch(`${url.origin}/api/room`, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    room = await r.json();
  } catch (err) {
    throw new Error(`${url.host} 에 연결할 수 없습니다 (${err.name === 'AbortError' ? '시간 초과' : err.message})`);
  } finally {
    clearTimeout(t);
  }

  // 비밀번호는 창을 열기 전에 확인한다 — 틀렸으면 빈 창 대신 런처에서 바로 알려 준다.
  const token = room.locked ? await fetchToken(url.origin, password) : '';
  openChat(url.origin, nick, token);
  return { ok: true, locked: Boolean(room.locked) };
});

// 런처가 잠긴 방인지 미리 물어본다(비콘이 없거나 주소를 직접 넣은 경우).
ipcMain.handle('probe', async (_e, { address }) => {
  let target = String(address || '').trim();
  if (!/^https?:\/\//.test(target)) target = `http://${target}`;
  const url = new URL(target);
  if (!url.port) url.port = '3000';
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 3000);
  try {
    const r = await fetch(`${url.origin}/api/room`, { signal: ctrl.signal });
    return r.ok ? await r.json() : { locked: false, unreachable: true };
  } catch {
    return { locked: false, unreachable: true };
  } finally {
    clearTimeout(t);
  }
});

// 채팅 창 안에서 다른 방으로 이동한다. 창을 새로 만들지 않고 같은 창을 옮긴다.
// 페이지가 스스로 이동하는 건 will-navigate 가 막고 있으므로, 반드시 여기를 거친다.
ipcMain.handle('switch-room', async (_e, { ip, port, password, nick }) => {
  if (!chat || chat.isDestroyed()) throw new Error('채팅 창이 없습니다');
  const origin = `http://${ip}:${Number(port)}`;

  let room;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 3000);
  try {
    const r = await fetch(`${origin}/api/room`, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    room = await r.json();
  } catch (err) {
    throw new Error(`${ip}:${port} 에 연결할 수 없습니다 (${err.name === 'AbortError' ? '시간 초과' : err.message})`);
  } finally {
    clearTimeout(t);
  }

  const token = room.locked ? await fetchToken(origin, password) : '';
  const url = new URL(origin);
  if (nick) url.searchParams.set('nick', String(nick).slice(0, 20));
  if (token) url.searchParams.set('token', token);
  // 이동 후에도 창 밖으로 못 나가도록 허용 origin 을 새 방으로 바꾼다.
  chatOrigin = url.origin;
  await chat.loadURL(url.toString());
  return { ok: true, locked: Boolean(room.locked) };
});

ipcMain.handle('info', () => ({ addresses: server.lanAddresses(), platform: process.platform, version: app.getVersion() }));

app.whenReady().then(createLauncher);
app.on('window-all-closed', () => app.quit());

// 방을 열어 둔 채 끝내면 손님들이 끊김 통보 없이 남는다. 한 번만 가로채
// 서버를 닫고 다시 종료한다.
let quitting = false;
app.on('before-quit', (e) => {
  if (quitting || !hosting) return;
  e.preventDefault();
  quitting = true;
  stopHosting().finally(() => app.quit());
});
