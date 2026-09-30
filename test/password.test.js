// 방 비밀번호 회귀 테스트.
// 대화 내용은 전부 /events 스트림으로만 나가므로, 그 한 곳이 막히면 방 안의 어떤 것도
// 인증 없이 새지 않는다. 그 전제가 실제로 성립하는지 검사한다.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const server = require('../server');

const PASSWORD = '올바른-비밀번호-1234';
let base;

before(async () => {
  const { port, locked } = await server.start({ port: 0, host: '127.0.0.1', password: PASSWORD });
  base = `http://127.0.0.1:${port}`;
  assert.equal(locked, true, '비밀번호를 주면 잠긴 방으로 시작해야 한다');
});

after(() => server.stop());

const auth = (password) =>
  fetch(`${base}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });

// SSE 응답의 첫 바이트까지만 확인한다. 200이면 스트림이 열린 것.
async function tryStream(token) {
  const q = new URLSearchParams({ nick: 'tester' });
  if (token) q.set('token', token);
  const res = await fetch(`${base}/events?${q}`);
  const status = res.status;
  if (status === 200) {
    const reader = res.body.getReader();
    const first = await reader.read();
    reader.cancel().catch(() => {});
    return { status, body: new TextDecoder().decode(first.value || new Uint8Array()) };
  }
  return { status, body: await res.text() };
}

test('방 상태는 인증 없이도 읽을 수 있다 (로그인 화면을 그려야 하므로)', async () => {
  const r = await fetch(`${base}/api/room`);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.locked, true);
  assert.equal(d.authed, false, '토큰이 없으면 authed 가 false 여야 한다');
});

test('토큰 없이는 이벤트 스트림에 붙을 수 없다', async () => {
  const r = await tryStream(null);
  assert.equal(r.status, 401, '잠긴 방은 토큰 없는 접속을 거부해야 한다');
  assert.ok(!r.body.includes('welcome'), '거부 응답에 방 내용이 섞이면 안 된다');
});

test('아무 토큰이나 지어내도 통하지 않는다', async () => {
  for (const fake of ['x', 'a'.repeat(32), '', 'null', 'undefined']) {
    const r = await tryStream(fake);
    assert.equal(r.status, 401, `지어낸 토큰 '${fake.slice(0, 8)}' 이 통과하면 안 된다`);
  }
});

test('틀린 비밀번호는 토큰을 받지 못한다', async () => {
  const r = await auth('틀린비번');
  assert.equal(r.status, 401);
  const d = await r.json();
  assert.equal(d.token, undefined, '실패 응답에 토큰이 들어가면 안 된다');
});

test('맞는 비밀번호로 받은 토큰이면 접속된다', async () => {
  const r = await auth(PASSWORD);
  assert.equal(r.status, 200);
  const { token } = await r.json();
  assert.match(token, /^[A-Za-z0-9_-]{20,}$/);

  const s = await tryStream(token);
  assert.equal(s.status, 200);

  const info = await (await fetch(`${base}/api/room?token=${encodeURIComponent(token)}`)).json();
  assert.equal(info.authed, true);
});

test('비밀번호 시도가 잦으면 잠시 막는다 (무차별 대입 방어)', async () => {
  const codes = [];
  for (let i = 0; i < 12; i++) codes.push((await auth(`틀린${i}`)).status);
  assert.ok(codes.includes(429), `연속 시도가 전부 처리되면 안 된다: ${codes.join(',')}`);
  // 제한에 걸린 뒤에는 올바른 비밀번호도 일단 막힌다 — 의도된 동작.
  assert.ok(codes.filter((c) => c === 401).length >= 1, '초기 시도는 401 로 응답해야 한다');
});

test('정적 파일(앱 껍데기)은 잠긴 방에서도 받을 수 있다', async () => {
  // 로그인 화면 자체를 못 받으면 비밀번호를 입력할 방법이 없다.
  for (const p of ['/', '/app.js', '/style.css']) {
    const r = await fetch(base + p);
    assert.equal(r.status, 200, `${p} 는 인증 전에도 받을 수 있어야 한다`);
    const body = await r.text();
    assert.ok(!body.includes('"nick"'), `${p} 에 방 내용이 들어가면 안 된다`);
  }
});

test('비밀번호를 지우면 누구나 들어올 수 있다', async () => {
  server.setPassword('');
  assert.equal(server.isLocked(), false);
  const r = await tryStream(null);
  assert.equal(r.status, 200, '비밀번호 없는 방은 토큰 없이 접속된다');
});

test('비밀번호를 새로 걸면 기존 토큰이 무효가 된다', async () => {
  server.setPassword('첫번째-비밀번호');
  const t1 = (await (await auth('첫번째-비밀번호')).json()).token;
  assert.equal((await tryStream(t1)).status, 200);

  server.setPassword('두번째-비밀번호');
  assert.equal((await tryStream(t1)).status, 401, '비밀번호가 바뀌면 옛 토큰은 죽어야 한다');
  assert.equal((await auth('첫번째-비밀번호')).status, 401, '옛 비밀번호도 더는 통하면 안 된다');

  const t2 = (await (await auth('두번째-비밀번호')).json()).token;
  assert.equal((await tryStream(t2)).status, 200);
});
