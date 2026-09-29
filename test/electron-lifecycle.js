// 방장이 채팅 창을 닫았을 때 앱이 죽지 않고 런처로 돌아오는지 실제 Electron 에서 확인한다.
// 화면이 필요하므로 CI 에는 넣지 않는다:  npm run test:app
//
// 주의: 이 스크립트는 macOS 에서 수정 전 코드로도 통과한다(경합이 재현되지 않음).
// 원 증상은 Windows 에서만 관측됐다. 따라서 "고쳐졌다"의 근거가 아니라
// "고친 코드가 정상 동작한다"는 스모크 테스트로만 취급할 것.
const { app, BrowserWindow } = require('electron');
const path = require('path');

let quit = false;
app.on('quit', () => { quit = true; });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (m) => { console.error(`✖ ${m}`); app.exit(1); };

app.whenReady().then(async () => {
  // app/main.js 의 실제 흐름을 그대로 쓴다.
  const main = require(path.join(__dirname, '..', 'app', 'main.js'));
  await wait(1500);

  let wins = BrowserWindow.getAllWindows();
  if (wins.length !== 1) return fail(`시작 시 런처 1개를 기대했지만 ${wins.length}개`);
  console.log('✔ 런처가 떴다');

  // 런처를 거치지 않고 host 핸들러를 직접 부르기 위해 ipcMain 경유 대신 내부 흐름을 흉내 낸다.
  const { ipcMain } = require('electron');
  const res = await ipcMain._invokeHandlers.get('host')({}, { nick: 'hosttest', port: 0 });
  await wait(2000);
  console.log(`✔ 방을 열었다 (포트 ${res.port})`);

  wins = BrowserWindow.getAllWindows();
  const chat = wins.find((w) => (w.webContents.getURL() || '').includes(String(res.port)));
  if (!chat) return fail('채팅 창을 찾지 못했다');

  // 다른 기기가 붙어 있는 상태를 만든다. 열린 SSE 연결이 있으면 server.stop() 이
  // 소켓 종료를 기다리느라 느려지고, 그 틈에 window-all-closed 가 앱을 닫는다.
  const http = require('http');
  const lurker = http.get({ host: '127.0.0.1', port: res.port, path: '/events?nick=guest' });
  await new Promise((r) => lurker.once('response', r));
  console.log('✔ 다른 참가자 한 명이 접속한 상태를 만들었다');

  chat.close();
  await wait(2500);

  if (quit) return fail('방장이 창을 닫자 앱이 종료됐다 (런처로 돌아와야 한다)');
  wins = BrowserWindow.getAllWindows();
  if (wins.length !== 1) return fail(`런처 1개를 기대했지만 ${wins.length}개, quit=${quit}`);
  const url = wins[0].webContents.getURL();
  if (!url.includes('launcher.html')) return fail(`런처가 아니다: ${url}`);

  console.log('✔ 방장이 창을 닫아도 앱이 살아 있고 런처로 돌아왔다');
  console.log('\n통과');
  app.exit(0);
});
