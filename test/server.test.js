// 서버 계약과 보안 경계 회귀 테스트. 외부 의존성 없이 node:test 로만 돌린다.
//   node --test test/
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const server = require('../server');

let base;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const open = [];

before(async () => {
  const { port } = await server.start({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  for (const c of open) c.close();
  await server.stop();
});

// SSE 로 접속해 welcome 을 받고, 이후 도착하는 이벤트를 모아 두는 테스트용 클라이언트.
async function connect({ key, nick, kind = 'web' } = {}) {
  const q = new URLSearchParams({ nick: nick || 'tester' });
  if (key) q.set('key', key);
  if (kind === 'cli') q.set('client', 'cli');
  const res = await fetch(`${base}/events?${q}`);
  assert.equal(res.status, 200);

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const events = [];
  let welcome = null;
  let buf = '';

  (async () => {
    for (;;) {
      let chunk;
      try { chunk = await reader.read(); } catch { return; }
      if (chunk.done) return;
      buf += dec.decode(chunk.value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let name = 'message';
        let data = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) name = line.slice(7);
          else if (line.startsWith('data: ')) data += line.slice(6);
        }
        if (!data) continue;
        const parsed = JSON.parse(data);
        if (name === 'welcome') welcome = parsed;
        else events.push({ name, data: parsed });
      }
    }
  })();

  while (!welcome) await sleep(10);
  const client = {
    welcome,
    events,
    close: () => { reader.cancel().catch(() => {}); },
    post: (body) => fetch(`${base}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: welcome.id, channel: 'general', ...body }),
    }),
  };
  open.push(client);
  return client;
}

const texts = (c) => c.events.map((e) => String(e.data?.text ?? ''));

test('CLI 대화창은 같은 키를 가진 연결에만 전달된다', async () => {
  const KEY_A = 'a'.repeat(24);
  const KEY_B = 'b'.repeat(24);
  const mine = await connect({ key: KEY_A, nick: 'alice', kind: 'cli' });
  const myOtherDevice = await connect({ key: KEY_A, nick: 'alice-web' });
  const stranger = await connect({ key: KEY_B, nick: 'bob' });

  await mine.post({ type: 'cli', text: '내 비밀 질문' });
  await mine.post({ type: 'agent-log', text: 'Read(secret.txt)\n⎿  3줄' });
  await mine.post({ type: 'agent-text', text: '비밀 답변' });
  await sleep(200);

  const secret = (c) => texts(c).filter((t) => /비밀|secret\.txt/.test(t)).length;
  assert.equal(secret(mine), 3, '본인은 세 건 모두 받아야 한다');
  assert.equal(secret(myOtherDevice), 3, '같은 키의 다른 기기도 받아야 한다');
  assert.equal(secret(stranger), 0, '다른 키 사용자는 한 건도 받으면 안 된다');
});

test('접속 시 받는 초기 데이터에 남의 CLI 기록이 들어가지 않는다', async () => {
  const KEY_A = 'c'.repeat(24);
  const owner = await connect({ key: KEY_A, nick: 'carol', kind: 'cli' });
  await owner.post({ type: 'agent-text', text: '남이 보면 안 되는 답변' });
  await sleep(150);

  const stranger = await connect({ key: 'd'.repeat(24), nick: 'dave' });
  assert.deepEqual(stranger.welcome.cli, [], '남의 welcome.cli 는 비어 있어야 한다');
  assert.ok(!JSON.stringify(stranger.welcome).includes('남이 보면 안 되는'), 'welcome 어디에도 새면 안 된다');

  const again = await connect({ key: KEY_A, nick: 'carol-2' });
  assert.ok(
    again.welcome.cli.some((m) => m.text === '남이 보면 안 되는 답변'),
    '같은 키로 다시 붙으면 내 CLI 기록이 복원되어야 한다',
  );
});

test('에이전트 출력이 일반 대화창으로 새지 않는다', async () => {
  const owner = await connect({ key: 'e'.repeat(24), nick: 'erin', kind: 'cli' });
  const other = await connect({ key: 'f'.repeat(24), nick: 'frank' });

  await owner.post({ type: 'agent-text', text: '에이전트 답변' });
  await owner.post({ type: 'chat', text: '모두 보는 인사' });
  await sleep(200);

  const roomMessages = other.events.filter((e) => e.name === 'message');
  assert.ok(roomMessages.some((e) => e.data.text === '모두 보는 인사'), '일반 대화는 전달되어야 한다');
  assert.ok(!roomMessages.some((e) => e.data.text === '에이전트 답변'), '에이전트 출력은 전달되면 안 된다');
  assert.ok(!other.events.some((e) => e.name.startsWith('cli-')), '남의 cli-* 이벤트를 받으면 안 된다');
});

test('전송 제한이 agent-* 를 포함한 모든 종류에 적용된다', async () => {
  const c = await connect({ key: 'g'.repeat(24), nick: 'grace', kind: 'cli' });
  const codes = [];
  for (let i = 0; i < 20; i++) {
    const r = await c.post({ type: 'agent-text', text: 'x'.repeat(8000) });
    codes.push(r.status);
  }
  const passed = codes.filter((s) => s === 200).length;
  assert.ok(passed > 0, '정상 범위의 첫 요청은 통과해야 한다');
  assert.ok(passed < 20, 'agent-text 가 제한 없이 전부 통과하면 안 된다 (레이트리밋 우회)');
  assert.ok(codes.includes(429), '초과분은 429 로 거부되어야 한다');
});

test('연속된 짧은 도구 로그는 막히지 않는다', async () => {
  const c = await connect({ key: 'h'.repeat(24), nick: 'heidi', kind: 'cli' });
  const codes = [];
  for (let i = 0; i < 25; i++) {
    const r = await c.post({ type: 'agent-log', text: `Read(a${i}.js)\n⎿  12줄` });
    codes.push(r.status);
  }
  assert.ok(codes.every((s) => s === 200), '정상적인 에이전트 사용이 제한에 걸리면 안 된다');
});

test('정책에 없는 요청 종류는 거부된다', async () => {
  const c = await connect({ key: 'i'.repeat(24), nick: 'ivan' });
  for (const type of ['admin', 'agent-evil', 'broadcast']) {
    const r = await c.post({ type, text: 'x' });
    assert.equal(r.status, 400, `${type} 은 거부되어야 한다`);
  }
});

test('한글 최대 길이 메시지가 전송 계층에서 잘리지 않는다', async () => {
  const c = await connect({ key: 'j'.repeat(24), nick: 'judy', kind: 'cli' });
  // 8000자 한글 = UTF-8 24KB. 본문 상한이 이보다 작으면 소켓이 끊긴다.
  const r = await c.post({ type: 'agent-text', text: '가'.repeat(8000) });
  assert.equal(r.status, 200);
});

test('본문 상한을 넘으면 소켓을 끊지 않고 413 으로 응답한다', async () => {
  const c = await connect({ key: 'k'.repeat(24), nick: 'karl' });
  const r = await fetch(`${base}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: c.welcome.id, type: 'chat', text: 'x'.repeat(64 * 1024) }),
  });
  assert.equal(r.status, 413);
});

