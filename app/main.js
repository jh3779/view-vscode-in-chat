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
  const msg = Buffer.from(JSON.stringify({ app: 'lan-agent-chat', v: 1, name: hosting.name, port: hosting.port, users: server.stats().users }));
  for (const t of broadcastTargets()) beaconSocket.send(msg, DISCOVERY_PORT, t, () => {});
}

const listenSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
listenSocket.on('error', (err) => console.error('discovery:', err.message));
listenSocket.on('message', (buf, rinfo) => {
  try {
    const b = JSON.parse(buf.toString('utf8'));
    if (b.app !== 'lan-agent-chat' || !Number.isInteger(b.port)) return;
    const key = `${rinfo.address}:${b.port}`;
    rooms.set(key, { ip: rinfo.address, port: b.port, name: String(b.name || '').slice(0, 40), users: Number(b.users) || 0, seen: Date.now() });
  } catch {}
});
listenSocket.bind(DISCOVERY_PORT);

setInterval(() => {
  const now = Date.now();
  for (const [k, r] of rooms) if (now - r.seen > ROOM_TTL_MS) rooms.delete(k);
  if (launcher && !launcher.isDestroyed()) launcher.webContents.send('rooms', [...rooms.values()]);
}, 1000);

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

function openChat(baseUrl, nick) {
  const url = new URL(baseUrl);
  url.searchParams.set('nick', nick);
  chat = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 480,
    minHeight: 360,
    backgroundColor: '#1e1e1e',
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 12, y: 9 },
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  // 외부 링크는 기본 브라우저로, 채팅 서버 밖으로의 이동은 차단
  chat.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });
  chat.webContents.on('will-navigate', (e, target) => {
    if (new URL(target).origin !== url.origin) e.preventDefault();
  });
  chat.loadURL(url.toString());
  chat.on('closed', () => {
    chat = null;
    // 런처를 먼저, 동기적으로 띄운다. 창이 0개가 되는 순간 window-all-closed 가
    // app.quit() 을 실행하는데, stopHosting() 의 await 가 그 전에 이벤트 루프를
    // 내주기 때문이다(방장은 소켓 종료를 기다리므로 항상 앱이 먼저 죽었다).
    createLauncher();
    stopHosting();
  });
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
ipcMain.handle('host', async (_e, { nick, port }) => {
  if (stopping) await stopping; // 직전 방이 닫히는 중이면 기다린다
  const res = await server.start({ port: Number(port) || 3000, host: '0.0.0.0' });
  hosting = { port: res.port, name: `${nick}의 방`, timer: setInterval(sendBeacon, BEACON_MS) };
  sendBeacon();
  openChat(`http://localhost:${res.port}`, nick);
  return res;
});

ipcMain.handle('join', async (_e, { nick, address }) => {
  let target = String(address || '').trim();
  if (!/^https?:\/\//.test(target)) target = `http://${target}`;
  const url = new URL(target);
  if (!url.port) url.port = '3000';
  // 서버가 살아있는지 확인
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 3000);
  try {
    const r = await fetch(url.origin, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch (err) {
    throw new Error(`${url.host} 에 연결할 수 없습니다 (${err.name === 'AbortError' ? '시간 초과' : err.message})`);
  } finally {
    clearTimeout(t);
  }
  openChat(url.origin, nick);
  return { ok: true };
});

ipcMain.handle('info', () => ({ addresses: server.lanAddresses(), platform: process.platform, version: app.getVersion() }));

app.whenReady().then(createLauncher);
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { if (hosting) server.stop(); });
