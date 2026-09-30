#!/usr/bin/env node
// 터미널 채팅 클라이언트.
// 같은 네트워크의 방에 참가해 터미널에서 대화하고, @claude 요청은 "내 PC"에서 "내 환경"
// (claude 로그인 또는 ANTHROPIC_API_KEY)으로 실행합니다. 결과는 나만 보는 CLI 대화창에만 남습니다.
//
//   node cli.js [주소] [--nick 이름] [--cwd 폴더] [--model 모델] [--tools Read,Grep,Glob] [--claude 경로]
const readline = require('readline');
const dgram = require('dgram');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runAgent, findClaude, DEFAULT_TOOLS } = require('./agent');

// ---------- options ----------
const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return null;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
if (argv.includes('-h') || argv.includes('--help')) {
  console.log(`사용법: node cli.js [주소] [--nick 이름] [--password 비밀번호] [--cwd 폴더] [--model 모델] [--tools ${DEFAULT_TOOLS}] [--claude 경로]

  주소를 생략하면 같은 네트워크의 방을 자동으로 찾습니다.
  비밀번호가 걸린 방이면 --password 로 주거나, 생략하면 접속할 때 물어봅니다.
  @claude 요청은 이 PC에서, 이 터미널 환경의 claude 로그인 또는 ANTHROPIC_API_KEY로 실행됩니다.`);
  process.exit(0);
}
const CONFIG_FILE = process.env.LAN_CHAT_CONFIG || path.join(os.homedir(), '.lan-chat.json');
const config = (() => { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; } })();
const options = {
  nick: opt('nick'),
  key: opt('key'),
  cwd: path.resolve(opt('cwd') || process.cwd()),
  model: opt('model') || '',
  tools: opt('tools') || DEFAULT_TOOLS,
  claude: opt('claude'),
  password: opt('password'),
  address: argv.find((a) => !a.startsWith('-')) || null,
};
// CLI 대화창 소유권 키. 이 기기에만 저장되며, 이 값을 아는 연결만 내 CLI 창을 본다.
function ensureKey() {
  const k = options.key || config.key;
  if (/^[A-Za-z0-9_-]{16,64}$/.test(String(k || ''))) return String(k);
  return require('crypto').randomUUID().replace(/-/g, '');
}

const saveConfig = (patch) => {
  Object.assign(config, patch);
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); } catch {}
};

// ---------- terminal styling ----------
const out$ = process.stdout;
const esc = (code) => (s) => `\x1b[${code}m${s}\x1b[0m`;
const bold = esc('1');
const dim = esc('2');
const italic = esc('3');
const hex = (h) => {
  const n = parseInt(String(h || '#cccccc').slice(1), 16);
  return esc(`38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`);
};
const ORANGE = hex('#d7875f');
const GREEN = hex('#4ec9b0');
const RED = hex('#f48771');
const BLUE = hex('#3794ff');
const CODE = hex('#d7ba7d');
const MINE_BG = esc('48;5;236');

