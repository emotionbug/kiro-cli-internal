# Paseo + Kiro HTTP 0.5.0 (Windows x64)

기본 경로는 **Paseo 웹 UI → Kiro HTTP 플러그인 → Kiro 서비스**입니다. OMP, WezTerm, Kiro CLI, Claude CLI를 설치하거나 실행하지 않습니다. Python·rg·jq·Git Bash는 작업 도구로 동봉합니다.

Paseo 서버·CLI·웹 UI는 사용자 포크 `emotionbug/paseo`의 고정 커밋 `c3bac24ccc2df8dcc67d807c805db0efa0817dff`에서 함께 빌드합니다. 세션 중심 탐색, diff 초기 표시/스크롤 최적화와 브라우저 자동화 지연 시작 변경을 포함합니다. 내부 버전 표시는 0.13.0이며 `doctor.cmd`의 `paseoSource`와 `bundle-manifest.json.paseoFork`로 실제 소스를 확인하세요. 기존 실행 중인 사용자 Paseo는 수정·재시작하지 않습니다.

이 ZIP은 오프라인 설치용입니다. 로그인·모델 목록·사용량·검색·추론에는 Kiro/인증 서비스로 연결되는 승인된 HTTPS 프록시·게이트웨이가 필요합니다. 그 경로까지 차단된 완전 망 분리에서는 클라우드 기능을 사용할 수 없습니다. 검색 대상 웹사이트에 PC가 직접 접속하지 않고 Kiro 서버에 검색을 맡깁니다.

## 처음 사용

1. ZIP 전체를 새 로컬 폴더(예: `C:\KiroOffline`)에 풉니다. GitHub의 Source code ZIP은 실행 패키지가 아닙니다. 대상 PC에서 npm 설치·다운로드·컴파일은 필요하지 않습니다.
2. `setup.cmd`: 비샌드박스 플러그인 신뢰를 검토·승인하고 개인 Paseo 비밀번호를 정합니다.
3. `auth.cmd login`: 표시된 device 인증 링크를 승인된 브라우저/기기에서 열어 직접 로그인합니다.
4. `start.cmd`: 이 창을 유지하고 기존 승인된 최신 Edge/Chrome에서 `http://127.0.0.1:16767`을 엽니다. 첫 화면의 **Direct connection**에 `127.0.0.1:16767`을 등록하고 개인 비밀번호로 접속한 뒤 **Kiro HTTP**를 선택합니다.
5. 종료는 `stop.cmd`입니다. 이 패키지가 소유한 데몬만 종료하며 다른 Paseo/OMP 인스턴스를 중지하지 않습니다.

기본 수신은 `127.0.0.1:16767` 로컬 전용입니다. 전달한 데몬 주소가 비밀번호를 요구하거나 연결에 실패해도 다른 `localhost:6767` 인스턴스를 대신 탐색하지 않습니다. 프로젝트 폴더에서 런처 전체 경로를 실행하면 작업 폴더를 유지합니다.

## 자주 쓰는 명령

```bat
auth.cmd login --provider github
auth.cmd login --provider builder-id
auth.cmd login --provider identity-center --start-url https://YOUR-ORGANIZATION.awsapps.com/start
auth.cmd status
models.cmd
usage.cmd
doctor.cmd --verify-all
network.cmd
network.cmd --mode system
network.cmd --mode manual --proxy http://PROXY-HOST:8080
network.cmd --mode manual --pac C:\ApprovedConfig\proxy.pac
network.cmd --mode system --ca C:\ApprovedConfig\company-root.pem
```

Google/GitHub는 필요시 `--flow loopback` 또는 `--flow manual`도 지원합니다. 비밀번호·토큰을 명령행에 넣지 마세요. 네트워크 변경 전에는 이 데몬을 중지합니다.

기존 CLI social 로그인을 이미 가지고 있는 경우에만 선택적으로 `auth.cmd import-cli`를 사용할 수 있습니다. 기본 원본은 원래 사용자 홈의 `.local\share\kiro-cli\data.sqlite3`이며 다른 위치는 `--database C:\Path\data.sqlite3`로 지정합니다. 원본 DB는 읽기 전용이지만 refresh token 회전·폐기는 원래 세션과 공유될 수 있으므로 독립적인 `auth.cmd login`을 권장합니다. 이 기능은 Kiro CLI를 설치하거나 실행하지 않습니다.

