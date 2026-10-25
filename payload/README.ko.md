# Paseo + OMP + Kiro HTTP (Windows x64)

이 ZIP은 오프라인 설치용입니다. 검색 대상 외부 웹사이트에 PC가 직접 접속하지 않고 Kiro 서버에 검색을 요청합니다. **Kiro 로그인/모델 목록/사용량/검색/추론에는 Kiro·인증 서비스로 연결되는 승인된 HTTPS 프록시·게이트웨이가 필요합니다. 그 경로까지 차단하면 클라우드 기능은 동작하지 않습니다.**

## 처음 사용

1. 전체 ZIP을 새 로컬 폴더에 풉니다. 실행에 npm 설치나 Kiro CLI는 필요하지 않습니다.
2. `setup.cmd`: 비샌드박스 플러그인 신뢰를 검토하고 개인 Paseo 비밀번호를 정합니다.
3. `auth.cmd login`: 표시된 device 인증 링크를 승인된 브라우저/기기에서 엽니다.
4. `start.cmd`: 이 창을 유지하고 최신 Edge/Chrome에서 `http://127.0.0.1:16767`을 엽니다. `Kiro HTTP (OMP)`를 선택합니다.
5. `stop.cmd`: 이 패키지의 데몬만 종료합니다. 다른 Paseo 인스턴스를 중지하지 않습니다.

프로젝트 폴더에서 런처의 전체 경로를 실행하면 작업 폴더를 유지합니다.

## 자주 쓰는 명령

```bat
auth.cmd login --provider github
auth.cmd login --provider builder-id
auth.cmd status
models.cmd
usage.cmd
omp.cmd
omp.cmd --console -- --model kiro-http/auto
doctor.cmd --verify-all
network.cmd
network.cmd --mode system
network.cmd --mode manual --proxy http://PROXY-HOST:8080
network.cmd --mode manual --pac C:\ApprovedConfig\proxy.pac
network.cmd --mode system --ca C:\ApprovedConfig\company-root.pem
```

Identity Center는 `auth.cmd login --provider identity-center --start-url 조직의_START_URL`을 사용합니다. Google/GitHub는 필요시 `--flow loopback` 또는 `--flow manual`도 지원합니다. 비밀번호·토큰을 명령행에 넣지 마세요. 네트워크 변경 전에는 이 데몬을 중지합니다.

## Kiro 서버 대행 웹 검색

HTTP 경로는 같은 Kiro 인증을 사용하는 `web_search`를 기본 제공합니다. PC는 Kiro `/mcp`에 요청하며, 외부 웹사이트와 별도 Exa·Brave 검색 API에는 접속하지 않습니다. 검색 결과의 출처 URL을 자동으로 열거나 다운로드하지 않고 다른 검색 서비스로 fallback하지 않습니다.

출처·인용 정보·재현 제한을 보존한 검색 결과/발췌를 반환하며 전체 페이지 본문이 아닙니다. 원격 도구 목록에서 `web_fetch`는 제공되지 않았으므로 Kiro가 URL 본문도 가져온다고 가정하지 않습니다. OMP의 별도 직접 URL 읽기는 외부 웹 차단을 해결하는 기능이 아닙니다.

## 연결이 끊길 때

OMP와 직접 HTTP 경로는 인터넷·DNS·연결 단절 및 일시적 HTTP 오류를 같은 선택 모델로 **30초 고정 주기, 사용자 취소 전까지** 계속 재시도합니다. 더 긴 Retry-After는 지킵니다. HTTP transport가 재시도를 맡고 OMP 호스트 재시도/모델 fallback은 꺼져 있습니다. OMP의 부분 응답은 문맥에 보존하여 이어가고 완료된 도구를 재실행하지 않습니다. 직접 HTTP는 실패 시 임시 텍스트를 교체합니다. 도구는 완전하고 유효한 응답 이후 실행합니다.

Paseo 웹 연결도 첫 시도부터 30초 주기로 재접속합니다. 프롬프트 수락 여부가 불명확하면 중복 실행을 막기 위해 자동 재전송하지 않으므로 복구된 내역을 먼저 확인하세요. 소유한 Kiro HTTP OMP 시작은 ready/exit/cancel까지 기다려 첫 30초 복구 대기 전에 종료되지 않게 합니다. 잘못된 인증·권한·인증서·할당량/프로토콜 오류는 무한 재시도로 숨기지 않습니다. 서비스에 도착한 생성 요청은 응답이 유실돼도 과금될 수 있습니다.

기본 도구 정책은 사용자가 선택한 **Full access**입니다. Paseo의 OMP/직접 HTTP 새 세션과 독립 OMP는 파일 수정·삭제·명령 실행 때 건별 승인을 묻지 않습니다. 최초 플러그인 신뢰·로그인은 별도이며 직접 선택한 Ask/Plan은 유지합니다. 독립 OMP 확인 모드: `omp.cmd --console -- --approval-mode always-ask`.

## 동봉 유틸리티

