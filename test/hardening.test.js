// 비정상 입력 내성과 발신자 무결성 회귀 테스트 (이슈 #3, #4).
//
// #3: 깨진 URL 인코딩(`GET /%`)과 prototype 이름 요청 종류(`toString`)가
//     서버 프로세스를 끝냈다. 누구나 인증 없이 방 전체를 끊을 수 있었다.
// #4: 참가자 목록으로 공개되는 clientId 를 그대로 쓰기 자격으로 받아서,
//     남의 ID 만 알면 닉네임 변경·가짜 AI 답변 삽입이 가능했다.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const server = require('../server');

let base;
let port;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const live = [];

before(async () => {
  const r = await server.start({ port: 0, host: '127.0.0.1' });
  port = r.port;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  for (const c of live) c.close();
  await server.stop();
});

// 깨진 경로는 fetch 가 보내기 전에 거부하므로 원시 소켓으로 보낸다.
function rawGet(pathname) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => {
      s.write(`GET ${pathname} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
    });
    let data = '';
    s.on('data', (c) => { data += c; });
    s.on('close', () => resolve(data.split('\r\n')[0] || ''));
    s.on('error', () => resolve('SOCKET_ERROR'));
    setTimeout(() => { s.destroy(); resolve('NO_RESPONSE'); }, 3000);
  });
}

async function connect(nick = 'tester', key) {
  const q = new URLSearchParams({ nick });
  if (key) q.set('key', key);
  const res = await fetch(`${base}/events?${q}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let welcome = null;
  (async () => {
    for (;;) {
      let chunk;
      try { chunk = await reader.read(); } catch { return; }
      if (chunk.done) return;
      buf += dec.decode(chunk.value, { stream: true });
      const m = buf.match(/data: (.*)/);
      if (m && !welcome) welcome = JSON.parse(m[1]);
    }
  })();
  while (!welcome) await sleep(10);
  const c = { welcome, close: () => reader.cancel().catch(() => {}) };
  live.push(c);
  return c;
}

const send = (body) =>
  fetch(`${base}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: 'general', ...body }),
  });

// 서버가 아직 살아 있는지 — 이 테스트들의 핵심 단언.
async function serverAlive() {
  try {
    return (await fetch(`${base}/api/room`)).status === 200;
  } catch {
    return false;
  }
}

test('[#3] 깨진 URL 인코딩에 400 을 주고 서버는 살아 있다', async () => {
  for (const p of ['/%', '/%E0%A4%A', '/%zz', '/a%']) {
    const line = await rawGet(p);
    assert.match(line, /^HTTP\/1\.1 4\d\d/, `${p} 는 4xx 로 거부해야 한다 (받은 값: ${line})`);
    assert.ok(await serverAlive(), `${p} 이후 서버가 죽었다`);
  }
});

test('[#3] 정상 경로는 그대로 동작한다', async () => {
  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.equal((await fetch(`${base}/없는파일`)).status, 404);
  assert.ok(await serverAlive());
});

test('[#3] prototype 이름을 요청 종류로 써도 거부하고 서버는 살아 있다', async () => {
  const c = await connect('proto');
  for (const type of ['toString', '__proto__', 'constructor', 'valueOf', 'hasOwnProperty', 'isPrototypeOf']) {
    const r = await send({ secret: c.welcome.secret, type });
    assert.equal(r.status, 400, `${type} 은 400 으로 거부해야 한다`);
    assert.ok(await serverAlive(), `${type} 이후 서버가 죽었다`);
  }
});

test('[#4] 참가자 목록에 쓰기 자격이 들어가지 않는다', async () => {
  const a = await connect('alice');
  const b = await connect('bob');
  await sleep(150);

  const listed = b.welcome.users.find((u) => u.nick === 'alice');
  assert.ok(listed, 'alice 가 목록에 있어야 한다');
  assert.ok(listed.id, '표시용 id 는 공개된다');
  assert.equal(listed.secret, undefined, '쓰기 자격(secret)이 목록에 실리면 안 된다');
  assert.ok(
    !JSON.stringify(b.welcome.users).includes(a.welcome.secret),
    '남의 secret 이 어떤 형태로든 목록에 나타나면 안 된다',
  );
});

test('[#4] 남의 공개 id 로는 아무것도 할 수 없다', async () => {
  const a = await connect('carol');
  const b = await connect('dave');
  await sleep(150);
  const aPublicId = b.welcome.users.find((u) => u.nick === 'carol').id;

  // 이슈에 보고된 두 가지 경로를 그대로 시도한다.
  for (const body of [
    { id: aPublicId, type: 'nick', nick: 'qa-forged-name' },
    { id: aPublicId, type: 'agent-text', text: 'QA_FORGED_NOT_REAL_AI' },
    { id: aPublicId, type: 'chat', text: '위조된 발언' },
    { id: aPublicId, type: 'cli', text: '위조된 개인 입력' },
  ]) {
    const r = await send(body);
    assert.equal(r.status, 401, `${body.type} 이 공개 id 만으로 통과하면 안 된다`);
  }

  // 닉네임이 실제로 바뀌지 않았는지 제3자 시점에서 확인한다.
  const c = await connect('eve');
  await sleep(100);
  assert.ok(
    c.welcome.users.some((u) => u.nick === 'carol'),
    'carol 의 닉네임이 그대로여야 한다',
  );
  assert.ok(
    !c.welcome.users.some((u) => u.nick === 'qa-forged-name'),
    '위조된 닉네임이 적용되면 안 된다',
  );
});

test('[#4] 지어낸 자격은 통하지 않는다', async () => {
  for (const secret of ['', 'x', 'a'.repeat(32), 'null', 'undefined', '__proto__']) {
    const r = await send({ secret, type: 'chat', text: 'hi' });
    assert.equal(r.status, 401, `'${secret.slice(0, 10)}' 이 통과하면 안 된다`);
  }
});

test('[#4] 본인 자격으로는 정상 동작한다', async () => {
  const c = await connect('frank');
  assert.match(c.welcome.secret, /^[A-Za-z0-9_-]{20,}$/, 'welcome 에 본인 자격이 와야 한다');

  assert.equal((await send({ secret: c.welcome.secret, type: 'chat', text: '안녕' })).status, 200);
  assert.equal((await send({ secret: c.welcome.secret, type: 'nick', nick: 'frank2' })).status, 200);

  const other = await connect('grace');
  await sleep(100);
  assert.ok(other.welcome.users.some((u) => u.nick === 'frank2'), '본인 닉네임 변경은 반영돼야 한다');
});

test('[#4] 연결이 끊기면 그 자격도 쓸 수 없다', async () => {
  const c = await connect('heidi');
  const { secret } = c.welcome;
  assert.equal((await send({ secret, type: 'chat', text: '살아있을 때' })).status, 200);

  c.close();
  await sleep(300);
  assert.equal(
    (await send({ secret, type: 'chat', text: '끊긴 뒤' })).status,
    401,
    '끊긴 연결의 자격은 더는 통하면 안 된다',
  );
});