`models.cmd`는 실제 계정의 모델 목록을 조회하여 계정에 결합된 스냅샷을 갱신합니다. 시작 시 그 스냅샷을 사용하므로 목록 조회 실패를 이유로 임의 모델·다른 계정 캐시로 전환하지 않습니다. 실제 모델 ID를 그대로 사용하며 OMP용 `kiro-http/` 접두어를 붙이지 않습니다. 계정 변경이나 프로필 ARN 없는 인증의 refresh token 회전 후에는 `models.cmd`로 결합을 갱신하세요. 갱신한 목록은 새 세션에 반영합니다. 사용량 표시는 계정 할당량이며 개별 세션 토큰 소비량이 아닙니다.

## Kiro 대행 검색과 도구

`web_search`는 같은 Kiro 인증으로 Kiro `/mcp`에 요청합니다. PC는 검색 출처 URL을 자동으로 열거나 본문을 다운로드하지 않으며 Exa·Brave 등 별도 검색 API로 fallback하지 않습니다. 출처·인용·재현 제한을 보존한 검색 결과/발췌이며 전체 페이지 본문 도구가 아닙니다. 관측된 원격 도구 목록에는 `web_search`만 있었으므로 `web_fetch`를 지원한다고 가정하지 않습니다.

기본 도구 정책은 사용자가 선택한 **Full access**입니다. 파일 수정·삭제·명령 실행을 건별 승인 없이 사용자 권한으로 수행합니다. 최초 플러그인 신뢰·로그인은 별도이며 명시적으로 선택한 Ask/Plan은 유지합니다. 모델에 도구 선택이나 Python 사용 제한 지침을 추가하지 않습니다.

## 연결이 끊길 때

인터넷·DNS·연결 단절 및 일시적 HTTP 오류는 선택 모델과 대화 ID를 유지하며 **30초 고정 주기, 사용자 취소 전까지** 재시도합니다. 더 긴 Retry-After는 지킵니다. 실패한 시도의 임시 텍스트는 같은 메시지에서 교체하며 도구는 완전하고 유효한 응답을 받은 뒤 실행합니다. 완료된 도구 결과를 유지하며 완료 도구를 처음부터 재실행하지 않습니다.

Paseo 웹 연결도 첫 시도부터 30초 주기로 재접속합니다. 수락 여부가 불명확한 프롬프트는 중복 실행 방지를 위해 자동 재전송하지 않으므로 복구한 내역을 먼저 확인하세요. 잘못된 인증·권한·인증서·할당량·프로토콜 오류는 무한 재시도로 숨기지 않습니다. OAuth 일회용 교환/refresh는 성공 여부를 모르는 응답 유실을 무조건 재전송하지 않습니다. 서비스에 도착한 생성 요청은 응답이 유실돼도 과금될 수 있으며 클라우드 exactly-once를 보장하지 않습니다.

## 내부망·PAC·인증서

시스템/PAC 모드는 목적지별 DIRECT/프록시와 Windows 시스템 프록시의 내부 주소 예외를 사용합니다. 내부 API·Git·MCP 주소를 Kiro 도메인으로 제한하지 않습니다. 수동 고정 프록시에서는 내부 주소도 그 프록시를 경유하므로 예외가 필요하면 시스템/PAC 모드를 사용하세요. 승인된 사설 CA를 추가할 수 있으며 TLS/호스트명 검증을 끄지 않습니다.

PAC는 Python/Px 대신 Windows WinHTTP·SSPI 네이티브 helper 하나를 재사용합니다. 직접 연결 모드에는 helper가 없습니다. upstream 인증은 현재 사용자의 SSPI Negotiate/NTLM이며 프록시 URL에 사용자명/비밀번호를 넣지 않습니다. 시스템 프록시·인증서 저장소는 변경하지 않습니다. PAC 오류를 DIRECT로 숨기지 않습니다. SOCKS/HTTPS upstream proxy와 PAC 대체 프록시 자동 failover는 지원하지 않습니다. PAC 파일 서버에 인증을 위임하지 않으므로 그 서버가 인증을 요구하면 승인된 로컬 PAC 파일을 사용하세요. HTTPS CONNECT의 PAC는 전체 암호화 경로가 아니라 호스트/포트 기준입니다.

HOME/USERPROFILE은 원래 사용자 값을 유지하므로 기존 Git/SSH 설정을 사용할 수 있습니다. Paseo home·인증·모델 스냅샷은 명시적인 전용 데이터 경로를 사용합니다. 다른 프로그램의 홈이나 설정을 복사·수정하지 않습니다. 실제 회사 내부 주소·PAC·SSPI 정책과 AppLocker/WDAC·서명 정책은 현장 승인이 필요합니다. CI의 외부망 차단용 브라우저 플래그는 실행기에 포함하지 않습니다.

