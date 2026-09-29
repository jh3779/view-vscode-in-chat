const $ = (id) => document.getElementById(id);
const nickInput = $('nick');
const addrInput = $('addr');
const SPIN = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];

let rooms = [];
let sel = 0;
let spin = 0;
let busy = false;

try { nickInput.value = localStorage.getItem('nick') || ''; } catch {}

window.launcher.info().then(({ addresses }) => {
  $('where').textContent = `\n  이 PC 주소: ${addresses.join(', ') || '(네트워크 없음)'}\n  같은 네트워크의 방은 자동으로 검색됩니다`;
});

function items() {
  return [
    { kind: 'host', label: '새 방 열기', sub: '이 PC에서 서버를 시작합니다' },
    ...rooms.map((r) => ({ kind: 'room', room: r, label: r.name || '이름 없는 방', sub: `${r.ip}:${r.port} · ${r.users}명 접속 중` })),
    { kind: 'manual', label: '주소 직접 입력…', sub: 'IP:포트' },
  ];
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function render() {
  const list = items();
  sel = Math.min(sel, list.length - 1);
  const ul = $('menu');
  ul.replaceChildren();
  list.forEach((it, i) => {
    const li = el('li', i === sel ? 'sel' : '');
    li.append(el('span', 'ptr', i === sel ? '❯' : ' '), `${i + 1}. ${it.label}`, el('span', 'sub', `  ${it.sub}`));
    li.onclick = () => { sel = i; render(); choose(); };
    ul.append(li);
    if (i === 0 && !rooms.length) {
      const s = el('li', 'searching');
      s.append(el('span', 'ptr', ' '), el('span', 'spin', SPIN[spin % SPIN.length]), ' 같은 네트워크에서 방을 찾는 중…');
      ul.append(s);
    }
  });
  $('manual').classList.toggle('show', list[sel].kind === 'manual');
}

function nick() {
  const n = nickInput.value.replace(/\s+/g, '').slice(0, 20);
  if (!n) {
    $('err').textContent = '✗ 닉네임을 먼저 입력해 주세요';
    nickInput.focus();
    return null;
  }
  try { localStorage.setItem('nick', n); } catch {}
  return n;
}

async function choose() {
  if (busy) return;
  const it = items()[sel];
  const n = nick();
  if (!n) return;
  if (it.kind === 'manual' && !addrInput.value.trim()) return addrInput.focus();
  busy = true;
  // 경과 시간을 보여 준다. 멈춘 건지 진행 중인지 화면만 보고 알 수 있어야 한다.
  const label = it.kind === 'host' ? 'Host()' : 'Connect()';
  const doing = it.kind === 'host' ? '서버를 시작하는 중' : '연결하는 중';
  const t0 = Date.now();
  const tick = () => {
    const s = Math.round((Date.now() - t0) / 1000);
    $('err').className = 'err ok';
    $('err').textContent = `⏺ ${label}\n  ⎿  ${doing}… ${s ? `(${s}s)` : ''}`;
  };
  tick();
  const timer = setInterval(tick, 1000);
  try {
    if (it.kind === 'host') await window.launcher.host(n, 3000);
    else if (it.kind === 'room') await window.launcher.join(n, `${it.room.ip}:${it.room.port}`);
    else await window.launcher.join(n, addrInput.value);
  } catch (e) {
    $('err').className = 'err';
    $('err').textContent = `✗ ${String(e.message).replace(/^Error invoking remote method '\w+': (Error: )?/, '')}`;
    busy = false;
  } finally {
    clearInterval(timer);
  }
}

document.addEventListener('keydown', (e) => {
  const list = items();
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    sel = (sel + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length;
    render();
    if (list[sel].kind === 'manual') addrInput.focus();
    else if (document.activeElement === addrInput) nickInput.focus();
  } else if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault();
    choose();
  } else if (/^[1-9]$/.test(e.key) && document.activeElement !== nickInput && document.activeElement !== addrInput) {
    const i = Number(e.key) - 1;
    if (i < list.length) { sel = i; render(); choose(); }
  }
});

window.launcher.onRooms((r) => {
  const cur = items()[sel];
  rooms = r.sort((a, b) => a.name.localeCompare(b.name));
  if (cur.kind === 'room') {
    const i = rooms.findIndex((x) => x.ip === cur.room.ip && x.port === cur.room.port);
    sel = i >= 0 ? i + 1 : 0;
  } else if (cur.kind === 'manual') sel = rooms.length + 1;
  render();
});
setInterval(() => { spin++; if (!rooms.length) render(); }, 120);
render();
