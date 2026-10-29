# Kiro Internal — Paseo + Kiro HTTP

Windows x64용 **오프라인 설치 패키지**입니다. 경로는 `Paseo 웹 UI → Kiro HTTP 플러그인 → Kiro 서비스`입니다. **OMP·WezTerm·Kiro CLI·Claude CLI는 필요하지 않으며 배포하지 않습니다.** `omp-kiro`는 재사용하는 플러그인 프로젝트 이름이지 OMP 실행 파일 의존성을 뜻하지 않습니다.

Paseo는 공개 npm 패키지만 사용하는 대신 **[사용자 포크 `emotionbug/paseo@c3bac24`](https://github.com/emotionbug/paseo/commit/c3bac24ccc2df8dcc67d807c805db0efa0817dff)의 서버·CLI·관련 workspace·웹 UI를 함께 빌드**합니다. 세션 중심 탐색, diff 초기 표시/스크롤 최적화, 브라우저 자동화 지연 시작 변경을 포함합니다. 포크의 내부 버전 표시는 0.13.0이며, 실제 소스 커밋은 `doctor.cmd`와 `bundle-manifest.json.paseoFork`에서 확인합니다. 로컬 사용자 저장소의 변경이나 실행 중인 Paseo를 수정·재시작하지 않습니다.

> 설치·기동에는 외부 다운로드가 필요하지 않습니다. 로그인·목록·사용량·검색·응답 생성에는 Kiro/인증 서비스로 연결되는 승인된 HTTPS 프록시·게이트웨이가 필요합니다. 그 경로까지 차단된 완전 망 분리에서는 클라우드 기능을 사용할 수 없습니다. 검색 대상 웹사이트에는 PC가 직접 접속하지 않고 Kiro 서버에 검색을 맡깁니다.

## 다운로드와 실행

[Paseo + Kiro HTTP 0.5.0 ZIP·SHA-256·검증 보고서](https://github.com/emotionbug/kiro-cli-internal/releases/tag/v0.5.0)

1. ZIP 전체를 **새 로컬 폴더**(예: `C:\KiroOffline`)에 풉니다. GitHub의 `Source code.zip`은 실행 패키지가 아닙니다.
2. `setup.cmd`를 실행하여 동봉 플러그인의 비샌드박스 실행을 검토·승인하고 개인 Paseo 비밀번호를 정합니다.
3. `auth.cmd login`으로 로그인합니다. device 인증 링크는 다른 승인된 브라우저/기기에서 열어도 됩니다.
4. `start.cmd`를 실행합니다. 기존 승인된 최신 Edge/Chrome에서 `http://127.0.0.1:16767`을 열고 첫 화면의 **Direct connection**에서 `127.0.0.1:16767` 서버를 등록한 뒤 개인 비밀번호로 접속합니다.
5. **Kiro HTTP** 제공자로 새 세션을 만듭니다. 모델은 실제 로그인 계정의 메타데이터만 사용합니다.
6. 종료는 `stop.cmd`입니다. 전용 데몬만 종료하며 일반 Paseo의 6767 포트나 다른 OMP/Paseo 프로세스는 중지하지 않습니다.

기본 수신은 `127.0.0.1:16767` 로컬 전용입니다. 패키지가 전달한 데몬 주소가 비밀번호를 요구하거나 연결에 실패해도 다른 `localhost:6767` 인스턴스로 대신 연결하지 않습니다.

```bat
auth.cmd login --provider google
auth.cmd login --provider github
auth.cmd login --provider builder-id
auth.cmd login --provider identity-center --start-url https://YOUR-ORGANIZATION.awsapps.com/start
auth.cmd status
models.cmd
usage.cmd
doctor.cmd --verify-all
```

이미 CLI social 로그인을 가진 경우에만 `auth.cmd import-cli`로 선택적으로 가져올 수 있습니다. 원본은 호출 사용자의 홈 아래 `.local\share\kiro-cli\data.sqlite3`이며 `--database C:\Path\data.sqlite3`로 지정할 수도 있습니다. 원본 DB는 읽기 전용이나 refresh token의 회전·폐기는 원래 세션과 공유될 수 있으므로 독립적인 `auth.cmd login`을 권장합니다. 이 기능은 Kiro CLI를 설치하거나 실행하지 않습니다.

### 모델·사용량·도구

`models.cmd`는 계정에 결합된 실제 모델 스냅샷과 Paseo 카탈로그를 갱신합니다. 시작 시 스냅샷을 사용하므로 일시적인 목록 조회 실패로 선택 모델을 지우거나 다른 모델로 바꾸지 않습니다. 임의 모델을 만들어 넣거나 생성 요청으로 모델을 추측하지 않습니다. 모델 ID는 계정의 원래 ID이며 OMP용 `kiro-http/` 접두어를 붙이지 않습니다. 갱신한 목록은 새 세션에 반영합니다.

계정 변경은 이전 스냅샷을 무효화합니다. 프로필 ARN 없는 인증에서 refresh token이 회전한 경우에도 `models.cmd`로 결합을 갱신해야 합니다. 인증된 비어 있지 않은 스냅샷 없이 기본 제공자를 활성화하지 않습니다. 사용량은 계정 할당량이며 개별 세션의 토큰 소비량이 아닙니다.

**기본 도구 정책은 사용자가 선택한 Full access**입니다. 파일 수정·삭제·명령 실행을 건별 승인 없이 사용자 권한으로 수행합니다. 최초 플러그인 신뢰·로그인은 별도이며 명시적으로 선택한 Ask/Plan은 유지합니다. 모델에 도구 선택이나 Python 사용 제한 지침을 추가하지 않습니다.

### 폐쇄망의 웹 검색

기본 `web_search`는 별도 검색 API 키 없이 **같은 Kiro 인증으로 `runtime.<region>.kiro.dev/mcp`에 요청**합니다. 인터넷 검색은 Kiro 서버가 수행합니다. PC는 반환된 출처 URL을 자동으로 열거나 본문을 다운로드하지 않으며 Exa·Brave 등 외부 검색 서비스로 fallback하지 않습니다.

출처·인용 ID·`maxVerbatimWordLimit` 같은 재현 제한을 보존합니다. 검색 결과/발췌이지 전체 페이지 본문 도구가 아닙니다. 실제 계정의 원격 도구 목록에는 `web_search`만 있었으므로 `web_fetch`를 지원한다고 가정하지 않습니다.

[실제 Kiro 검색 관측 발췌](releases/0.4.0/kiro-web-search-observation.json)에서 검색 10건과 출처/재현 제한을 확인했습니다. 이 기존 관측은 대상 회사망 연결이나 사용량 한도가 소진된 계정의 응답 생성을 검증한 것이 아닙니다.

### 연결 단절과 재시도

- 인터넷·DNS·소켓 단절과 일시적 HTTP 오류는 사용자 취소 전까지 **30초 고정 주기**로 재시도합니다. 서버의 더 긴 `Retry-After`는 지킵니다.
- 선택 모델과 대화 ID를 유지합니다. 이미 표시한 텍스트를 모델 문맥에 한 번 보존하고 이어받으므로 Paseo의 추가형 스트림에서 임시 텍스트를 지우거나 중복해서 붙이지 않습니다. 도구는 완전하고 유효한 응답 이후 실행하며 완료된 도구 결과를 유지하고 자동 재시도로 도구를 처음부터 재실행하지 않습니다.
- Paseo 웹 연결도 첫 시도부터 30초 주기로 연결·구독·내역을 복구합니다. **수락 여부가 불명확한 프롬프트는 자동 재전송하지 않습니다.**
- 잘못된 인증·권한·인증서·할당량·프로토콜 오류는 무한 재시도로 숨기지 않습니다. OAuth 일회용 교환/refresh는 성공 여부를 모르는 응답 유실을 무조건 재전송하지 않습니다.
- 서비스에 도착한 생성 요청은 응답이 유실돼도 과금될 수 있습니다. 클라우드의 exactly-once/idempotency를 보장하지 않습니다.

### 내부망·PAC·인증

```bat
network.cmd
network.cmd --mode system
network.cmd --mode manual --proxy http://PROXY-HOST:8080
network.cmd --mode manual --pac C:\ApprovedConfig\proxy.pac
network.cmd --mode direct
network.cmd --mode system --ca C:\ApprovedConfig\company-root.pem
```

네트워크 변경 전에는 이 데몬을 중지합니다. 기본값은 현재 Windows 사용자의 시스템/PAC 설정입니다. 주소·계정은 배포물에 미리 넣지 않습니다. 프록시 URL에 사용자명/비밀번호를 넣지 않으며 upstream 인증은 현재 Windows 사용자의 SSPI Negotiate/NTLM을 사용합니다. TLS/호스트명 검증을 유지하며 시스템 프록시·인증서 저장소는 변경하지 않습니다.

**내부망은 차단하지 않습니다.** 시스템/PAC 모드는 목적지별 DIRECT/프록시와 Windows 시스템 프록시의 내부 주소 예외를 사용합니다. 내부 API·Git·MCP를 Kiro 도메인으로 제한하지 않습니다. 수동 고정 프록시는 내부 주소도 그 프록시를 경유하므로 내부망 예외가 필요하면 시스템/PAC 모드를 사용하세요. 승인된 사설 CA를 추가할 수 있습니다.

지원 범위는 HTTP upstream, HTTP/CONNECT, Windows 시스템 설정, HTTP(S)/로컬 파일 PAC입니다. PAC 오류를 DIRECT로 숨기지 않으며 SOCKS·HTTPS upstream·두 번째 프록시로 자동 failover는 제공하지 않습니다. PAC 파일 서버에는 인증을 위임하지 않으므로 인증이 필요한 경우 승인된 로컬 PAC 파일을 사용하세요. HTTPS CONNECT의 PAC는 전체 암호화 경로가 아닌 호스트/포트 기준입니다.

승인 검토의 시작 목록은 `prod.us-east-1.auth.desktop.kiro.dev`, `runtime.us-east-1.kiro.dev`, `management.us-east-1.kiro.dev`이며 계정에 따라 `eu-central-1` runtime/management를 사용합니다. Builder ID/Identity Center는 지정 region의 `oidc.<region>.amazonaws.com`도 사용합니다. 브라우저는 `app.kiro.dev`, `view.awsapps.com`/조직 AWS SSO 및 선택한 Google/GitHub/기업 IdP 리디렉션이 필요할 수 있습니다. 모든 IdP를 포괄하는 허용목록은 아닙니다.

HOME/USERPROFILE은 호출 사용자의 원래 값을 유지하므로 기존 Git/SSH 설정을 사용할 수 있습니다. Paseo home·인증·모델 스냅샷은 `%LOCALAPPDATA%\KiroInternal`의 명시적인 전용 경로에 저장하고 사용자+SYSTEM ACL로 보호합니다. 다른 경로는 각 명령에 동일한 `--data-dir 절대경로`를 지정하세요. 인증 SQLite나 사용한 데이터 폴더를 재배포하지 마세요.

네이티브 대화 기록은 같은 전용 데이터 폴더의 `.local\state\omp-kiro\paseo`에 저장합니다. `XDG_STATE_HOME`만 개인 경로로 고정하므로 HOME을 바꾸지 않고도 기록이 다른 설치와 섞이는 것을 방지합니다.

실제 회사 내부 주소·PAC·SSPI·AppLocker/WDAC·서명 정책은 현장 승인이 필요합니다. CI에서 외부망을 막기 위한 브라우저 플래그는 배포 실행기에 넣지 않습니다.

### 동봉 유틸리티와 메모리

Python 3.13.12 표준 라이브러리(`python.exe`·`python3.exe`), ripgrep 15.1.0, jq 1.8.1 및 **전체 Git Bash**를 유지합니다. 런처가 시작한 도구에만 PATH를 전달하며 시스템 PATH는 변경하지 않습니다. 활성 프로젝트 virtualenv/Conda는 동봉 Python보다 우선합니다.

Python은 격리된 표준 라이브러리 유틸 용도이며 pip·ensurepip·Tk·과학 계산 패키지·완전한 개발 환경은 포함하지 않습니다. 현재 폴더/스크립트 옆 모듈은 자동 import하지 않습니다. 표준 입출력은 UTF-8이며 일반 파일은 `encoding="utf-8"`을 명시하세요. `-S`는 입출력 사용자 설정도 건너뜁니다. 범위·출처·변경 고지는 `manifests/utilities.json`과 `LICENSES/UTILITY-CHANGES.txt`에 있습니다.

- PAC는 Python/Px 대신 WinHTTP·SSPI 네이티브 helper 한 개를 재사용합니다. worker 8개·대기 16개·버퍼 방향별 16 KiB·경로 캐시 32개/60초이며 직접 연결 모드에는 helper가 없습니다.
- 네이티브 helper의 idle/warm private bytes와 working set 각각 32 MiB 기준을 Windows 빌드에서 확인합니다. 전체 앱이나 공유 Windows PAC 서비스의 상한이 아닙니다.
- OMP·외부 터미널·다른 에이전트 CLI·로컬 음성 런타임/모델·Electron/브라우저 엔진을 배포하지 않습니다. Paseo 자체 기능에 필요한 PTY·플러그인 변환기는 유지합니다.
- owned Node 자식의 V8 old-space 기본 상한은 프로세스당 256 MiB이며 RSS/전체 메모리/브라우저 상한이 아닙니다. 여러 에이전트를 동시에 열면 추가 메모리를 사용합니다.

### 이전 배포에서 이동

0.4.0 위에 덮어 풀지 말고 새 폴더에 풉니다. 기존 전용 데몬을 중지한 뒤 새 실행기로 시작하세요. 기존 OMP 프로필/실행기를 제공하지 않으며 OMP 세션을 native HTTP 세션으로 자동 변환하지 않습니다. 그 세션의 재개가 필요하면 [이전 0.4.0 배포본](https://github.com/emotionbug/kiro-cli-internal/releases/tag/v0.4.0)을 보관하세요. 기존 대화 파일이나 다른 프로그램의 OMP/Paseo는 삭제하지 않습니다.

### 재현·검증

정확한 버전·SHA/SRI·라이선스는 `build/inputs.json`, `payload/app/package-lock.json`, ZIP의 `LICENSES/`와 `bundle-manifest.json`에 있습니다. Node 22.23.4, Paseo 사용자 포크 `c3bac24ccc2df8dcc67d807c805db0efa0817dff`, HTTP 플러그인 0.4.6을 고정합니다. 포크 소스 아카이브 SHA-256은 `f2351ac409c8fe5228636b0d587b7a9d992ffe276400d1cfb3e40b1a7f4b79ff`입니다. 공개 npm 의존성 잠금과 포크 빌드 산출물의 해시·투영을 별도로 기록합니다. 대상 PC에는 npm/컴파일러 설치가 필요하지 않습니다.

```sh
# 인터넷 사용이 허용된 Ubuntu 빌드 PC
node build/build-paseo-fork.mjs --output /tmp/paseo-fork --cache /tmp/paseo-cache
```

그 결과 폴더 전체를 승인된 Windows 빌드 PC의 `C:\Build\paseo-fork`로 옮긴 뒤 실행합니다.

```powershell
# Windows x64 MSVC Developer Command 환경
node build/build-bundle.mjs --output C:\Build\kiro-paseo-http-0.5.0-windows-x64 --paseo-fork C:\Build\paseo-fork
node test/windows-smoke.mjs C:\Build\kiro-paseo-http-0.5.0-windows-x64 C:\Build\qualification
```

[Windows 워크플로](.github/workflows/portable-windows.yml)는 빌드와 실제 ZIP 검증을 분리합니다. 같은 실행에서 검증 작업만 실패하면 빌드를 반복하지 않고 해당 작업을 다시 실행할 수 있습니다. 제어된 upstream 검사는 실제 Kiro 클라우드 응답 증거가 아니며 알려진 계정 사용량 한도 때문에 실서비스 추론을 다시 요청하지 않습니다.

[릴리스 승격](.github/workflows/publish-qualified-release.yml)은 성공한 main 검증 실행의 기존 ZIP을 재사용합니다. ZIP SHA-256, 모든 내부 파일의 크기·SHA-256, manifest 일치와 직접 HTTP 전용 구성을 확인하고 검증 소스 커밋에 태그를 묶습니다. 업로드된 Release 자산의 서버 digest까지 맞춘 뒤 공개하며 다시 빌드하거나 이전 Release를 덮어쓰지 않습니다.

Release의 `report.json`, `reconnect.json`, `utilities.json`, `bundle-manifest.json`, `web-ui.png`, `release-verification.json`이 해당 배포의 검증 범위와 실측입니다. 프로세스별 working set 합은 공유 페이지를 중복 셀 수 있으며 고유 물리 메모리나 상한이 아닙니다.

[Windows Server 2022 최종 검증](https://github.com/emotionbug/kiro-cli-internal/actions/runs/40813785340)을 통과했습니다. 실제 native Full access 파일 쓰기, Kiro 검색·인용·사용량, 모델 고정, 30초 복구 두 경로, Windows 경로 별칭, 개인 대화 기록, 수락/확인 유실 요청의 재접속·중복 방지, 실제 브라우저 큐 함수, 전용 종료와 전체 파일 무결성을 확인했습니다. [컴포넌트 Node 22/24·실제 HTTP continuation 회귀 검사](https://github.com/emotionbug/omp-kiro/actions/runs/40813782567)도 통과했습니다.

완료 에이전트 1개·2초 idle에서 브라우저를 제외한 스택의 working set/private bytes 합은 약 **517/516 MiB**였습니다. 이전 0.4.0의 해당 단계는 약 827/940 MiB였습니다. 별도 CI 관측 비교이며 공유 페이지 중복·동시 에이전트·브라우저 메모리·실제 작업에 따라 달라집니다. 메모리 상한이나 일반 성능 보장은 아닙니다.

**Server 2019/build 17763은 목표 환경이지 실행 검증 완료 환경이 아닙니다.** `server2019Verified:false`를 유지합니다. 실제 회사 네트워크와 인증 후 브라우저 상호작용은 별도 검증이 필요합니다.

관련 출처: [Node 기업망 TLS](https://nodejs.org/learn/http/enterprise-network-configuration), [WinHTTP PAC](https://learn.microsoft.com/en-us/windows/win32/api/winhttp/nf-winhttp-winhttpgetproxyforurl), [SSPI](https://learn.microsoft.com/en-us/windows/win32/secauthn/sspi), [HTTP 플러그인 소스](https://github.com/emotionbug/omp-kiro).

---

## 기존 Kiro CLI 2.22.0 실험용 패키지

Kiro CLI 2.22.0, WezTerm, 목적지별 PAC 프록시를 포함한 Windows x64 포터블 배포판입니다. 새 TUI, V2 엔진, trust-all을 기본으로 사용합니다.

## 다운로드와 실행

[배포 ZIP 다운로드](https://github.com/emotionbug/kiro-cli-internal/raw/refs/heads/main/releases/2.22.0/kiro-terminal-2.22.0-hv2019-experimental.zip) · 417.3 MiB

1. ZIP 전체를 새 폴더에 압축 해제합니다.
2. `kiro-terminal.cmd`를 실행합니다.
3. 로그인이 필요하면 `kiro-terminal.cmd login`을 실행합니다.

기존 대화 재개는 `kiro-terminal.cmd chat --resume`, 기존 UI 사용은 `kiro-terminal.cmd chat --classic`입니다. 도구 실행의 자동 승인을 해제하려면 `kiro-terminal.cmd chat --trust-tools=`을 사용합니다.

프로젝트 폴더에서 런처를 전체 경로로 실행하면 해당 작업 폴더를 유지합니다. Kiro가 Ctrl+C로 작업을 취소한 뒤 계속 실행 중이면 프록시도 유지되며, Kiro가 종료되면 해당 세션의 프록시를 정리합니다.

## 구성과 검증 범위

- Kiro CLI 2.22.0 공식 서명 EXE, WezTerm 20240203-110809-5046fc22, Px 0.11.0
- 새 TUI + V2 엔진 + `--trust-all-tools` 기본값
- WezTerm Software 렌더링, Kiro/WezTerm 자동 업데이트 비활성화
- DXCore/DirectML 호환 DLL 및 Microsoft VC Runtime 포함

Server 2019 / Windows build 17763 지원을 목표로 한 **실험용** 구성입니다. 호환 DLL은 GPU 기능을 구현하지 않습니다. 로컬에서 파일 무결성, CLI 버전·옵션, PAC 라우팅, Ctrl+C 프록시 유지 및 동시 세션을 검증했습니다. 실제 Server 2019 실행, 회사 프록시 인증, Kiro 모델 응답과 화면 성능은 미검증입니다.

로그인은 각 사용자가 진행합니다. 실행 시 해당 사용자의 Windows/PAC 설정을 읽으며, 환경별 주소와 계정 정보를 배포 파일에 미리 설정하지 않습니다. 자세한 내용은 ZIP의 `README.txt`와 `PAC-README.txt`를 참조하세요.

## 파일 무결성과 Git LFS

[SHA-256 파일](releases/2.22.0/kiro-terminal-2.22.0-hv2019-experimental.zip.sha256)

```text
272d612183829325a79eec0e31f380d120c07d1bfe0ae40c89eb7f07db0e20d0
```

기존 CLI 2.22.0 ZIP은 Git LFS로 저장합니다. 새 HTTP 패키지는 GitHub Releases에 첨부합니다. 기존 LFS 배포물을 저장소 복제로 받을 때는 Git LFS가 필요합니다.

```powershell
git clone https://github.com/emotionbug/kiro-cli-internal.git
cd kiro-cli-internal
git lfs pull
```

직접 다운로드 링크는 실제 ZIP을 제공합니다. GitHub의 자동 생성 Source code ZIP에는 LFS 포인터만 포함될 수 있으므로 위 배포 ZIP 링크를 사용하세요.

## 출처

[Kiro CLI 2.22.0](https://kiro.dev/changelog/cli/2-22/) · [WezTerm](https://github.com/wezterm/wezterm/releases/tag/20240203-110809-5046fc22) · [Px](https://github.com/genotrance/px/releases/tag/v0.11.0)

각 구성요소의 라이선스와 고지는 배포 ZIP에 포함된 파일 및 원본 배포처를 따릅니다.
