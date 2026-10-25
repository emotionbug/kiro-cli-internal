# Paseo + OMP + Kiro HTTP (Windows x64)

이 ZIP은 오프라인 설치용입니다. **Kiro 클라우드 로그인/모델 목록/사용량/추론에는 승인된 외부 HTTPS 연결이 필요합니다. 완전한 폐쇄망에서는 추론할 수 없습니다.**

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
- 본인 신뢰가 필요한 비공식 HTTP/OAuth 플러그인이며 도구는 사용자 권한으로 실행됩니다. 회사의 보안·서비스 정책과 코드 서명/허용목록 승인을 먼저 확인하세요.

## 검증 범위

`bundle-manifest.json`에 입력 SHA/SRI, 전체 파일 해시, 실제 빌드 Windows의 네이티브 검사/프록시 메모리 측정이 기록돼 있습니다. 32 MiB 기준은 네이티브 프록시의 idle/warm private/working set 각각에만 적용되며 전체 앱이나 공유 Windows PAC 서비스의 한도가 아닙니다.

Server 2019/build 17763을 목표로 하지만 실제 해당 OS 및 회사 인증 프록시의 실행 검증을 완료했다는 뜻은 아닙니다. `server2019Verified:false`를 유지합니다. CI의 제어된 upstream 도구 실행은 실서비스 계정의 Kiro 응답 증명이 아닙니다.

상세 안내·출처·검증 결과: https://github.com/emotionbug/kiro-cli-internal
라이선스/고지: LICENSES/ 및 각 동봉 구성요소. 원본 배포 ZIP과 .sha256을 대조하세요.