// 한글·CJK·이모지는 터미널에서 2칸을 차지합니다.
function strWidth(s) {
  let w = 0;
  for (const ch of s.replace(/\x1b\[[0-9;]*m/g, '')) {
    const c = ch.codePointAt(0);
    w += (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) ? 2 : 1;
  }
  return w;
}

// 폭을 넘는 줄은 가운데를 …로 줄입니다 (ANSI 색이 없는 줄에만 적용)
function fit(s, max) {
  if (strWidth(s) <= max || /\x1b\[/.test(s)) return s;
  const chars = [...s];
  let head = '';
  let tail = '';
  while (strWidth(head) + strWidth(tail) < max - 1 && chars.length) {
    if (strWidth(head) <= strWidth(tail)) head += chars.shift();
    else tail = chars.pop() + tail;
  }
  return `${head}…${tail}`;
}

function box(lines, color = ORANGE) {
  const width = Math.min(Math.max(...lines.map(strWidth)) + 2, (out$.columns || 80) - 2);
  const pad = (l) => l + ' '.repeat(Math.max(0, width - 1 - strWidth(l)));
  lines = lines.map((l) => fit(l, width - 1));
  return [
    color(`╭${'─'.repeat(width)}╮`),
    ...lines.map((l) => `${color('│')} ${pad(l)}${color('│')}`),
    color(`╰${'─'.repeat(width)}╯`),
  ].join('\n');
}

function inline(text) {
  return text
    .replace(/`([^`\n]+)`/g, (_, c) => CODE(c))
    .replace(/\*\*([^*\n]+)\*\*/g, (_, b) => bold(b))
    .replace(/(^|[^\w@])(@[^\s@]+)/g, (_, p, m) => p + (/^@claude$/i.test(m) ? ORANGE(bold(m)) : BLUE(bold(m))))
    .replace(/(https?:\/\/[^\s]+)/g, (u) => BLUE(u));
}

// 본문: ``` 코드 블록은 세로줄로, 나머지는 인라인 강조
function body(text, indent = '  ') {
  return text
    .split(/```/)
    .map((part, i) => {
      if (i % 2 === 1) {
        const code = part.replace(/^[\w-]*\n/, '').replace(/\n$/, '');
        return code.split('\n').map((l) => `${indent}${dim('│')} ${CODE(l)}`).join('\n');
      }
      return part.replace(/^\n|\n$/g, '').split('\n').map((l) => indent + inline(l)).join('\n');
    })
    .filter((x) => x.trim())
    .join('\n');
}

const time = (ts) => new Date(ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });

// ---------- state ----------
const state = {
  base: null,
  me: null,
  nick: options.nick || config.nick || '',
  channel: 'general',
  mode: 'chat', // 'chat' = 일반 대화창, 'cli' = 내 CLI 대화창(남에게 안 보임)
  key: '',
  cli: [], // 내 CLI 대화창 기록
  channels: [],
  history: {},
  users: [],
  lastTs: 0,
  controller: null,
  connected: false,
  agent: null, // { run, start, detail, channel }
  agentQueue: [],
  session: null, // CLI 대화창은 하나이므로 세션도 하나
  lastTypingSent: 0,
  lastAgentTyping: 0,
  quitting: false,
  token: '',
  locked: false,
};

// ---------- screen: 출력 영역 + (스피너) + 프롬프트 ----------
let rl;
let footer = 0; // 프롬프트 위에 그려진 스피너 줄 수
const SPIN = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
let spinIdx = 0;

function clearFooter() {
  out$.write('\r\x1b[K');
  for (; footer > 0; footer--) out$.write('\x1b[1A\r\x1b[K');
}

function drawFooter() {
  if (state.agent) {
    const secs = Math.max(1, Math.round((Date.now() - state.agent.start) / 1000));
    out$.write(`${ORANGE(SPIN[spinIdx % SPIN.length])} ${ORANGE(`${state.agent.detail}…`)} ${dim(`(${secs}s · esc to interrupt)`)}\n`);
    footer = 1;
  }
  if (rl) rl.prompt(true);
}

function print(text = '') {
  clearFooter();
  out$.write(`${text}\n`);
  drawFooter();
}

setInterval(() => {
  if (!state.agent) return;
  spinIdx++;
  clearFooter();
  drawFooter();
}, 120).unref();

// ---------- message rendering ----------
function renderMessage(m) {
  if (m.type === 'agent-log') {
    const [call, ...rest] = String(m.text).split('\n');
    const p = call.indexOf('(');
    const lines = [`${ORANGE('⏺')} ${p > 0 ? bold(call.slice(0, p)) + call.slice(p) : bold(call)}`];
    for (const r of rest) lines.push(dim(`  ${r}`));
    return lines.join('\n');
  }
  if (m.type === 'agent') {
    return `${ORANGE('⏺')} ${bold(ORANGE('claude'))} ${dim(time(m.ts))}\n${body(m.text)}`;
  }
  if (m.type === 'cli') {
    return m.text.split('\n').map((l, i) => MINE_BG(`${i === 0 ? '>' : ' '} ${l} `)).join('\n');
  }
  if (m.type === 'system') {
    const [call, ...rest] = String(m.text).split('\n');
    const p = call.indexOf('(');
    const head = p > 0 ? bold(call.slice(0, p)) + call.slice(p) : bold(call);
    const bullet = m.agent ? ORANGE('⏺') : GREEN('⏺');
    const lines = [`${bullet} ${head}`];
    for (const r of rest) lines.push(dim(`  ${r}`));
    return lines.join('\n');
  }
  if (m.type === 'action') return italic(hex('#d7ba7d')(`  * ${m.nick} ${m.text}`));
  const mine = state.me && m.userId === state.me.id;
  if (mine) {
    return m.text.split('\n').map((l, i) => MINE_BG(`${i === 0 ? '>' : ' '} ${l} `)).join('\n');
  }
  return `${hex(m.color)('⏺')} ${bold(hex(m.color)(m.nick))} ${dim(time(m.ts))}\n${body(m.text)}`;
}

function onMessage(m) {
  (state.history[m.channel] ||= []).push(m);
  if (state.history[m.channel].length > 200) state.history[m.channel].shift();
  state.lastTs = Math.max(state.lastTs, m.ts);
  if (m.channel === state.channel) {
    print(renderMessage(m));
  } else if (m.type === 'chat') {
    const preview = m.text.replace(/\s+/g, ' ').slice(0, 60);
    print(dim(`  ↳ #${m.channel} · ${m.nick}: ${preview}`));
  }
}

// CLI 대화창 메시지. 서버가 같은 키를 가진 내 연결에만 보낸 것이다.
function onCliMessage(m) {
  state.cli.push(m);
  if (state.cli.length > 200) state.cli.shift();
  if (state.mode === 'cli') print(renderMessage(m));
  else if (m.type === 'agent') print(dim(`  ↳ claude.cli · ${m.text.replace(/\s+/g, ' ').slice(0, 60)}`));
}

function welcome() {
  const host = state.base.replace(/^https?:\/\//, '');
  const claude = findClaude(options.claude);
  const auth = process.env.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY (이 터미널 환경변수)' : 'claude 로그인 계정';
  print(box([
    `${ORANGE('✻')} Welcome to ${bold(`#${state.channel}`)}!`,
    '',
    dim('  /help 로 명령어 보기, /cli 로 내 에이전트 창 열기'),
    '',
    `  host:  ${host}${state.locked ? '  🔒 비밀번호 있음' : ''}`,
    `  cwd:   ${options.cwd.replace(os.homedir(), '~')}`,
    `  agent: ${claude ? `${auth} · ${options.tools === DEFAULT_TOOLS ? '읽기 전용' : options.tools}` : 'claude CLI 없음'}`,
  ]));
  print(dim('  CLI 대화창은 나만 볼 수 있습니다 — 방의 다른 사람은 내용도 존재도 볼 수 없습니다.'));
  print(dim(`  연결 키: ${state.key}   (브라우저/앱의 claude.cli 탭에서  /key ${state.key}  로 맞추면 함께 보입니다)`));
  print('');
}

function showCli(count = 30) {
  const w = Math.max(0, Math.min(60, (out$.columns || 80) - 16));
  print(ORANGE(`── claude.cli ${'─'.repeat(w)}`) + dim('  (나만 보임)'));
  if (!state.cli.length) print(dim('  아직 대화가 없습니다. 바로 질문을 입력하세요.'));
  for (const m of state.cli.slice(-count)) print(renderMessage(m));
}

function showChannel(ch, count = 30) {
  print(dim(`── #${ch} ${'─'.repeat(Math.max(0, Math.min(60, (out$.columns || 80) - ch.length - 6)))}`));
  for (const m of (state.history[ch] || []).slice(-count)) print(renderMessage(m));
}

function tree(lines) {
  print(lines.map((l, i) => dim(`  ${i === lines.length - 1 ? '└' : '├'} `) + l).join('\n'));
}

// ---------- network ----------
async function post(payload) {
  if (!state.me) return null;
  try {
    const r = await fetch(`${state.base}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: state.me.id, channel: state.channel, ...payload }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok && payload.type !== 'typing') print(RED(`✗ ${d.error || `오류 (${r.status})`}`));
    return r.ok ? d : null;
  } catch {
    if (payload.type !== 'typing') print(RED('✗ 전송 실패 — 네트워크를 확인하세요'));
    return null;
  }
}

async function connect() {
  let first = true;
  while (!state.quitting) {
    state.controller = new AbortController();
    try {
      const url = `${state.base}/events?client=cli&key=${encodeURIComponent(state.key)}&token=${encodeURIComponent(state.token)}&nick=${encodeURIComponent(state.nick)}`;
      const res = await fetch(url, { signal: state.controller.signal, headers: { Accept: 'text/event-stream' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let event = 'message';
          let data = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) data += line.slice(6);
          }
          if (data) handleEvent(event, JSON.parse(data), first);
          if (event === 'welcome') first = false;
        }
      }
    } catch (e) {
      if (state.quitting) return;
      if (first) {
        print(RED(`✗ ${state.base} 에 연결할 수 없습니다 (${e.cause?.code || e.message})`));
        process.exit(1);
      }
    }
    if (state.quitting) return;
    if (state.connected) print(RED('○ 연결이 끊겼습니다 — 재연결 중…'));
    state.connected = false;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

function handleEvent(event, d, first) {
  if (event === 'welcome') {
    state.me = { id: d.id, nick: d.nick, color: d.color };
    state.nick = d.nick;
    state.channels = d.channels;
    state.users = d.users;
    state.connected = true;
    state.cli = d.cli || [];
    if (d.key && d.key !== state.key) { state.key = d.key; saveConfig({ key: d.key }); }
    if (first) {
      state.history = d.history;
      welcome();
      showChannel(state.channel, 20);
      state.lastTs = Math.max(0, ...Object.values(d.history).flat().map((m) => m.ts));
    } else {
      print(GREEN('● 재연결되었습니다'));
      for (const m of Object.values(d.history).flat().filter((x) => x.ts > state.lastTs).sort((a, b) => a.ts - b.ts)) onMessage(m);
    }
  } else if (event === 'message') onMessage(d);
  else if (event === 'cli-message') onCliMessage(d);
  else if (event === 'users') state.users = d;
  else if (event === 'channels') state.channels = d;
}

// ---------- agent (내 PC, 내 키) ----------
// CLI 대화창은 나 혼자만 쓰므로 맥락도 내 입력뿐이다.
// 방의 다른 사람이 쓴 글은 프롬프트에 들어가지 않는다(감사 지적 4번 — 주입 경계 제거).
// 이전 턴은 --resume 세션이 이미 기억하므로 여기서 다시 붙이지 않는다.
function buildPrompt(job) {
  return job.text;
}

function startAgent(job) {
  const bin = findClaude(options.claude);
  if (!bin) {
    print(RED('✗ claude CLI를 찾지 못했습니다. 설치 후 다시 시도하거나 --claude <경로> 로 지정하세요'));
    return;
  }
  const a = { start: Date.now(), detail: '생각 중' };
  state.agent = a;
  const send = (payload) => post(payload);
  const typing = (force) => {
    if (!force && Date.now() - state.lastAgentTyping < 1000) return;
    state.lastAgentTyping = Date.now();
    send({ type: 'agent-typing', detail: a.detail, since: a.start });
  };
  typing(true);
  const beat = setInterval(() => typing(true), 1500);

  a.run = runAgent({
    bin,
    prompt: buildPrompt(job),
    cwd: options.cwd,
    model: options.model,
    tools: options.tools,
    session: state.session,
    onEvent(ev) {
      if (ev.kind === 'session') state.session = ev.id;
      else if (ev.kind === 'detail') { a.detail = ev.text; typing(); }
      else if (ev.kind === 'text') send({ type: 'agent-text', text: ev.text });
      else if (ev.kind === 'tool') send({ type: 'agent-log', text: `${ev.call}\n⎿  ${ev.result}` });
      else if (ev.kind === 'done') {
        send({ type: 'agent-log', text: `Done(${ev.secs.toFixed(1)}s)\n⎿  완료` });
        if (ev.cost != null) a.cost = ev.cost;
      } else if (ev.kind === 'error') {
        send({ type: 'agent-log', text: `${ev.interrupted ? 'Interrupted' : 'Error'}\n⎿  ${ev.message}` });
      }
    },
  });

  a.run.done.then(() => {
    clearInterval(beat);
    send({ type: 'agent-idle' });
    clearFooter();
    state.agent = null;
    drawFooter();
    // 사용량은 방에 공유하지 않고 내 터미널에만, 완료 로그가 돌아온 뒤에 표시
    if (a.cost != null) setTimeout(() => print(dim(`  (내 사용량: $${a.cost.toFixed(4)})`)), 400);
    const next = state.agentQueue.shift();
    if (next) startAgent(next);
  });
}

// ---------- commands ----------
const COMMANDS = [
  ['/help', '명령어 목록'],
  ['/join <채널>', '채널 이동/생성'],
  ['/channels', '채널 목록'],
  ['/who', '접속자 목록'],
  ['/nick <이름>', '닉네임 변경'],
  ['/me <행동>', '행동 메시지'],
  ['/cli', '내 에이전트 창 열기 (나만 보임)'],
  ['/chat', '일반 대화창으로 돌아가기'],
  ['/key', '이 터미널의 CLI 창 연결 키 보기'],
  ['/agent', '에이전트 상태 · cwd <폴더> · model <이름> · reset · stop'],
  ['/clear', '화면 지우기'],
  ['/quit', '나가기 (Ctrl+C 두 번)'],
];

async function command(line) {
  const [cmd, ...rest] = line.split(/\s+/);
  const arg = rest.join(' ').trim();
  switch (cmd) {
    case '/help':
      return tree(COMMANDS.map(([c, d]) => `${bold(c.padEnd(14))} ${d}`));
    case '/join': {
      const ch = arg.replace(/^#/, '').toLowerCase().replace(/[^a-z0-9가-힣_-]/g, '').slice(0, 24);
      if (!ch) return print(RED('✗ 사용법: /join <채널>'));
      const prev = state.channel;
      state.channel = ch;
      const d = await post({ type: 'join' });
      if (!d) { state.channel = prev; return; }
      state.history[ch] ||= [];
      state.mode = 'chat';
      rl.setPrompt(promptText());
      return showChannel(ch);
    }
    case '/cli':
      state.mode = 'cli';
      rl.setPrompt(promptText());
      return showCli();
    case '/chat':
      state.mode = 'chat';
      rl.setPrompt(promptText());
      return showChannel(state.channel);
    case '/key':
      return tree([
        `연결 키        ${bold(state.key)}`,
        `브라우저에 맞추기  /key ${state.key}`,
        `이 키로 접속하기   node cli.js ${state.base.replace(/^https?:\/\//, '')} --key ${state.key}`,
      ]);
    case '/channels':
      return tree(state.channels.map((c) => (c === state.channel ? bold(`#${c}`) + dim('  (현재)') : `#${c}`)));
    case '/who':
      return tree(state.users.map((u) => hex(u.color)(u.nick) + (u.kind === 'cli' ? dim('  >_ cli') : '') + (u.id === state.me?.id ? dim('  (you)') : '')));
    case '/nick': {
      if (!arg) return print(RED('✗ 사용법: /nick <이름>'));
      const d = await post({ type: 'nick', nick: arg });
      if (d?.ok) { state.nick = d.nick; state.me.nick = d.nick; saveConfig({ nick: d.nick }); }
      return;
    }
    case '/me':
      return arg ? post({ type: 'action', text: arg }) : print(RED('✗ 사용법: /me <행동>'));
    case '/clear':
      out$.write('\x1b[2J\x1b[H');
      return welcome();
    case '/quit':
    case '/exit':
      return quit();
    case '/agent': {
      const [sub = 'status', ...r] = arg.split(/\s+/);
      const val = r.join(' ');
      if (sub === 'status') {
        const bin = findClaude(options.claude);
        return tree([
          `실행 위치  이 PC (${os.hostname()})`,
          `인증       ${process.env.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY 환경변수' : 'claude 로그인 계정'}`,
          `claude     ${bin || RED('찾을 수 없음')}`,
          `작업 폴더  ${options.cwd}`,
          `도구       ${options.tools}${options.tools === DEFAULT_TOOLS ? ' (읽기 전용)' : ''}`,
          `모델       ${options.model || '(기본값)'}`,
          `대화창     claude.cli (나만 보임, ${state.cli.length}건)`,
          `연결 키    ${state.key}`,
          `상태       ${state.agent ? `실행 중 · 대기 ${state.agentQueue.length}건` : '대기 중'}`,
        ]);
      }
      if (sub === 'cwd') {
        if (!val) return print(dim(`  작업 폴더: ${options.cwd}`));
        const dir = path.resolve(val.replace(/^~/, os.homedir()));
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return print(RED(`✗ 폴더가 없습니다: ${dir}`));
        options.cwd = dir;
        state.session = null;
        return print(dim(`  ⎿  작업 폴더: ${dir}`));
      }
      if (sub === 'model') {
        options.model = val.replace(/[^\w.-]/g, '');
        return print(dim(`  ⎿  모델: ${options.model || '(기본값)'}`));
      }
      if (sub === 'reset') {
        state.session = null;
        return print(dim('  ⎿  에이전트 대화 기억을 초기화했습니다'));
      }
      if (sub === 'stop') return state.agent ? state.agent.run.stop() : print(dim('  ⎿  실행 중인 작업이 없습니다'));
      return print(RED('✗ 사용법: /agent [status|cwd <폴더>|model <이름>|reset|stop]'));
    }
    default:
      return print(RED(`✗ 알 수 없는 명령어: ${cmd}  (/help 참고)`));
  }
}

async function onLine(raw) {
  const text = raw.replace(/\s+$/, '');
  // readline이 입력 줄을 남겨두므로 지우고, 서버 에코로 다시 그립니다.
  out$.write('\x1b[1A\r\x1b[K');
  if (!text.trim()) return drawFooter();
  if (text.startsWith('/')) {
    clearFooter();
    drawFooter();
    return command(text.trim());
  }
  // CLI 대화창: 입력 전부가 내 에이전트에게 간다. 방에는 아무것도 나가지 않는다.
  if (state.mode === 'cli') {
    if (!(await post({ type: 'cli', text }))) return;
    const job = { text, ts: Date.now() };
    if (state.agent) {
      state.agentQueue.push(job);
      print(dim(`  ⎿  대기열에 추가했습니다 (${state.agentQueue.length})`));
    } else startAgent(job);
    return;
  }
  // 일반 대화창: 사람에게만 간다. 에이전트는 여기서 돌지 않는다.
  if (!(await post({ type: 'chat', text }))) return;
  if (/(^|[^\w@])@claude\b/i.test(text)) print(dim('  ⎿  에이전트는 /cli 창에서 대화합니다 (일반 대화창과 분리)'));
}

const promptText = () => (state.mode === 'cli'
  ? `${ORANGE('claude.cli')} ${bold('>')} `
  : `${dim(`#${state.channel}`)} ${bold('>')} `);

function quit() {
  state.quitting = true;
  if (state.agent) state.agent.run.stop();
  state.controller?.abort();
  clearFooter();
  out$.write(dim('  ⎿  나갔습니다\n'));
  process.exit(0);
}

// ---------- startup: 방 찾기 ----------
function discover(ms = 2500) {
  return new Promise((resolve) => {
    const rooms = new Map();
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('error', () => resolve([]));
    sock.on('message', (buf, rinfo) => {
      try {
        const b = JSON.parse(buf.toString('utf8'));
        if (b.app === 'lan-agent-chat' && Number.isInteger(b.port)) rooms.set(`${rinfo.address}:${b.port}`, { ...b, ip: rinfo.address });
      } catch {}
    });
    sock.bind(41234);
    setTimeout(() => { try { sock.close(); } catch {} resolve([...rooms.values()]); }, ms);
  });
}

const ask = (q) => new Promise((r) => rl.question(q, r));

// 비밀번호를 칠 때만 화면 에코를 끈다(sudo 와 같은 방식). readline 의 내부 훅을
// 잠시 갈아끼우되, 끝나면 반드시 원래 함수로 되돌린다 — null 로 두면 이후 입력에서
// readline 이 죽는다.
function askHidden(q) {
  return new Promise((resolve) => {
    const original = rl._writeToOutput;
    out$.write(q);
    rl._writeToOutput = () => {};
    rl.question('', (v) => {
      rl._writeToOutput = original;
      out$.write('\n');
      resolve(v);
    });
  });
}

// 방이 잠겨 있으면 비밀번호를 확인하고 입장 토큰을 받는다.
async function authenticate() {
  let info;
  try {
    info = await fetch(`${state.base}/api/room`).then((r) => (r.ok ? r.json() : null));
  } catch {
    print(RED(`✗ ${state.base} 에 연결할 수 없습니다`));
    process.exit(1);
  }
  if (!info || !info.locked) return true;
  state.locked = true;

  let pw = options.password;
  for (let i = 0; i < 3; i++) {
    if (!pw) {
      pw = await askHidden(`${ORANGE('🔒')} 방 비밀번호: `);
    }
    const r = await fetch(`${state.base}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw }),
    }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    if (r && r.ok) { state.token = d.token || ''; return true; }
    out$.write(RED(`  ✗ ${d.error || '인증 실패'}\n`));
    pw = '';
  }
  out$.write(RED('  ✗ 입장하지 못했습니다\n'));
  process.exit(1);
}

async function main() {
  rl = readline.createInterface({ input: process.stdin, output: out$, terminal: true, historySize: 100 });

  if (!options.address) {
    out$.write(`${ORANGE('✻')} 같은 네트워크에서 방을 찾는 중…\n`);
    const rooms = await discover();
    if (rooms.length) {
      rooms.forEach((r, i) => out$.write(`  ${i + 1}. ${r.locked ? '🔒 ' : ''}${r.name}  ${dim(`${r.ip}:${r.port} · ${r.users}명${r.locked ? ' · 비밀번호 필요' : ''}`)}\n`));
      out$.write(`  ${rooms.length + 1}. ${dim('주소 직접 입력')}\n`);
      const pick = Number(await ask(`${bold('>')} 번호: `));
      if (pick >= 1 && pick <= rooms.length) options.address = `${rooms[pick - 1].ip}:${rooms[pick - 1].port}`;
    } else {
      out$.write(dim('  ⎿  찾은 방이 없습니다\n'));
    }
    if (!options.address) options.address = (await ask(`${bold('>')} 주소 (IP:포트): `)).trim();
  }
  let addr = options.address;
  if (!/^https?:\/\//.test(addr)) addr = `http://${addr}`;
  const url = new URL(addr);
  if (!url.port) url.port = '3000';
  state.base = url.origin;

  if (!state.nick) state.nick = (await ask(`${bold('>')} 닉네임: `)).replace(/\s+/g, '').slice(0, 20);
  if (!state.nick) process.exit(1);
  state.key = ensureKey();
  saveConfig({ nick: state.nick, key: state.key });

  await authenticate();

  rl.setPrompt(promptText());
  rl.on('line', onLine);
  rl.on('SIGINT', () => {
    if (state.agent) return state.agent.run.stop();
    if (rl.line) { rl.write(null, { ctrl: true, name: 'u' }); return; }
    if (state.sigint && Date.now() - state.sigint < 1500) return quit();
    state.sigint = Date.now();
    print(dim('  ⎿  한 번 더 누르면 나갑니다'));
  });
  process.stdin.on('keypress', (_s, key) => {
    if (!key) return;
    if (key.name === 'escape' && state.agent) return state.agent.run.stop();
    if (key.name === 'return') return;
    const line = rl.line || '';
    if (state.me && line.trim() && !line.startsWith('/') && Date.now() - state.lastTypingSent > 1500) {
      state.lastTypingSent = Date.now();
      post({ type: 'typing' });
    }
  });
  rl.on('close', quit);

  connect();
}

main();
