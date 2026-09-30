(() => {
  const $ = (id) => document.getElementById(id);
  const log = $('log');
  const input = $('input');
  const form = $('form');
  const pw = $('pw');

  const COMMANDS = [
    ['/help', '명령어 목록 보기'],
    ['/nick', '<이름>  닉네임 변경'],
    ['/join', '<채널>  채널 열기/생성'],
    ['/leave', '현재 탭 닫기'],
    ['/who', '접속자 목록'],
    ['/me', '<행동>  행동 메시지'],
    ['/clear', '화면 지우기 (내 화면만)'],
    ['/cli', '내 에이전트 창 보기 (나만 보임)'],
    ['/key', '[값]  CLI 창 연결 키 보기/바꾸기'],
    ['/agent', '에이전트 사용법 (터미널 클라이언트에서 실행)'],
  ];

  const params = new URLSearchParams(location.search);
  if (params.get('nick')) safeSet('vschat.nick', params.get('nick').replace(/\s+/g, '').slice(0, 20));
  const IN_APP = /Electron/.test(navigator.userAgent);
  if (IN_APP) document.body.classList.add('in-app', /Mac/.test(navigator.platform) ? 'mac' : 'other');

  const state = {
    me: null,
    nick: safeGet('vschat.nick'),
    channels: [],
    history: {},
    users: [],
    tabs: JSON.parse(safeGet('vschat.tabs') || '["general"]'),
    active: safeGet('vschat.active') || 'general',
    unread: {},
    addresses: [],
    es: null,
    inputHistory: [],
    histIdx: -1,
    suggestIdx: 0,
    typing: new Map(), // userId -> { nick, color, channel, ts }
    lastTypingSent: 0,
    key: '',
    token: '',
    locked: false,
    cli: [], // 내 CLI 대화창 — 서버가 같은 키를 가진 내 연결에만 보낸다
    cliTyping: null,
  };

  // CLI 대화창 소유권 키. 브라우저에서 만들지 않고 서버가 발급한 값을 저장만 한다.
  // crypto.randomUUID() 는 보안 컨텍스트 전용이라 http://<LAN-IP> 에는 없고,
  // 여기서 호출하면 앱 초기화 전체가 TypeError 로 중단된다(LAN 접속이 통째로 막힘).
  const CLI_TAB = 'claude.cli';
  const KEY_RE = /^[A-Za-z0-9_-]{16,64}$/;
  state.key = safeGet('vschat.key') || '';
  if (!KEY_RE.test(state.key)) state.key = '';
  // 방 입장 토큰. 비밀번호가 걸린 방에서만 쓰이며 기기에 남는다.
  state.token = safeGet('vschat.token') || '';
  const urlToken = params.get('token');
  if (urlToken) { state.token = urlToken; safeSet('vschat.token', urlToken); }
  const isCli = () => state.active === CLI_TAB;

  function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
  function safeSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

  // ---------- rendering helpers ----------
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const time = (ts) => new Date(ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
  const atBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  const scrollDown = () => { log.scrollTop = log.scrollHeight; };

  // inline: `code`, @mention, URL — built as DOM nodes (no innerHTML)
  function renderInline(parent, text) {
    const re = /(`[^`\n]+`)|(@[^\s@]+)|(https?:\/\/[^\s]+)|(\*\*[^*\n]+\*\*)/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.append(text.slice(last, m.index));
      if (m[1]) parent.append(el('code', null, m[1].slice(1, -1)));
      else if (m[2]) parent.append(el('span', /^@claude$/i.test(m[2]) ? 'mention agent' : 'mention', m[2]));
      else if (m[4]) parent.append(el('b', null, m[4].slice(2, -2)));
      else {
        const a = el('a', null, m[3]);
        a.href = m[3]; a.target = '_blank'; a.rel = 'noopener noreferrer';
        parent.append(a);
      }
      last = re.lastIndex;
    }
    if (last < text.length) parent.append(text.slice(last));
  }

  function renderBody(text) {
    const body = el('div', 'body');
    text.split(/```/).forEach((part, i) => {
      if (i % 2 === 1) body.append(el('pre', null, part.replace(/^[\w-]*\n/, '').replace(/\n$/, '')));
      else renderInline(body, part);
    });
    return body;
  }

  function msgNode(m) {
    const mine = state.me && m.userId === state.me.id;
    const own = mine || m.type === 'cli';
    const kind = m.type === 'chat' || m.type === 'cli' ? (own ? 'mine' : '') : m.type === 'agent' ? 'chat' : m.type;
    const row = el('div', `msg ${kind}${m.agent || m.type === 'agent' || m.type === 'agent-log' ? ' agent' : ''}`);
    const bullet = m.type === 'system' || m.type === 'agent-log' ? '⏺' : m.type === 'local' ? '⎿' : m.type === 'error' ? '✗' : own ? '>' : '⏺';
    row.append(el('span', 'bullet', bullet));
    const col = el('div');
    if (m.type === 'agent-log') {
      const [call, ...rest] = m.text.split('\n');
      const paren = call.indexOf('(');
      const head = el('div', 'tool');
      head.append(el('b', null, paren > 0 ? call.slice(0, paren) : call), paren > 0 ? call.slice(paren) : '');
      col.append(head, el('div', 'tool-out', rest.join('\n')));
      row.append(col);
      return row;
    }
    if (m.type === 'cli') {
      col.append(renderBody(m.text));
      row.append(col);
      return row;
    }
    if (m.type === 'chat' || m.type === 'action' || m.type === 'agent') {
      const head = el('div', 'head');
      const nick = el('span', 'nick', m.nick);
      nick.style.color = m.color;
      head.append(nick);
      if (m.agent || m.type === 'agent') head.append(el('span', 'tag', 'agent'));
      head.append(el('span', 'time', time(m.ts)));
      if (m.type === 'action') col.append(renderBody(`* ${m.nick} ${m.text}`));
      else { col.append(head); col.append(renderBody(m.text)); }
    } else if (m.type === 'system' && m.text.includes('\n')) {
      const [call, ...rest] = m.text.split('\n');
      const paren = call.indexOf('(');
      const head = el('div', 'tool');
      head.append(el('b', null, paren > 0 ? call.slice(0, paren) : call), paren > 0 ? call.slice(paren) : '');
      col.append(head, el('div', 'tool-out', rest.join('\n')));
    } else if (m.node) {
      col.append(m.node);
    } else {
      col.append(renderBody(m.text));
    }
    row.append(col);
    return row;
  }

  function cliBanner() {
    const wrap = el('div');
    const box = el('div', 'welcome');
    const t = el('div', 't');
    t.append(el('span', 'star', '✻ '), 'Welcome to ', el('b', null, 'claude.cli'), '!');
    box.append(t, el('div', 'gap'));
    box.append(el('div', 'd', '  이 창은 나만 볼 수 있습니다 — 방의 다른 사람은 내용도 존재도 보지 못합니다.'));
    box.append(el('div', 'gap'));
    box.append(el('div', 'd', '  터미널을 이 창과 연결하려면 아래를 그대로 실행하세요.'));
    box.append(el('div', 'gap'));
    const cmd = el('div', 'd cmd', `  node cli.js ${location.host} --key ${state.key || '(연결 후 표시됩니다)'}`);
    box.append(cmd);
    box.append(el('div', 'gap'));
    box.append(el('div', 'd', '  연결 후 터미널에서 /cli 로 들어가 질문하면 여기에도 함께 보입니다.'));
    box.append(el('div', 'd', '  반대로 터미널 키를 쓰려면  /key <터미널에 표시된 키>'));
    wrap.append(box);
    return wrap;
  }

  function banner(ch) {
    const box = el('div', 'welcome');
    const t = el('div', 't');
    t.append(el('span', 'star', '✻ '), 'Welcome to ', el('b', null, `#${ch}`), '!');
    box.append(t, el('div', 'gap'));
    box.append(el('div', 'd', '  /help 로 명령어 보기, /who 로 접속자 확인'));
    box.append(el('div', 'gap'));
    const host = state.addresses[0] ? state.addresses[0].replace('http://', '') : location.host;
    box.append(el('div', 'd', `  room: #${ch}`));
    box.append(el('div', 'd', `  host: ${host}`));
    const wrap = el('div');
    wrap.append(box);
    const tips = el('div', 'tips');
    tips.append(el('div', null, ' Tips for getting started:'), el('div', null, ''));
    [
      '1. 다른 기기에서 위 host 주소로 접속하면 함께 대화할 수 있습니다',
      '2. @닉네임 으로 멘션하고, ``` 로 코드 블록을 보낼 수 있습니다',
      '3. claude.cli 탭을 열면 내 에이전트 창을 볼 수 있습니다 (나만 보임)',
    ].forEach((x) => tips.append(el('div', null, ` ${x}`)));
    wrap.append(tips);
    return wrap;
  }

  function local(text, type = 'local', node) {
    const stick = atBottom();
    log.append(msgNode({ type, text, node }));
    if (stick || type !== 'system') scrollDown();
  }

  // ---------- UI state ----------
  function renderChannelView() {
    if (isCli()) {
      log.replaceChildren(cliBanner());
      for (const m of state.cli) log.append(msgNode(m));
      return scrollDown();
    }
    log.replaceChildren(banner(state.active));
    for (const m of state.history[state.active] || []) log.append(msgNode(m));
    scrollDown();
  }

  function renderTabs() {
    const tabs = $('tabs');
    tabs.replaceChildren();
    for (const ch of state.tabs) {
      const cli = ch === CLI_TAB;
      const t = el('div', 'tab' + (ch === state.active ? ' active' : '') + (cli ? ' cli' : ''));
      t.append(el('span', 'ico', cli ? '✻' : '#'), el('span', null, cli ? ch : `${ch}.chat`));
      const close = el('span', state.unread[ch] ? 'close' : 'close', '×');
      if (state.unread[ch] && ch !== state.active) { close.textContent = ''; close.append(el('span', 'mod')); close.style.visibility = 'visible'; }
      close.onclick = (e) => { e.stopPropagation(); closeTab(ch); };
      t.append(close);
      t.onclick = () => openChannel(ch);
      tabs.append(t);
    }
  }

  function renderChannels() {
    const ul = $('channelList');
    ul.replaceChildren();
    for (const ch of state.channels) {
      const li = el('li', ch === state.active ? 'active' : '');
      li.append(el('span', 'ico', '#'), el('span', null, `${ch}.chat`));
      if (state.unread[ch] && ch !== state.active) li.append(el('span', 'unread', String(state.unread[ch])));
      li.onclick = () => openChannel(ch);
      ul.append(li);
    }
    const mine = el('li', (isCli() ? 'active ' : '') + 'agent');
    mine.append(el('span', 'ico star', '✻'), el('span', null, CLI_TAB), el('span', 'state', '나만 보임'));
    mine.onclick = () => openChannel(CLI_TAB);
    ul.append(mine);
  }

  function renderUsers() {
    const ul = $('userList');
    ul.replaceChildren();
    for (const u of state.users) {
      const li = el('li', state.me && u.id === state.me.id ? 'me' : '');
      const dot = el('span', 'dot');
      dot.style.background = u.color;
      li.append(dot, el('span', null, u.nick));
      if (u.kind === 'cli') li.append(el('span', 'state', '>_ cli'));
      li.onclick = () => { input.value += `@${u.nick} `; input.focus(); };
      ul.append(li);
    }
    $('userCount').textContent = state.users.length;
    renderSuggest();
    $('sbUsers').textContent = `${state.users.length} online`;
  }

  function renderChrome() {
    const label = isCli() ? CLI_TAB : `${state.active}.chat`;
    $('title').textContent = `${label} — ${location.host}`;
    document.title = isCli() ? CLI_TAB : `#${state.active}`;
    $('breadcrumbs').textContent = isCli() ? `chat › ${CLI_TAB}  (나만 보임)` : `chat › ${label}`;
    $('sbChannel').textContent = isCli() ? CLI_TAB : `#${state.active}`;
    $('sbNick').textContent = state.me ? `👤 ${state.me.nick}` : '';
    renderTabs();
    renderChannels();
    renderTyping();
    renderSuggest();
    safeSet('vschat.tabs', JSON.stringify(state.tabs));
    safeSet('vschat.active', state.active);
  }

  function openChannel(ch) {
    if (!state.tabs.includes(ch)) state.tabs.push(ch);
    state.active = ch;
    state.unread[ch] = 0;
    renderChrome();
    renderChannelView();
    input.focus();
  }

  function closeTab(ch) {
    if (state.tabs.length === 1) return local('마지막 탭은 닫을 수 없습니다.', 'error');
    const i = state.tabs.indexOf(ch);
    state.tabs.splice(i, 1);
    if (state.active === ch) openChannel(state.tabs[Math.max(0, i - 1)]);
    else renderChrome();
  }

  // ---------- network ----------
  function connect() {
    if (state.es) state.es.close();
    setConn(false, '연결 중…');
    const es = new EventSource(`/events?key=${encodeURIComponent(state.key)}&token=${encodeURIComponent(state.token)}&nick=${encodeURIComponent(state.nick)}`);
    state.es = es;

    es.addEventListener('welcome', (e) => {
      const d = JSON.parse(e.data);
      state.me = { id: d.id, nick: d.nick, color: d.color };
      state.channels = d.channels;
      state.history = d.history;
      state.users = d.users;
      state.addresses = d.addresses;
      state.cli = d.cli || [];
      if (d.key && d.key !== state.key) { state.key = d.key; safeSet('vschat.key', d.key); }
      state.tabs = state.tabs.filter((t) => state.channels.includes(t) || t === CLI_TAB);
      if (!state.tabs.length) state.tabs = ['general'];
      if (!state.tabs.includes(state.active)) state.active = state.tabs[0];
      $('sbAddr').textContent = d.addresses[0] ? `⇄ ${d.addresses[0].replace('http://', '')}` : '';
      setConn(true);
      renderChrome();
      renderUsers();
      renderChannelView();
    });
    es.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      (state.history[m.channel] ||= []).push(m);
      if (state.history[m.channel].length > 200) state.history[m.channel].shift();
      if (m.userId && state.typing.delete(m.userId)) renderTyping();
      if (m.channel === state.active) {
        const stick = atBottom() || (state.me && m.userId === state.me.id);
        log.append(msgNode(m));
        if (stick) scrollDown();
      } else if (m.type !== 'system') {
        state.unread[m.channel] = (state.unread[m.channel] || 0) + 1;
        if (!state.tabs.includes(m.channel) && m.channel !== 'general') { /* 목록에서만 표시 */ }
        renderChrome();
      }
      if (document.hidden && m.type === 'chat' && m.userId !== state.me?.id) {
        document.title = `(●) #${state.active}`;
      }
    });
    es.addEventListener('cli-message', (e) => {
      const m = JSON.parse(e.data);
      state.cli.push(m);
      if (state.cli.length > 200) state.cli.shift();
      if (isCli()) {
        const stick = atBottom() || m.type === 'cli';
        log.append(msgNode(m));
        if (stick) scrollDown();
      } else if (m.type === 'agent') {
        state.unread[CLI_TAB] = (state.unread[CLI_TAB] || 0) + 1;
        renderChrome();
      }
    });
    es.addEventListener('cli-typing', (e) => {
      const t = JSON.parse(e.data);
      state.cliTyping = { ...t, ts: Date.now(), start: t.since || Date.now() };
      renderTyping();
    });
    es.addEventListener('cli-typing-end', () => { state.cliTyping = null; renderTyping(); });
    es.addEventListener('typing', (e) => {
      const t = JSON.parse(e.data);
      if (t.userId === state.me?.id) return;
      const prev = state.typing.get(t.userId);
      state.typing.set(t.userId, { ...t, ts: Date.now(), start: t.since || prev?.start || Date.now() });
      renderTyping();
    });
    es.addEventListener('typing-end', (e) => {
      if (state.typing.delete(JSON.parse(e.data).userId)) renderTyping();
    });
    es.addEventListener('users', (e) => { state.users = JSON.parse(e.data); renderUsers(); });
    es.addEventListener('channels', (e) => { state.channels = JSON.parse(e.data); renderChannels(); });
    es.onerror = async () => {
      es.close();
      // EventSource 는 상태코드를 알려주지 않으므로 방 상태를 따로 물어
      // '네트워크 문제'와 '토큰 거부'를 구분한다.
      const room = await roomInfo();
      if (room && room.locked && !room.authed) {
        state.token = '';
        safeSet('vschat.token', '');
        setConn(false, '비밀번호 필요');
        return askPassword('입장 권한이 만료되었습니다. 비밀번호를 다시 입력해 주세요.');
      }
      setConn(false, '연결 끊김 — 재연결 중…');
      setTimeout(() => { if (state.es === es) connect(); }, 2000);
    };
  }

  // 에이전트 CLI의 "생각 중" 스피너를 입력 중 표시로 사용
  const SPIN = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
  let spinIdx = 0;
  let spinTimer = null;
  const VERBS = ['입력 중', '생각 중', '작성 중'];
  function renderTyping() {
    const box = $('typing');
    const now = Date.now();
    if (state.cliTyping && now - state.cliTyping.ts > 3500) state.cliTyping = null;
    for (const [id, t] of state.typing) if (now - t.ts > 3500) state.typing.delete(id);
    const here = isCli()
      ? (state.cliTyping ? [{ ...state.cliTyping, agent: true }] : [])
      : [...state.typing.values()].filter((t) => t.channel === state.active);
    if (!here.length) {
      box.hidden = true;
      clearInterval(spinTimer);
      spinTimer = null;
      return;
    }
    box.hidden = false;
    const ag = here.find((t) => t.agent);
    const people = here.filter((t) => !t.agent);
    const rows = [];
    if (ag) {
      const secs = Math.max(1, Math.round((now - ag.start) / 1000));
      rows.push([el('span', 'spin', SPIN[spinIdx % SPIN.length]), el('span', 'verb', ` ${ag.detail || '생각 중'}…`), el('span', 'meta', ` (${secs}s)`)]);
    }
    if (people.length) {
      const verb = VERBS[Math.floor(people[0].start / 1000) % VERBS.length];
      const secs = Math.max(1, Math.round((now - Math.min(...people.map((t) => t.start))) / 1000));
      rows.push([el('span', 'spin dim', ag ? '·' : SPIN[spinIdx % SPIN.length]), el('span', ag ? 'meta' : 'verb', ` ${people.map((t) => t.nick).join(', ')} 님이 ${verb}…`), el('span', 'meta', ` (${secs}s)`)]);
    }
    box.replaceChildren(...rows.map((r) => { const d = el('div'); d.append(...r); return d; }));
    if (!spinTimer) spinTimer = setInterval(() => { spinIdx++; renderTyping(); }, 120);
  }

  async function roomInfo() {
    try {
      const r = await fetch(`/api/room?token=${encodeURIComponent(state.token)}`);
      return r.ok ? await r.json() : null;
    } catch {
      return null;
    }
  }

  // 비밀번호 단계. 입력칸을 password 로 바꿔 어깨너머로 보이지 않게 한다.
  function askPassword(message) {
    state.locked = true;
    $('caret').textContent = '🔒';
    input.hidden = true;
    pw.hidden = false;
    pw.value = '';
    log.replaceChildren(lockBanner());
    if (message) local(message, 'error');
    renderSuggest();
    pw.focus();
  }

  function leavePasswordStep() {
    pw.hidden = true;
    pw.value = '';
    input.hidden = false;
    $('caret').textContent = state.nick ? '>' : '?';
    input.focus();
  }

  function lockBanner() {
    const wrap = el('div');
    const box = el('div', 'welcome');
    const t = el('div', 't');
    t.append(el('span', 'star', '✻ '), '이 방은 ', el('b', null, '비밀번호'), '가 필요합니다');
    box.append(t, el('div', 'gap'));
    box.append(el('div', 'd', '  방을 연 사람에게 비밀번호를 받아 아래에 입력하세요.'));
    box.append(el('div', 'd', `  host: ${location.host}`));
    wrap.append(box);
    return wrap;
  }

  async function submitPassword(value) {
    if (!value) return;
    local('확인하는 중…', 'system');
    let r;
    try {
      r = await fetch('/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: value }),
      });
    } catch {
      return local('서버에 연결할 수 없습니다.', 'error');
    }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      pw.value = '';
      pw.focus();
      return local(d.error || `오류 (${r.status})`, 'error');
    }
    state.token = d.token || '';
    safeSet('vschat.token', state.token);
    state.locked = false;
    leavePasswordStep();
    if (!state.nick) return askNick();
    connect();
  }

  function setConn(ok, text) {
    const n = $('sbConn');
    n.classList.toggle('off', !ok);
    n.textContent = ok ? '● 연결됨' : `○ ${text}`;
  }

  async function post(payload) {
    if (!state.me) return local('아직 서버에 연결되지 않았습니다.', 'error');
    try {
      const r = await fetch('/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: state.me.id, channel: state.active, ...payload }),
      });
      const d = await r.json();
      if (!r.ok) local(d.error || `오류 (${r.status})`, 'error');
      return d;
    } catch {
      local('전송 실패 — 네트워크를 확인하세요.', 'error');
    }
  }

  // ---------- commands ----------
  async function run(line) {
    const [cmd, ...rest] = line.split(' ');
    const arg = rest.join(' ').trim();
    switch (cmd) {
      case '/help': {
        const pre = el('div', 'tree-out');
        COMMANDS.forEach(([c, d], i) => {
          pre.append(i === COMMANDS.length - 1 ? '└ ' : '├ ', el('b', null, c.padEnd(8)), ` ${d}\n`);
        });
        return local('', 'local', pre);
      }
      case '/nick': {
        if (!arg) return local('사용법: /nick <이름>', 'error');
        const d = await post({ type: 'nick', nick: arg });
        if (d?.ok) { state.nick = d.nick; state.me.nick = d.nick; safeSet('vschat.nick', d.nick); renderChrome(); }
        return;
      }
      case '/join': {
        const ch = arg.replace(/^#/, '').toLowerCase().replace(/[^a-z0-9가-힣_-]/g, '').slice(0, 24);
        if (!ch) return local('사용법: /join <채널>', 'error');
        const d = await post({ type: 'join', channel: ch });
        if (d?.ok) {
          if (!state.channels.includes(ch)) state.channels.push(ch);
          state.history[ch] ||= [];
          openChannel(ch);
        }
        return;
      }
      case '/leave': return closeTab(state.active);
      case '/who': {
        const pre = el('div', 'tree-out');
        state.users.forEach((u, i) => {
          const b = el('b', null, u.nick);
          b.style.color = u.color;
          pre.append(i === state.users.length - 1 ? '└ ' : '├ ', b, '\n');
        });
        return local('', 'local', pre);
      }
      case '/me': return arg ? post({ type: 'action', text: arg }) : local('사용법: /me <행동>', 'error');
      case '/clear': return log.replaceChildren();
      case '/cli': return openChannel(CLI_TAB);
      case '/key': {
        if (!arg) {
          const pre = el('div', 'tree-out');
          [`현재 키   ${state.key || '(서버 발급 대기)'}`,
           `터미널 연결  node cli.js ${location.host} --key ${state.key}`,
           '바꾸려면  /key <값>  (터미널 키를 여기에 맞출 때)'].forEach((l, i, a) =>
            pre.append(i === a.length - 1 ? '└ ' : '├ ', l, '\n'));
          return local('', 'local', pre);
        }
        if (!KEY_RE.test(arg)) return local('키는 영숫자·_·- 16~64자여야 합니다.', 'error');
        state.key = arg;
        safeSet('vschat.key', arg);
        local('키를 바꿨습니다. 다시 연결합니다…', 'system');
        return connect();
      }
      case '/agent': return local('', 'local', agentHelp());
      default: return local(`알 수 없는 명령어: ${cmd}  (/help 참고)`, 'error');
    }
  }

  function agentHelp() {
    const pre = el('div', 'tree-out');
    [
      '에이전트는 내 PC의 터미널 클라이언트에서, 내 claude 로그인/API 키로 실행됩니다.',
      `연결:  node cli.js ${location.host} --key ${state.key || '(연결 대기 중)'}`,
      '--key 를 빼면 터미널이 자기 키를 따로 만들어 이 창과 연결되지 않습니다.',
      '연결 후 터미널에서 /cli 로 질문하면 이 창에도 함께 보입니다.',
      '이 대화는 나만 볼 수 있고 방의 다른 사람에게는 전달되지 않습니다.',
    ].forEach((l, i, a) => pre.append(i === a.length - 1 ? '└ ' : '├ ', l, '\n'));
    return pre;
  }

  function shortcutsNode() {
    const pre = el('div', 'tree-out');
    [['Enter', '전송'], ['Shift+Enter', '줄바꿈'], ['/', '명령어 (Tab 자동완성)'], ['↑ / ↓', '이전 입력'], ['Esc', '입력 지우기'], ['@닉네임', '멘션']]
      .forEach(([k, d], i, a) => pre.append(i === a.length - 1 ? '└ ' : '├ ', el('b', null, k.padEnd(12)), ` ${d}\n`));
    return pre;
  }

  // ---------- input ----------
  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 180) + 'px';
  }

  function suggestions() {
    const v = input.value;
    if (!v.startsWith('/') || v.includes(' ')) return [];
    return COMMANDS.filter(([c]) => c.startsWith(v));
  }

  function renderSuggest() {
    const hint = $('hint');
    const list = suggestions();
    if (!list.length) {
      hint.className = 'prompt-hint';
      hint.replaceChildren(
        el('span', null, state.locked ? '비밀번호를 입력하고 Enter' : state.nick ? '? for shortcuts · / 명령어 · Shift+Enter 줄바꿈' : '닉네임을 입력하고 Enter'),
        el('span', 'right', state.me ? `⏵⏵ #${state.active} · ${state.users.length} online` : '')
      );
      return;
    }
    state.suggestIdx = Math.min(state.suggestIdx, list.length - 1);
    hint.className = 'suggest';
    hint.replaceChildren(...list.map(([c, d], i) => el('div', i === state.suggestIdx ? 'sel' : '', `${c.padEnd(10)}${d}`)));
  }

  function askNick() {
    $('caret').textContent = '?';
    input.placeholder = '사용할 닉네임을 입력하세요';
    log.replaceChildren(banner('general'));
    local('처음 오셨네요. 사용할 닉네임을 입력해 주세요.', 'system');
    renderSuggest();
    input.focus();
  }

  async function submit() {
    const text = input.value.replace(/\s+$/, '');
    if (!text.trim()) return;
    input.value = '';
    autosize();
    state.histIdx = -1;

    if (!state.nick) {
      const nick = text.replace(/\s+/g, '').slice(0, 20);
      if (!nick) return;
      state.nick = nick;
      safeSet('vschat.nick', nick);
      $('caret').textContent = '>';
      input.placeholder = '메시지를 입력하세요  (/help 로 명령어 보기)';
      renderSuggest();
      return connect();
    }

    state.inputHistory.unshift(text);
    state.inputHistory.length = Math.min(state.inputHistory.length, 50);
    renderSuggest();
    if (text.startsWith('/')) return run(text.trim());
    if (isCli()) return local('', 'local', agentHelp());
    post({ type: 'chat', text });
    if (/(^|[^\w@])@claude\b/i.test(text)) local('', 'local', agentHelp());
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (state.locked) return submitPassword(pw.value);
    submit();
  });
  pw.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submitPassword(pw.value); }
  });
  input.addEventListener('input', () => {
    autosize();
    state.suggestIdx = 0;
    renderSuggest();
    const v = input.value;
    if (state.me && !isCli() && v.trim() && !v.startsWith('/') && Date.now() - state.lastTypingSent > 1500) {
      state.lastTypingSent = Date.now();
      post({ type: 'typing' });
    }
  });
  input.addEventListener('keydown', (e) => {
    const list = suggestions();
    if (list.length && (e.key === 'Tab' || (e.key === 'Enter' && input.value !== list[state.suggestIdx][0]))) {
      e.preventDefault();
      input.value = list[state.suggestIdx][0] + ' ';
      return renderSuggest();
    }
    if (list.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      state.suggestIdx = (state.suggestIdx + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length;
      return renderSuggest();
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      return submit();
    }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !input.value.includes('\n')) {
      if (!state.inputHistory.length) return;
      e.preventDefault();
      state.histIdx = Math.max(-1, Math.min(state.inputHistory.length - 1, state.histIdx + (e.key === 'ArrowUp' ? 1 : -1)));
      input.value = state.histIdx < 0 ? '' : state.inputHistory[state.histIdx];
      autosize();
    }
    if (e.key === '?' && !input.value) {
      e.preventDefault();
      return local('', 'local', shortcutsNode());
    }
    if (e.key === 'Escape') { input.value = ''; autosize(); renderSuggest(); }
  });

  // activity bar / sidebar
  document.querySelectorAll('.act[data-panel]').forEach((b) => {
    b.onclick = () => {
      const sb = $('sidebar');
      const wasActive = b.classList.contains('active');
      document.querySelectorAll('.act[data-panel]').forEach((x) => x.classList.remove('active'));
      if (wasActive) sb.classList.add('hidden');
      else { b.classList.add('active'); sb.classList.remove('hidden'); }
    };
  });
  if (matchMedia('(max-width: 760px)').matches) {
    $('sidebar').classList.add('hidden');
    document.querySelector('.act.active')?.classList.remove('active');
  }
  $('settingsBtn').onclick = () => { input.value = '/nick '; input.focus(); renderSuggest(); };
  $('newChannel').onclick = () => { input.value = '/join '; input.focus(); renderSuggest(); };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) renderChrome(); });
  log.addEventListener('click', () => { if (!getSelection().toString()) input.focus(); });

  renderChrome();
  (async () => {
    const room = await roomInfo();
    if (room && room.locked && !room.authed) return askPassword();
    if (state.nick) connect();
    else askNick();
  })();
})();
