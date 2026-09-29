# LAN Chat

[![test](https://github.com/jh3779/view-vscode-in-chat/actions/workflows/test.yml/badge.svg)](https://github.com/jh3779/view-vscode-in-chat/actions/workflows/test.yml)
[![release](https://img.shields.io/github/v/release/jh3779/view-vscode-in-chat)](https://github.com/jh3779/view-vscode-in-chat/releases/latest)

같은 네트워크(LAN/Wi-Fi)에 있는 기기끼리 접속하는 VS Code 스타일 채팅입니다. 외부 의존성 없이 Node 18+만 있으면 동작합니다.

화면은 **두 가지로 완전히 분리**되어 있습니다.

| | 일반 대화창 (`#general` 등) | CLI 대화창 (`claude.cli`) |
| --- | --- | --- |
| 대상 | 방에 있는 모든 사람 | **나만** |
| 내용 | 사람끼리의 채팅 | 내 AI 에이전트와의 대화 |
| 실행 위치 | — | 내 PC, 내 계정/키 |
| 남에게 보이나 | 보임 | **내용도 존재도 안 보임** |

CLI 대화창은 서버가 기기 저장 키를 가진 연결에만 보내므로, 다른 참가자가 SSE에 직접 붙어도 남의 CLI 창은 받지 못합니다.

## 데스크톱 앱 (Electron)

```bash
npm install
npm run app        # 개발 실행
npm run dist:mac   # macOS dmg 빌드 (dist/)
npm run dist:win   # Windows 설치 파일 빌드
```

- **새 방 열기**: 앱 안에서 채팅 서버를 시작합니다(3000번, 사용 중이면 다음 포트로 자동 변경). UDP 41234 포트로 LAN에 방을 알립니다.
- **방 참가**: 같은 네트워크의 방이 자동으로 목록에 뜹니다. 안 뜨면 `IP:포트`를 직접 입력하세요.
- 방장이 채팅 창을 닫으면 서버도 종료되고 런처로 돌아갑니다.
- 앱이 없는 사람은 브라우저로 `http://<방장 IP>:<포트>`에 접속하면 됩니다.

## 터미널 클라이언트 + 에이전트 (`cli.js`)

```bash
node cli.js                       # 같은 네트워크의 방 자동 검색
node cli.js 172.30.1.86:3001      # 주소 직접 지정
node cli.js <주소> --cwd ~/project --model sonnet
```

- 터미널에서 방에 참가해 대화합니다.
- `/cli` 를 치면 **내 CLI 대화창**으로 들어갑니다. 여기 입력하는 모든 문장이 **내 PC에서, 내 계정/키로** 실행되는 `claude -p`에게 갑니다. `/chat` 으로 일반 대화창에 돌아옵니다.
  - 인증: 이 터미널의 `claude` 로그인 계정, 또는 `ANTHROPIC_API_KEY` 환경변수.
  - 도구 호출 로그·답변·사용량 전부 나만 봅니다. 방에는 아무것도 나가지 않습니다.
  - 일반 대화창에서 `@claude` 라고 써도 에이전트는 실행되지 않습니다(안내만 표시).
- 기본 권한은 **읽기 전용**(`Read,Grep,Glob`)이며, `--cwd` 폴더(기본: 현재 폴더) 밖은 읽지 못합니다. 사용자 설정·MCP 서버는 불러오지 않습니다.
  프롬프트에는 **내 입력만** 들어갑니다 — 방의 다른 사람이 쓴 글은 에이전트에게 전달되지 않습니다.
- 실행 중 `Esc`(또는 Ctrl+C)로 중단, `/agent`로 상태·작업 폴더·모델 변경, `/agent reset`으로 대화 기억 초기화.
- 웹/앱 화면의 `claude.cli` 탭은 같은 기기 키를 가진 **내 CLI 대화창을 함께 보여주는 거울**입니다. 입력과 실행은 터미널에서만 합니다.

## 서버만 실행 (브라우저용)

```bash
npm start            # 기본 포트 3000
PORT=8080 npm start  # 포트 변경
```

실행하면 터미널에 `같은 네트워크: http://<내 IP>:<포트>` 주소가 표시됩니다. 같은 Wi-Fi의 다른 기기에서 이 주소로 접속하면 됩니다.
macOS에서 처음 실행할 때 "들어오는 연결 허용" 창이 뜨면 허용해야 다른 기기에서 접속할 수 있습니다.

## 명령어

| 명령어 | 설명 |
| --- | --- |
| `/help` | 명령어 목록 |
| `/nick <이름>` | 닉네임 변경 |
| `/join <채널>` | 채널 열기/생성 |
| `/leave` | 현재 탭 닫기 |
| `/who` | 접속자 목록 |
| `/me <행동>` | 행동 메시지 |
| `/clear` | 내 화면 지우기 |
| `/cli` | 내 CLI 대화창 열기 (나만 보임) |
| `/chat` | 일반 대화창으로 돌아가기 (터미널) |
| `/agent` | 에이전트 상태·작업 폴더·모델·중단 (터미널) |

메시지에서 `` `코드` ``, ```` ``` ```` 코드 블록, `@멘션`, URL 링크를 지원합니다.

## 구조

- `server.js` — Node `http` + Server-Sent Events 서버 (수신: `GET /events`, 송신: `POST /send`). `start()`/`stop()`으로 앱에서 내장 실행
- `agent.js` — 로컬 `claude -p` 실행기 (stream-json → 도구 로그/답변 이벤트)
- `cli.js` — 터미널 클라이언트 (방 검색, 일반 대화창 / 내 CLI 대화창, 본인 키로 에이전트 실행)
- `app/` — Electron 메인 프로세스, 런처(방 만들기/참가), LAN 자동 검색
- `public/` — VS Code 형태의 UI (`index.html`, `style.css`, `app.js`)

## 내려받기

설치 파일입니다. 아래 링크는 **항상 최신 버전**을 내려받습니다.

| 운영체제 | 내려받기 |
| --- | --- |
| **Windows** (10/11, 64비트) | [LAN-Chat-Windows-x64.exe](https://github.com/jh3779/view-vscode-in-chat/releases/latest/download/LAN-Chat-Windows-x64.exe) |
| **macOS** (M1 이후, Apple Silicon) | [LAN-Chat-macOS-arm64.dmg](https://github.com/jh3779/view-vscode-in-chat/releases/latest/download/LAN-Chat-macOS-arm64.dmg) |
| **macOS** (2020년 이전, Intel) | [LAN-Chat-macOS-x64.dmg](https://github.com/jh3779/view-vscode-in-chat/releases/latest/download/LAN-Chat-macOS-x64.dmg) |
| **Linux** (64비트) | [LAN-Chat-Linux-x86_64.AppImage](https://github.com/jh3779/view-vscode-in-chat/releases/latest/download/LAN-Chat-Linux-x86_64.AppImage) |

어떤 Mac인지 모르겠다면 화면 왼쪽 위 사과 메뉴 → **이 Mac에 관하여**에서 칩이 `Apple M...` 이면 Apple Silicon, `Intel` 이면 Intel입니다.

지난 버전은 [릴리즈 목록](https://github.com/jh3779/view-vscode-in-chat/releases)에 있습니다.

### 처음 실행할 때

코드 서명이 없어 경고가 뜹니다.

- **Windows**: "Windows에서 PC를 보호했습니다" → **추가 정보** → **실행**
- **macOS**: 앱 우클릭 → **열기** → 다시 **열기**. 그래도 막히면 터미널에서 `xattr -dr com.apple.quarantine "/Applications/LAN Chat.app"`

이어서 운영체제가 로컬 네트워크 접근과 들어오는 연결을 허용할지 묻습니다. **둘 다 허용해야** 방을 열고 찾을 수 있습니다.

## 데스크톱 앱 (Electron)

```bash
npm install
npm run app        # 개발 실행
npm run dist:mac   # macOS dmg 빌드 (dist/)
npm run dist:win   # Windows 설치 파일 빌드
```

- **새 방 열기**: 앱 안에서 채팅 서버를 시작합니다(3000번, 사용 중이면 다음 포트로 자동 변경). UDP 41234 포트로 LAN에 방을 알립니다.
- **방 참가**: 같은 네트워크의 방이 자동으로 목록에 뜹니다. 안 뜨면 `IP:포트`를 직접 입력하세요.
- 방장이 채팅 창을 닫으면 서버도 종료되고 런처로 돌아갑니다.
- 앱이 없는 사람은 브라우저로 `http://<방장 IP>:<포트>`에 접속하면 됩니다.

## 터미널 클라이언트 + 에이전트 (`cli.js`)

```bash
node cli.js                       # 같은 네트워크의 방 자동 검색
node cli.js 172.30.1.86:3001      # 주소 직접 지정
node cli.js <주소> --cwd ~/project --model sonnet
```

- 터미널에서 방에 참가해 대화합니다.
- `/cli` 를 치면 **내 CLI 대화창**으로 들어갑니다. 여기 입력하는 모든 문장이 **내 PC에서, 내 계정/키로** 실행되는 `claude -p`에게 갑니다. `/chat` 으로 일반 대화창에 돌아옵니다.
  - 인증: 이 터미널의 `claude` 로그인 계정, 또는 `ANTHROPIC_API_KEY` 환경변수.
  - 도구 호출 로그·답변·사용량 전부 나만 봅니다. 방에는 아무것도 나가지 않습니다.
  - 일반 대화창에서 `@claude` 라고 써도 에이전트는 실행되지 않습니다(안내만 표시).
- 기본 권한은 **읽기 전용**(`Read,Grep,Glob`)이며, `--cwd` 폴더(기본: 현재 폴더) 밖은 읽지 못합니다. 사용자 설정·MCP 서버는 불러오지 않습니다.
  프롬프트에는 **내 입력만** 들어갑니다 — 방의 다른 사람이 쓴 글은 에이전트에게 전달되지 않습니다.
- 실행 중 `Esc`(또는 Ctrl+C)로 중단, `/agent`로 상태·작업 폴더·모델 변경, `/agent reset`으로 대화 기억 초기화.
- 웹/앱 화면의 `claude.cli` 탭은 같은 기기 키를 가진 **내 CLI 대화창을 함께 보여주는 거울**입니다. 입력과 실행은 터미널에서만 합니다.

## 서버만 실행 (브라우저용)

```bash
npm start            # 기본 포트 3000
PORT=8080 npm start  # 포트 변경
```

실행하면 터미널에 `같은 네트워크: http://<내 IP>:<포트>` 주소가 표시됩니다. 같은 Wi-Fi의 다른 기기에서 이 주소로 접속하면 됩니다.
macOS에서 처음 실행할 때 "들어오는 연결 허용" 창이 뜨면 허용해야 다른 기기에서 접속할 수 있습니다.

## 명령어

| 명령어 | 설명 |
| --- | --- |
| `/help` | 명령어 목록 |
| `/nick <이름>` | 닉네임 변경 |
| `/join <채널>` | 채널 열기/생성 |
| `/leave` | 현재 탭 닫기 |
| `/who` | 접속자 목록 |
| `/me <행동>` | 행동 메시지 |
| `/clear` | 내 화면 지우기 |
| `/cli` | 내 CLI 대화창 열기 (나만 보임) |
| `/chat` | 일반 대화창으로 돌아가기 (터미널) |
| `/agent` | 에이전트 상태·작업 폴더·모델·중단 (터미널) |

메시지에서 `` `코드` ``, ```` ``` ```` 코드 블록, `@멘션`, URL 링크를 지원합니다.

## 구조

- `server.js` — Node `http` + Server-Sent Events 서버 (수신: `GET /events`, 송신: `POST /send`). `start()`/`stop()`으로 앱에서 내장 실행
- `agent.js` — 로컬 `claude -p` 실행기 (stream-json → 도구 로그/답변 이벤트)
- `cli.js` — 터미널 클라이언트 (방 검색, 일반 대화창 / 내 CLI 대화창, 본인 키로 에이전트 실행)
- `app/` — Electron 메인 프로세스, 런처(방 만들기/참가), LAN 자동 검색
- `public/` — VS Code 형태의 UI (`index.html`, `style.css`, `app.js`)

## 내려받아 쓰기

설치 파일은 [릴리즈 페이지](https://github.com/jh3779/view-vscode-in-chat/releases/latest)에 있습니다 (macOS `.dmg`, Windows `.exe`, Linux `.AppImage`).
코드 서명이 없어 첫 실행 때 경고가 뜹니다 — macOS는 우클릭 → 열기, Windows는 추가 정보 → 실행으로 진행하세요.

## 터미널과 화면 연결하기 (페어링)

`claude.cli` 탭은 **같은 연결 키**를 가진 터미널의 대화를 함께 보여줍니다. 브라우저/앱과 터미널은 각자 키를 갖기 때문에, 처음 한 번 맞춰 줘야 합니다.

1. 앱이나 브라우저에서 `claude.cli` 탭을 엽니다. 실행할 명령이 키까지 포함해 그대로 표시됩니다.
   ```
   node cli.js 172.30.1.86:3000 --key <표시된 키>
   ```
2. 그 명령으로 터미널을 띄우면 연결됩니다. 이후에는 양쪽 모두 키를 기억하므로 다시 맞출 필요가 없습니다.

반대 방향도 됩니다. 터미널에서 `/key` 로 키를 확인한 뒤, 화면에서 `/key <값>` 을 입력하면 화면이 터미널 쪽 키를 따라갑니다.

`--key` 없이 실행하면 터미널이 자기 키를 따로 만들어 **화면과 연결되지 않습니다**(터미널 자체는 정상 동작합니다).

## 테스트

```bash
npm test     # node --test, 외부 의존성 없음
```

서버 계약과 보안 경계(CLI 대화창 격리, 전송 제한, 경로 차단 등)를 회귀 테스트로 고정해 두었습니다.
`main` 브랜치와 모든 PR에서 GitHub Actions 가 Node 20·22 로 실행합니다.

## 보안 범위

이 프로그램은 **신뢰할 수 있는 사설 네트워크(집·사무실 Wi-Fi)** 를 전제로 합니다. 인터넷에 직접 노출하지 마세요.

지켜지는 것

- CLI 대화창은 기기 저장 키를 가진 연결에만 전달됩니다. 다른 참가자는 SSE에 직접 붙어도 받지 못하고, 접속 시 받는 초기 데이터에도 포함되지 않습니다.
- 에이전트는 요청한 사람의 PC에서 그 사람의 계정으로만 실행됩니다. 남을 대신해 실행하는 경로가 없습니다.
- 에이전트 프롬프트에는 본인 입력만 들어갑니다. 다른 참가자의 채팅이 에이전트 지시로 흘러드는 경로가 없습니다.
- 에이전트 기본 권한은 읽기 전용이며 작업 폴더 밖은 읽지 못합니다.
- 종류별 전송 제한이 요청 처리 입구에서 일괄 적용됩니다. 정책에 등록되지 않은 요청 종류는 거부됩니다.

지켜지지 않는 것 (알려진 한계)

- **접속 인증이 없습니다.** 주소를 아는 사람은 누구나 방의 일반 대화에 들어올 수 있습니다.
- **통신이 평문(HTTP)입니다.** 같은 네트워크에서 패킷을 들여다볼 수 있는 상대에게는 CLI 대화창 키를 포함해 내용이 노출될 수 있습니다.
- **방 검색(UDP 브로드캐스트)에 인증이 없습니다.** 같은 네트워크의 다른 기기가 방 이름을 사칭해 광고할 수 있으니, 처음 보는 방은 주소를 확인하고 들어가세요.
- 대화 기록은 서버 메모리에만 남고(채널당 200건) 서버를 재시작하면 사라집니다.

## 라이선스

MIT — [LICENSE](LICENSE) 참고.