test('claude 는 예약 닉네임이라 사람이 쓸 수 없다', async () => {
  const c = await connect({ nick: 'claude', key: 'l'.repeat(24) });
  assert.notEqual(c.welcome.nick.toLowerCase(), 'claude', '접속 시 예약어는 대체되어야 한다');
  const r = await c.post({ type: 'nick', nick: 'Claude' });
  assert.equal(r.status, 400, '변경 요청도 거부되어야 한다');
});

test('알 수 없는 클라이언트 id 는 거부된다', async () => {
  const r = await fetch(`${base}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'nope', type: 'chat', text: 'hi' }),
  });
  assert.equal(r.status, 401);
});

test('정적 파일 경로가 public 밖으로 나가지 못한다', async () => {
  for (const p of ['/../server.js', '/..%2fserver.js', '/%2e%2e/server.js']) {
    const r = await fetch(base + p, { redirect: 'manual' });
    assert.ok(r.status === 403 || r.status === 404, `${p} 는 막혀야 한다 (받은 값: ${r.status})`);
    assert.ok(!(await r.text()).includes('createServer'), `${p} 로 소스가 노출되면 안 된다`);
  }
});

test('키 형식이 맞지 않으면 서버가 새로 발급한다', async () => {
  const c = await connect({ key: 'short', nick: 'liam' });
  assert.match(c.welcome.key, /^[A-Za-z0-9_-]{16,64}$/);
  assert.notEqual(c.welcome.key, 'short');
});
