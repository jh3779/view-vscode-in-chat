// 웹 클라이언트(public/app.js)를 브라우저 없이 초기화해 보는 회귀 테스트.
//
// 배경: v0.3.0 은 http://<LAN-IP> 로 접속하면 화면이 아무것도 뜨지 않았다.
// crypto.randomUUID() 가 보안 컨텍스트 전용이라 LAN 주소에는 없는데,
// 초기화 도중 무조건 호출해서 전체가 TypeError 로 중단됐기 때문이다.
// localhost 는 보안 컨텍스트라 개발 중에는 드러나지 않았다.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

// public/index.html 이 실제로 쓰는 만큼만 흉내 낸 최소 DOM.
function makeDom() {
  const made = [];
  const node = (tag = 'div') => {
    const n = {
      tag,
      children: [],
      style: {},
      dataset: {},
      hidden: false,
      value: '',
      textContent: '',
      placeholder: '',
      className: '',
      scrollHeight: 0,
      scrollTop: 0,
      clientHeight: 0,
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      append(...kids) { this.children.push(...kids); },
      replaceChildren(...kids) { this.children = kids; },
      appendChild(k) { this.children.push(k); },
      setAttribute() {},
      addEventListener() {},
      removeEventListener() {},
      focus() {},
      onclick: null,
    };
    made.push(n);
    return n;
  };
  const byId = new Map();
  return {
    made,
    document: {
      hidden: false,
      title: '',
      body: node('body'),
      getElementById(id) {
        if (!byId.has(id)) byId.set(id, node());
        return byId.get(id);
      },
      createElement: (t) => node(t),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
    },
  };
}

// crypto 를 주어진 모양대로 갈아끼우고 app.js 를 초기화한다.
function boot({ crypto, stored = {} }) {
  const { document } = makeDom();
  const store = { ...stored };
  const opened = [];
  const sandbox = {
    document,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    },
    location: { search: '', host: '192.168.0.9:3000' },
    navigator: { userAgent: 'Mozilla/5.0', platform: 'MacIntel' },
    matchMedia: () => ({ matches: false }),
    EventSource: function EventSourceStub(url) { opened.push(url); this.addEventListener = () => {}; this.close = () => {}; },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    getSelection: () => '',
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    crypto,
  };
  const names = Object.keys(sandbox);
  // eslint-disable-next-line no-new-func
  new Function(...names, SOURCE)(...names.map((n) => sandbox[n]));
  return { store, opened };
}

// 보안 컨텍스트가 아닌 브라우저: randomUUID 가 없고 getRandomValues 만 있다.
const insecureCrypto = { getRandomValues: (a) => a };
const secureCrypto = { randomUUID: () => '11111111-2222-3333-4444-555555555555', getRandomValues: (a) => a };

test('보안 컨텍스트가 아닌 주소(LAN IP)에서도 초기화가 끝까지 진행된다', () => {
  assert.doesNotThrow(
    () => boot({ crypto: insecureCrypto, stored: { 'vschat.nick': 'tester' } }),
    'crypto.randomUUID 가 없어도 앱이 살아 있어야 한다',
  );
});

test('보안 컨텍스트 여부와 관계없이 같은 경로로 접속한다', () => {
  const a = boot({ crypto: insecureCrypto, stored: { 'vschat.nick': 'tester' } });
  const b = boot({ crypto: secureCrypto, stored: { 'vschat.nick': 'tester' } });
  assert.equal(a.opened.length, 1, 'LAN 주소에서도 연결을 시도해야 한다');
  assert.deepEqual(a.opened, b.opened, '두 환경의 연결 URL 이 같아야 한다');
});

test('브라우저가 키를 스스로 만들지 않는다 (서버 발급분만 저장)', () => {
  const { store, opened } = boot({ crypto: secureCrypto, stored: { 'vschat.nick': 'tester' } });
  assert.equal(store['vschat.key'], undefined, '저장된 키가 없으면 새로 만들지 말아야 한다');
  assert.match(opened[0], /[?&]key=(&|$)/, '키가 없으면 빈 값으로 보내고 서버 발급을 받아야 한다');
});

test('저장된 키가 있으면 그대로 사용한다', () => {
  const key = 'k'.repeat(32);
  const { opened } = boot({ crypto: insecureCrypto, stored: { 'vschat.nick': 'tester', 'vschat.key': key } });
  assert.ok(opened[0].includes(`key=${key}`), '저장된 키로 접속해야 한다');
});

test('형식이 깨진 키는 버리고 서버에 재발급을 맡긴다', () => {
  const { opened } = boot({ crypto: insecureCrypto, stored: { 'vschat.nick': 'tester', 'vschat.key': 'short' } });
  assert.match(opened[0], /[?&]key=(&|$)/);
});

test('public/app.js 는 보안 컨텍스트 전용 API 를 호출하지 않는다', () => {
  const calls = SOURCE.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const api of ['crypto.randomUUID', 'crypto.subtle', 'navigator.clipboard', 'navigator.mediaDevices']) {
    assert.ok(!calls.includes(api), `${api} 는 http://<LAN-IP> 에서 없으므로 쓰면 안 된다`);
  }
});