Python 3.13.12(`runtime\python\python.exe`, 같은 바이너리의 `python3.exe`), ripgrep 15.1.0(`runtime\tools\rg.exe`), jq 1.8.1(`runtime\tools\jq.exe`) 및 Git Bash 도구를 포함합니다. 런처가 시작한 도구에만 PATH를 적용하며 시스템 설정은 변경하지 않습니다. 활성 프로젝트 virtualenv/Conda는 동봉 Python보다 우선합니다.

동봉 Python은 격리된 표준 라이브러리 유틸 용도이며 pip/ensurepip/Tk/서드파티 패키지나 완전한 프로젝트 개발 환경을 포함하지 않습니다. 현재 폴더/스크립트 옆 모듈은 자동 import하지 않습니다. 입출력은 UTF-8로 구성하며 일반 파일에는 `encoding="utf-8"`을 명시하세요. `-S`는 입출력 사용자 설정을 건너뜁니다. `manifests/utilities.json`과 `LICENSES/UTILITY-CHANGES.txt`에 범위·출처·변경 사항이 있습니다.

## 메모리·보안

- PAC는 Python/Px가 아닌 Windows WinHTTP·SSPI 네이티브 helper 하나를 재사용합니다. 직접 연결 모드에는 helper가 없습니다. 주소/계정은 미리 포함하지 않습니다.
- 인증·목록·사용량·제어에 Python이 필요하지 않습니다. 도구용 Python 표준 라이브러리 런타임·rg·jq는 별도로 동봉하며 호출할 때만 실행합니다. 모델에 도구 선택 지침을 추가하거나 Python 실행을 제한하지 않습니다.
- Electron/브라우저 엔진, 로컬 음성 모델은 포함하지 않습니다. 기존 승인된 최신 Edge/Chrome을 사용하세요. WezTerm은 독립 OMP TUI에서만 시작합니다.
- Node 자식의 old-space 기본 상한은 프로세스당 256 MiB이며 전체 RSS/Bun/브라우저의 상한은 아닙니다. 많은 동시 에이전트는 추가 메모리를 사용합니다. 사용 후 종료하세요.
- 계정 데이터는 기본 `%LOCALAPPDATA%\KiroInternal`에 저장합니다. 다른 위치는 각 명령에 동일한 `--data-dir 절대경로`를 지정하세요. 사용한 데이터 폴더나 인증 SQLite를 재배포하지 마세요.
- `auth.cmd logout`은 전용 HTTP 저장소만 로그아웃합니다. 모델 목록은 계정에서 가져오며 다른 모델로 몰래 전환하지 않습니다.
- TLS 검증을 끄지 않습니다. 프록시 인증은 현재 사용자의 SSPI입니다. 회사 프록시 URL에 사용자명/비밀번호를 넣지 않습니다. PAC 오류는 DIRECT로 숨기지 않습니다. SOCKS/HTTPS upstream proxy와 PAC 대체 프록시 자동 failover는 지원하지 않습니다.
- HTTPS CONNECT의 PAC는 암호화된 전체 경로가 아니라 호스트/포트 기준입니다. HTTPS 경로별 PAC 정책은 지원하지 않으며 호스트 기반 PAC 또는 승인된 명시적 프록시가 필요합니다.
- 본인 신뢰가 필요한 비공식 HTTP/OAuth 플러그인이며 도구는 사용자 권한으로 실행됩니다. 회사의 보안·서비스 정책과 코드 서명/허용목록 승인을 먼저 확인하세요.

OMP 없는 저메모리 경로를 직접 선택하려면 데몬을 중지한 뒤 전용 `paseo/config.json`에서 `agents.providers["kiro-http"].enabled=true`, `agents.providers["kiro-omp-http"].enabled=false`로 바꾸고 재기동하여 **새** 에이전트의 `Kiro HTTP` 제공자를 선택합니다. 기존 세션 변환이나 자동 fallback은 하지 않습니다. 사용량은 계정 할당량이며 세션 토큰 소비량이 아닙니다.

## 검증 범위

`bundle-manifest.json`에 입력 SHA/SRI, 전체 파일 해시, 실제 빌드 Windows의 네이티브 검사/프록시 메모리 측정이 기록돼 있습니다. 32 MiB 기준은 네이티브 프록시의 idle/warm private/working set 각각에만 적용되며 전체 앱이나 공유 Windows PAC 서비스의 한도가 아닙니다.

Server 2019/build 17763을 목표로 하지만 실제 해당 OS 및 회사 인증 프록시의 실행 검증을 완료했다는 뜻은 아닙니다. `server2019Verified:false`를 유지합니다. CI의 제어된 upstream 도구 실행은 실서비스 계정의 Kiro 응답 증명이 아닙니다.

상세 안내·출처·검증 결과: https://github.com/emotionbug/kiro-cli-internal
라이선스/고지: LICENSES/ 및 각 동봉 구성요소. 원본 배포 ZIP과 .sha256을 대조하세요.