## 동봉 유틸리티와 메모리

Python 3.13.12 표준 라이브러리(`runtime\python\python.exe`, 같은 바이너리의 `python3.exe`), ripgrep 15.1.0, jq 1.8.1 및 전체 Git Bash를 포함합니다. 런처가 시작한 도구에만 PATH를 적용하며 시스템 PATH는 변경하지 않습니다. 활성 프로젝트 virtualenv/Conda는 동봉 Python보다 우선합니다.

Python은 격리된 표준 라이브러리 유틸 용도입니다. pip/ensurepip/Tk/서드파티 패키지나 완전한 프로젝트 개발 환경을 포함하지 않으며 현재 폴더/스크립트 옆 모듈은 자동 import하지 않습니다. 입출력은 UTF-8로 구성하며 일반 파일은 `encoding="utf-8"`을 명시하세요. `-S`는 입출력 사용자 설정도 건너뜁니다. 범위·출처·변경 사항은 `manifests/utilities.json`과 `LICENSES/UTILITY-CHANGES.txt`에 있습니다.

Electron/브라우저 엔진·WezTerm·OMP·다른 에이전트 CLI·로컬 음성 런타임/모델은 포함하지 않습니다. Node 자식의 old-space 기본 상한 256 MiB는 프로세스당 V8 old-space에만 적용되며 전체 RSS나 브라우저 상한이 아닙니다. 동시 에이전트는 추가 메모리를 사용합니다.

## 데이터·이전 배포에서 이동

사용자 데이터는 기본 `%LOCALAPPDATA%\KiroInternal`이며 사용자와 SYSTEM만 허용하는 ACL을 생성합니다. 별도 위치는 각 명령에 동일한 `--data-dir 절대경로`를 지정하세요. 인증 SQLite·사용한 데이터 폴더를 재배포하지 마세요. `auth.cmd logout`은 이 HTTP 저장소만 로그아웃합니다.

네이티브 대화 기록도 전용 데이터 폴더의 `.local\state\omp-kiro\paseo`에 저장합니다. 실행기에 전달한 `XDG_STATE_HOME`을 이 개인 경로로 고정하며, 기존 사용자 HOME·Git/SSH 설정은 그대로 유지합니다.

0.4.0 위에 덮어 풀지 말고 새 폴더를 사용하세요. 기존 전용 데몬을 `stop.cmd`로 중지한 뒤 새 패키지에서 시작합니다. 기존 OMP 프로필은 새 기본 경로가 아니며 OMP 세션을 native HTTP 세션으로 자동 변환하지 않습니다. 기존 OMP 세션을 재개해야 한다면 해당 0.4.0 배포본을 보관하세요. 다른 프로그램의 OMP/Paseo나 기존 대화 파일은 삭제하지 않습니다.

동봉 `omp-kiro`라는 이름은 플러그인 프로젝트 이름일 뿐 OMP 실행 파일 의존성을 뜻하지 않습니다. 비공식 HTTP/OAuth 구현이므로 서비스·계정 정책 변경의 영향을 받습니다. 플러그인은 비샌드박스 코드이며 도구는 사용자 권한으로 실행됩니다.

## 무결성과 검증 범위

`bundle-manifest.json`에 입력 SHA/SRI, 전체 파일 해시, 실제 빌드 Windows의 네이티브 검사·프록시 메모리 측정·구성 제외 기록이 있습니다. 네이티브 프록시의 idle/warm private bytes와 working set 각각 32 MiB 기준은 전체 앱이나 Windows 공유 PAC 서비스의 한도가 아닙니다.

Server 2019/build 17763은 목표 환경이며 실제 해당 OS/회사 인증 프록시의 검증을 완료했다는 뜻은 아닙니다. `server2019Verified:false`를 유지합니다. CI의 제어된 Kiro upstream 검사는 실서비스 계정의 응답 생성 증명이 아닙니다. 공개 배포의 검증 보고서와 SHA-256을 대조하세요.

배포·검증 보고서: https://github.com/emotionbug/kiro-cli-internal/releases
라이선스/고지: LICENSES/ 및 각 구성요소. 원본 배포 ZIP과 .sha256을 함께 보관하세요.
