# Kiro Internal — Paseo + OMP + Kiro HTTP

Windows x64용 **오프라인 설치 패키지**입니다. 기본 경로는 `Paseo 웹 UI → OMP → omp-kiro HTTP → Kiro 서비스`이며, Kiro CLI 실행 파일이나 CLI 로그인 DB가 필요하지 않습니다.

> 설치·기동에는 외부 다운로드가 필요하지 않습니다. **검색 대상 웹사이트에 PC가 직접 접속하지 않고 Kiro 서버에 검색을 맡깁니다.** 로그인·목록·사용량·검색·응답 생성에는 Kiro/인증 서비스로 연결되는 승인된 HTTPS 프록시·게이트웨이가 필요합니다. 그 경로까지 차단된 완전한 망 분리에서는 클라우드 기능을 사용할 수 없습니다. 기본값은 현재 Windows 사용자의 PAC/프록시 설정입니다.

## 새 HTTP 패키지

[v0.4.0 배포 ZIP 및 SHA-256](https://github.com/emotionbug/kiro-cli-internal/releases/tag/v0.4.0)

1. 배포 ZIP 전체를 **새 로컬 폴더**(예: `C:\KiroOffline`)에 풉니다. GitHub의 `Source code.zip`은 실행 패키지가 아닙니다.
2. `setup.cmd`를 실행하여 동봉 플러그인의 비샌드박스 실행을 검토·승인하고 개인 Paseo 비밀번호를 정합니다.
3. `auth.cmd login`으로 Kiro 계정에 로그인합니다. 기본 device 흐름은 표시된 링크를 다른 승인된 브라우저/기기에서 열어도 됩니다.
4. `start.cmd`를 실행합니다. 기존 승인된 최신 Edge/Chrome에서 `http://127.0.0.1:16767`을 엽니다. 첫 화면의 **Direct connection**에서 `127.0.0.1:16767` 서버를 등록하고 설정한 개인 비밀번호로 접속합니다. IE는 지원하지 않습니다.
5. `Kiro HTTP (OMP)` 프로필을 선택합니다. 모델은 로그인한 계정의 메타데이터에서만 채워집니다.
6. 종료할 때 `stop.cmd`를 실행합니다. 일반 Paseo의 6767 포트나 다른 사용자의 데몬은 중지하지 않습니다.

이 패키지가 브라우저에 전달한 데몬 주소는 비밀번호가 필요하거나 일시 연결 실패가 나도 유지합니다. 다른 `localhost:6767` 인스턴스를 대신 자동 탐색하지 않습니다. Paseo 서버 자체는 기본 `127.0.0.1:16767` 로컬 전용이며 다른 PC로 수신 포트를 열지 않습니다.

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

선택적으로 `auth.cmd import-cli`로 기존 CLI의 social 로그인을 읽기 전용으로 가져올 수 있습니다. 기본 원본은 **호출한 사용자의 원래 홈** 아래 `.local\share\kiro-cli\data.sqlite3`이며, 격리된 OMP 홈이 아닙니다. 다른 위치는 `auth.cmd import-cli --database C:\Path\data.sqlite3`로 지정합니다. 원본 DB는 변경하지 않지만 refresh token의 회전·폐기는 원래 세션과 공유할 수 있으므로 독립적인 `auth.cmd login`을 권장합니다.

`models.cmd`는 실제 계정의 모델 목록을 조회하고 계정에 결합된 `models.json`과 Paseo 카탈로그를 갱신합니다. OMP/직접 HTTP 시작은 이 실제 메타데이터 스냅샷을 사용하므로 목록 재조회에 실패했다고 선택한 모델이 사라지거나 다른 모델로 바뀌지 않습니다. 모델을 만들어 넣거나 생성 요청으로 추측하지 않습니다. 갱신한 목록은 새 세션 또는 OMP 재로드에 반영합니다. 로그인 계정이 달라지면 이전 목록을 지우고 다시 가져옵니다. 프로필 ARN이 없는 인증에서 refresh token이 회전한 경우에도 `models.cmd`로 결합을 갱신해야 합니다. 다른 CLI가 설치돼 있다는 이유만으로 Claude/Codex CLI가 OMP 모델로 추가되지는 않습니다.

이 전용 패키지의 **새 OMP 설정**은 `kiro-http` 외 기본 제공자의 자동 모델 탐색을 끕니다. 외부 서비스/로컬 모델 서버의 목록 조회는 필요하지 않습니다. 고정 OMP 버전의 제공자 목록은 `app/omp-provider-roster.json`에 있으며 OMP 버전을 바꾸면 함께 검토해야 빌드됩니다. 기존 사용자 `omp/config.yml`은 덮어쓰지 않고, 다른 OMP 설치에는 적용하지 않습니다. 도구 선택이나 Python 사용을 제한하는 지침은 추가하지 않습니다.

### 폐쇄망의 웹 검색

HTTP 경로의 기본 `web_search`는 별도 검색 API 키 없이 **같은 Kiro 인증으로 `runtime.<region>.kiro.dev/mcp`에 검색을 요청**합니다. 인터넷 검색은 Kiro 서버가 수행하며, PC는 반환된 출처 URL을 자동으로 열거나 본문을 다운로드하지 않습니다. Exa·Brave 등 외부 검색 서비스로 fallback하지 않습니다. OMP 경로와 선택형 Paseo 직접 HTTP 경로 모두 이 도구를 제공합니다.

검색 결과의 출처·인용 ID·`maxVerbatimWordLimit` 같은 재현 제한을 보존합니다. 검색 결과/발췌이지 전체 페이지 본문을 가져오는 도구가 아닙니다. 실제 계정의 원격 도구 목록에는 `web_search`만 있었으며 `web_fetch`를 지원한다고 가정하지 않습니다. 다른 OMP 도구의 직접 URL 읽기는 Kiro의 본문 대행 기능이 아니므로 외부 웹 차단 환경의 대안으로 안내하지 않습니다.

[실제 Kiro 검색 관측 발췌](releases/0.4.0/kiro-web-search-observation.json): 검색 10건과 출처/재현 제한을 확인했습니다. 이 관측은 대상 회사망의 연결이나 사용량 한도가 소진된 계정의 응답 생성을 검증한 것은 아닙니다.

### 메모리와 Python

- PAC: 내장 Python/Px 대신 **WinHTTP PAC + SSPI 네이티브 프록시 한 개**를 실행기 수명 동안 재사용합니다. worker 8개, 대기 연결 16개, 스트림 버퍼 16 KiB, 경로 캐시 32개/60초로 제한합니다.
- 직접 연결 모드에는 프록시 프로세스를 띄우지 않습니다.
- 빌드는 네이티브 프록시의 idle/warm **private bytes 및 working set 각각 32 MiB 이하**를 실제 Windows에서 확인해야 통과합니다. 이 수치는 전체 Paseo/OMP/브라우저나 공유 Windows PAC 서비스의 한도가 아닙니다. 측정값은 ZIP의 `bundle-manifest.json`에 기록합니다.
- Electron과 별도 브라우저 엔진을 넣지 않습니다. WezTerm은 독립 OMP TUI를 열 때만 사용하며 Software 렌더링입니다.
- owned Node 자식의 V8 old-space 기본 상한은 프로세스당 256 MiB입니다. **RSS/전체 메모리 상한이나 Bun/OMP 힙 제한이 아닙니다.** 사용자 설정 `nodeHeapMb`로 조정할 수 있습니다.
- 로컬 음성 모델·릴레이·자동 제목 생성을 기본 비활성화합니다. Git 동시 실행은 2개로 줄입니다. 에이전트를 여러 개 열면 OMP도 여러 개 실행될 수 있으므로 사용 후 종료하세요.
- 인증·목록·사용량·프록시 및 패키지 제어에 Python을 사용하지 않습니다. 별도 유틸리티용 Python 표준 라이브러리 런타임·`rg`·`jq`는 동봉하며 필요한 명령을 호출할 때만 실행합니다. 모델의 도구 선택 지침을 추가하거나 Python 실행을 제한하지 않습니다.

### 동봉 유틸리티

Python 3.13.12 표준 라이브러리 런타임(`python.exe`·`python3.exe`), ripgrep 15.1.0, jq 1.8.1 및 Git Bash의 기존 명령 도구를 포함합니다. OMP/Paseo가 실행하는 도구에는 이 경로를 전달하며, 시스템 PATH를 변경하지 않습니다. 명시적으로 활성화한 프로젝트 virtualenv/Conda는 동봉 Python보다 우선합니다.

```bat
runtime\python\python.exe -c "import json,sqlite3,ssl; print(json.dumps({'ready': True}))"
runtime\tools\rg.exe --version
runtime\tools\jq.exe --version
```

Python은 embeddable 배포판 기반의 **표준 라이브러리 유틸 용도**입니다. pip·ensurepip·Tk·과학 계산 패키지·완전한 프로젝트 개발 환경을 포함하지 않습니다. 기본 모듈 검색은 격리돼 있어 현재 폴더/스크립트 옆 모듈을 자동 import하지 않습니다. 프로젝트 환경은 자체 virtualenv 등을 명시적으로 사용하세요. 표준 입출력은 UTF-8로 구성하지만 일반 텍스트 파일은 `encoding="utf-8"`을 명시하는 것이 안전합니다. `-S`는 입출력 사용자 설정도 건너뜁니다. 정확한 입력·변경 고지·검증은 ZIP의 `manifests/utilities.json`과 `LICENSES/UTILITY-CHANGES.txt`에 있습니다.

더 적은 메모리가 필요하면 **명시적으로** OMP 없는 `Paseo → Kiro HTTP` 경로도 선택할 수 있습니다. 이 데몬을 중지하고 전용 `paseo/config.json`의 `agents.providers["kiro-http"].enabled`를 `true`, `agents.providers["kiro-omp-http"].enabled`를 `false`로 바꾼 뒤 다시 시작하여 새 에이전트의 `Kiro HTTP` 제공자를 선택합니다. 기존 OMP 세션을 변환하거나 자동 fallback하지 않습니다. OMP 실행기는 별도로 계속 사용할 수 있습니다. 사용량 표시는 계정 할당량이며 개별 세션의 토큰 소비량과 다릅니다.

### 네트워크·인증·데이터

```bat
network.cmd
network.cmd --mode system
network.cmd --mode manual --proxy http://PROXY-HOST:8080
network.cmd --mode manual --pac C:\ApprovedConfig\proxy.pac
network.cmd --mode direct
network.cmd --mode system --ca C:\ApprovedConfig\company-root.pem
```

네트워크를 변경하기 전에 `stop.cmd`로 이 데몬을 중지합니다. 주소는 대상 PC의 사용자 데이터에만 저장되며 ZIP에 미리 넣지 않습니다. 프록시 사용자명/비밀번호를 URL에 넣지 않습니다. upstream 프록시 인증은 현재 Windows 사용자의 SSPI Negotiate/NTLM을 사용합니다. localhost·127.0.0.1·::1은 우회하고 TLS 검증은 유지합니다. Node는 Windows 신뢰 저장소를 사용하며 공개 CA 인증서를 Bun용 PEM으로 내보냅니다. 시스템 프록시/인증서 설정은 변경하지 않습니다.

**내부망은 차단하지 않습니다.** 시스템/PAC 모드는 목적지별 `DIRECT`/프록시 선택과 Windows 시스템 프록시의 내부 주소 예외를 사용합니다. 내부 API·Git·MCP를 Kiro 도메인으로 제한하지 않으며 승인된 사설 CA를 사용할 수 있습니다. 수동 고정 프록시 모드는 내부 주소도 그 프록시를 경유하므로 내부망 예외가 필요하면 시스템/PAC 모드를 사용하세요. 격리된 홈 때문에 Git/SSH의 기존 설정·인증이 자동으로 복사되지는 않습니다. CI의 외부망 차단용 브라우저 플래그는 배포 실행기에 포함하지 않습니다. 실제 회사 내부주소·PAC·SSPI 정책은 현장 검증이 필요합니다.

지원 범위는 HTTP upstream 프록시, HTTP/CONNECT, Windows 시스템 설정 및 HTTP(S)/로컬 파일 PAC입니다. PAC 오류를 임의 DIRECT로 숨기지 않습니다. SOCKS·HTTPS-to-proxy 및 PAC의 두 번째 프록시로 자동 failover는 제공하지 않습니다. PAC 파일 서버 자체에 대한 인증 위임은 하지 않으므로 그 서버가 인증을 요구하면 승인된 로컬 PAC 파일을 사용하세요.

HTTPS CONNECT의 PAC 평가는 암호화된 전체 경로가 아닌 `https://호스트:포트/`를 대상으로 합니다. HTTPS 경로별 PAC 분기가 필요한 정책은 이 구조로 보장하지 않으므로 호스트 기반 PAC 또는 승인된 명시적 프록시 구성이 필요합니다.

방화벽 승인 검토의 시작 목록은 `prod.us-east-1.auth.desktop.kiro.dev`, `runtime.us-east-1.kiro.dev`, `management.us-east-1.kiro.dev`이며 계정 프로필에 따라 `eu-central-1` runtime/management 호스트를 사용합니다. Builder ID/Identity Center는 지정 region의 `oidc.<region>.amazonaws.com`도 사용합니다. 브라우저 쪽은 `app.kiro.dev`, `view.awsapps.com`/조직 AWS SSO 및 선택한 Google/GitHub/기업 IdP 리디렉션을 승인해야 할 수 있습니다. 이 목록이 모든 IdP 리디렉션을 포괄한다는 뜻은 아닙니다.

사용자 데이터 기본 경로는 `%LOCALAPPDATA%\KiroInternal`이며 인증 SQLite·Paseo/OMP 상태·목록·설정이 ZIP 밖에 저장됩니다. 사용자와 SYSTEM만 허용하는 ACL을 생성합니다. 공용 폴더나 다른 프로그램의 비어 있지 않은 데이터 폴더를 가져오지 않습니다. 별도 사용은 각 명령에 `--data-dir 절대경로`를 일관되게 지정합니다. `auth.cmd logout`은 이 HTTP 저장소만 로그아웃합니다.

실행기가 시작한 프로세스의 `HOME`/`USERPROFILE`도 전용 데이터 폴더로 격리합니다. OMP의 `PI_CONFIG_DIR`는 home-relative 이름 `config`를 사용하므로, 다른 드라이브의 절대 데이터 경로를 홈 경로에 잘못 결합하여 `mkdir ENOENT`가 나는 경우를 피합니다. 프로젝트 작업 폴더는 유지하지만 기존 홈의 Git/SSH 설정을 자동 복사하지는 않습니다. 필요한 기존 설정은 `GIT_CONFIG_GLOBAL` 등 해당 도구의 명시적 설정으로 지정하세요.

동봉 `omp-kiro`는 **비공식 Kiro HTTP/OAuth 구현**입니다. 서비스 변경·계정 정책의 영향을 받습니다. 계정 승인은 사용자 본인이 해야 하며, 설치 과정에서 기존 CLI 인증 DB를 자동 추출하지 않습니다. 플러그인은 비샌드박스 코드이고 도구가 사용자 권한으로 파일·명령을 실행할 수 있습니다. 회사의 프록시·AppLocker/WDAC·코드 서명·서비스 이용 정책 승인이 우선입니다.

**사용자가 선택한 기본값은 Full access입니다.** Paseo의 OMP/직접 HTTP 새 세션과 독립 OMP는 파일 수정·삭제·명령 실행을 건별 승인 없이 사용자 권한으로 수행합니다. 최초 플러그인 신뢰 확인·로그인은 별도이며, 명시적으로 선택한 Ask/Plan은 유지합니다. OMP를 직접 실행할 때는 `omp.cmd --console -- --approval-mode always-ask`로 확인 모드를 선택할 수 있습니다.

### 네트워크 끊김과 재시도

- OMP와 선택형 Paseo 직접 HTTP의 네트워크 복구는 **HTTP transport가 담당**합니다. 인터넷·DNS·연결 단절과 일시적 HTTP 오류는 사용자 취소 전까지 **30초 고정 주기**로 계속 재시도합니다. 서버의 `Retry-After`가 더 길면 그 시간을 지킵니다. 패키지의 OMP 호스트 재시도는 꺼 중첩 재시도·모델 fallback을 막습니다.
- 선택 모델/provider와 대화 ID를 유지합니다. OMP에 이미 표시한 부분 텍스트는 wire 문맥에 보존하고 이어가며, 완료된 도구 결과를 continuation에 중복 복사하거나 도구를 처음부터 재실행하지 않습니다. 직접 HTTP 경로는 실패한 시도의 임시 텍스트를 같은 메시지에서 교체합니다. 도구는 완전하고 유효한 응답을 받은 뒤 실행합니다.
- Paseo 웹 재접속도 첫 시도부터 30초 주기이며 연결/구독/내역을 복구합니다. **수락 여부를 모르는 프롬프트는 자동 재전송하지 않습니다.** 공개 Paseo 0.13.0의 정확한 입력 해시를 검사하여 재접속 주기와 이 경우의 큐 재삽입 경계만 수정합니다. JS·압축 파일·HTML URL을 함께 갱신합니다. 기록·해시·변환 소스는 `LICENSES/PASEO-PROVENANCE.json`과 `LICENSES/sources/`에 있습니다.
- 소유한 Kiro HTTP OMP 시작은 첫 30초 복구 대기 전에 종료되지 않도록 readiness를 ready/exit/cancel까지 기다립니다. 다른 제공자의 시작 제한과 시작 후 RPC 제한은 유지합니다. 잘못된 인증·권한·인증서·할당량/프로토콜 오류는 무한 재시도로 숨기지 않습니다. OAuth는 요청이 서버에 도착하지 않은 것이 확인되는 연결 전 실패만 재시도하며, 성공 여부를 모르는 일회용 교환/refresh는 자동 재전송하지 않습니다. 정상 종료 형태의 의미적 응답 누락은 관측된 종료 마커 없이는 감지할 수 없습니다.
- 생성 요청이 서버에 도착한 뒤 응답이 유실되면 재시도 요청도 별도로 과금될 수 있습니다. 클라우드의 exactly-once/idempotency를 보장하지 않습니다.

### 구성·재현·검증 한계

정확한 버전·SHA/SRI·라이선스는 `build/inputs.json`, `payload/app/package-lock.json`, 배포 ZIP의 `LICENSES/` 및 `bundle-manifest.json`에 있습니다. Node 22.23.4, OMP 18.12.6, Paseo 0.13.0, omp-kiro 0.4.4를 고정합니다. npm 의존성 설치·네이티브 바이너리 빌드·배포 파일 다운로드는 **인터넷 사용이 허용된 빌드 PC에서** 완료합니다. 대상 PC에 npm이나 네이티브 컴파일러를 설치할 필요는 없습니다. 기동 시 Paseo가 동봉된 esbuild로 플러그인을 로컬 변환하는 과정은 남아 있습니다.

```powershell
# Windows x64 MSVC Developer Command 환경에서
node build/build-bundle.mjs --output C:\Build\kiro-paseo-omp-http-0.4.0-windows-x64
node test/windows-smoke.mjs C:\Build\kiro-paseo-omp-http-0.4.0-windows-x64 C:\Build\qualification
```

[Windows 빌드·검증 워크플로](.github/workflows/portable-windows.yml)는 실제 Node/native addon/PTY/플러그인 컴파일, WinHTTP PAC와 CONNECT, 메모리, 사용자 상태 격리 및 제어된 upstream을 통한 실제 OMP 도구 실행을 검사합니다. 제어된 upstream 검사는 실제 Kiro 클라우드 응답의 증거가 아닙니다. 알려진 계정 사용량 한도 때문에 실서비스 추론을 다시 요청하지 않습니다.

**Server 2019 / build 17763은 목표 환경이지 실행 검증 완료 환경이 아닙니다.** 최신 Windows CI 통과를 Server 2019 인증으로 표시하지 않으며 실제 회사 프록시의 인증·정책도 별도 현장 검증이 필요합니다. `server2019Verified: false`를 유지합니다.

관련 출처: [Node 기업망 TLS](https://nodejs.org/learn/http/enterprise-network-configuration), [WinHTTP PAC](https://learn.microsoft.com/en-us/windows/win32/api/winhttp/nf-winhttp-winhttpgetproxyforurl), [SSPI](https://learn.microsoft.com/en-us/windows/win32/secauthn/sspi), [OMP 18.12.6](https://github.com/can1357/oh-my-pi/releases/tag/v18.12.6), [omp-kiro 소스](https://github.com/emotionbug/omp-kiro).

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
