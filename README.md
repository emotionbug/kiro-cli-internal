# Kiro Internal — Passession + OMP + Kiro HTTP

Windows x64용 오프라인 설치 패키지입니다. **Passession 네이티브 앱 → OMP → Kiro HTTP → Windows 시스템/PAC/SSPI 프록시 → Kiro 서비스**로 구성합니다. Python 표준 라이브러리·ripgrep·jq·전체 Git Bash도 유지합니다.

0.6.0은 과거 JavaScript Paseo 서버·웹 UI를 공식 Passession Rust 앱·데몬으로 교체하고 OMP 제공자에 HTTP 플러그인을 연결합니다. OMP를 제외했던 0.5.0과 다른 실행 구조입니다. Kiro CLI·WezTerm·Electron·별도 브라우저 엔진은 필요하지 않습니다.

> 설치·기동에는 외부 다운로드가 없습니다. 로그인·목록·사용량·검색·추론에는 승인된 HTTPS 연결이 필요합니다. 완전 망 분리에서는 Kiro 클라우드를 사용할 수 없습니다. 실행 시 최신판을 내려받는 방식이 아니라, 확인한 최신 안정판을 해시로 고정합니다.

## 0.6.0 구성

| 구성요소 | 버전·출처 |
|---|---|
| Passession 네이티브 앱·데몬 | [0.13.15](https://github.com/emotionbug/Passession/releases/tag/v0.13.15), `428a5f68f5683d9a63a90d506909568e60093e6b` |
| OMP standalone | [18.20.0](https://github.com/can1357/oh-my-pi/releases/tag/v18.20.0) |
| `omp-kiro` HTTP 플러그인 | 0.4.8, [`8056e05`](https://github.com/emotionbug/omp-kiro/commit/8056e05380e545afed6a093a1e6e550b4a59fd0d) |
| Node.js LTS | 26.13.1 |
| Python 표준 라이브러리 | 3.15.2 |
| ripgrep / jq | 15.2.0 / 1.8.2 |
| 전체 Git for Windows·Git Bash | 2.56.1.windows.1 |
| 프록시 | 저장소 C++ 소스로 빌드하는 WinHTTP·SSPI helper |

입력 URL·SHA-256은 `build/inputs.json`, npm 의존성은 `payload/app/package-lock.json`, 출력 파일별 해시는 ZIP의 `bundle-manifest.json`에 있습니다. 데스크톱 공식 NSIS 배포물에서 필요한 네이티브 실행 파일·런타임·리소스·고지를 추출하고 설치기/제거기는 배포하지 않습니다. 7-Zip은 빌드 도구이며 사용자 패키지에 넣지 않습니다. Passession의 `flutter-*.json` 피드 이름은 호환성 식별자이지 현재 UI 기술이 아닙니다.

`app/omp-network-policy.json`은 같은 OMP 버전의 정적 카탈로그와 동적 제공자 레지스트리에서 생성합니다. Kiro 외 기본 제공자의 자동 모델 탐색과 OMP 시작 시 업데이트 확인·자동 업데이트·marketplace 갱신을 끕니다. 불필요한 외부 조회를 숨기거나 프록시 허용목록을 넓히는 대신 조회 원인을 비활성화합니다. 사용자가 실행하는 Git·MCP·네트워크 도구를 막는 방화벽은 아닙니다.

## 실행

1. 빌드된 `kiro-passession-omp-http-0.6.0-windows-x64.zip`을 **새 폴더**에 풉니다. GitHub Source code ZIP은 실행 패키지가 아닙니다.
2. `setup.cmd`에서 비샌드박스 플러그인 실행을 검토·승인하고 개인 데몬 비밀번호를 정합니다.
3. 필요한 경우 `network.cmd --mode system --ca C:\ApprovedConfig\company-root.pem` 등으로 승인된 네트워크를 설정합니다.
4. `auth.cmd login`으로 직접 로그인하고 `models.cmd`로 계정 모델 목록을 갱신합니다.
5. `start.cmd`로 전용 데몬과 Passession 앱을 실행합니다. 앱에서 **Kiro HTTP** 제공자와 실제 계정 모델을 선택합니다.
6. 데몬 종료는 `stop.cmd`입니다. 데스크톱 창은 별도로 닫습니다. 다른 Passession/Paseo/OMP 프로세스를 일괄 종료하지 않습니다.

네이티브 앱 없이 사용할 때는 `start.cmd --no-app`과 `paseo.cmd`, OMP 터미널을 직접 사용할 때는 `omp.cmd`입니다. 모델 ID는 **`kiro-http/<실제 모델 ID>`**입니다. `auto`도 계정 목록에 있을 때만 사용하며 임의 모델·다른 전송 방식으로 fallback하지 않습니다. `usage.cmd`는 계정 할당량을 조회합니다.

전용 데몬은 기본 `127.0.0.1:16767`만 사용합니다. 웹 UI 주소가 아니며 공개 인터페이스로 노출하지 않습니다. 모든 명령에 동일한 `--data-dir 절대경로`를 지정하여 기본 `%LOCALAPPDATA%\KiroInternal` 대신 별도 사용자 데이터를 사용할 수 있습니다. 원래 HOME/USERPROFILE·Git/SSH 설정은 유지하고 시스템 PATH·프록시·인증서 저장소는 변경하지 않습니다.

**상세 실행·인증·Identity Center 프로필·프록시·모드·유틸리티 설명은 [동봉 사용자 안내](payload/README.ko.md)**에 있습니다. 개인정보 취급 범위는 [PRIVACY.md](PRIVACY.md)를 참조하세요.

### 프록시와 재시도

- 시스템/PAC 모드는 목적지별 DIRECT/프록시·내부 주소 예외를 사용하며 내부 API·Git·MCP를 Kiro 도메인으로 제한하지 않습니다. 수동 고정 프록시는 내부 주소도 전달하므로 내부 예외가 필요하면 시스템/PAC를 사용하세요.
- upstream 인증은 현재 Windows 사용자의 SSPI Negotiate/NTLM입니다. HTTP/CONNECT·HTTP(S)/로컬 PAC를 지원하며 SOCKS·HTTPS upstream·PAC 다음 프록시로 자동 failover는 지원하지 않습니다. TLS/호스트명 검증을 해제하지 않습니다.
- Kiro HTTP의 일시적 오류는 취소 전까지 30초 간격으로 복구하고 더 긴 `Retry-After`를 지킵니다. 선택 모델·대화 ID·완료된 도구 결과·기존 텍스트를 유지합니다. 인증·권한·인증서·할당량 오류는 무한 재시도로 숨기지 않습니다. 이미 수신된 요청의 과금이나 exactly-once를 보장하지 않습니다.
- 네이티브 Passession 연결 복구는 해당 upstream 구현을 따릅니다. 과거 웹 UI의 고정 30초 재접속 패치를 이식했다고 주장하지 않습니다.
- `web_search`는 같은 Kiro 인증으로 `/mcp`를 호출하고 출처·인용·재현 제한을 보존합니다. 반환된 사이트 본문을 자동으로 가져오거나 다른 검색 서비스로 fallback하지 않습니다. OMP의 다른 도구에 대한 네트워크 차단 기능은 아닙니다.

### 유틸리티와 이전 데이터

Python(`python`·`python3`)·rg·jq·전체 Git Bash를 런처의 자식 PATH에 제공합니다. 활성 virtualenv/Conda를 우선하고 시스템 PATH는 변경하지 않습니다. Python은 격리된 표준 라이브러리 도구이며 pip/ensurepip/Tk·과학 패키지·완전한 개발 환경을 포함하지 않습니다. stdio는 UTF-8, 일반 파일 인코딩은 명시하세요.

기존 0.5 직접 HTTP 대화를 OMP 대화로 자동 변환하지 않습니다. 새 네이티브/OMP 상태를 분리하고 기존 파일·인증·다른 설치를 삭제하지 않습니다. 과거 대화 재개가 필요하면 [0.5.0 원본](https://github.com/emotionbug/kiro-cli-internal/releases/tag/v0.5.0)을 보관하세요. 새 ZIP을 기존 설치에 덮어 풀지 마세요.

다른 드라이브의 `--data-dir`를 사용하면 OMP의 부가 캐시·로그·worktree는 홈의 별도 `.kiro-internal-omp\<경로 해시>`에 저장합니다. 기존 `~\.omp`는 사용하지 않습니다. 네이티브 GUI는 Windows 세션당 한 인스턴스이며 **시작 시 HKCU 알림 등록을 자신의 EXE로 갱신**하여 설치된 Paseo Sessions의 알림 활성화 대상에 영향을 줄 수 있습니다. 레지스트리 변경이 허용되지 않으면 `--no-app`과 CLI를 사용하세요.

## 빌드와 검증

인터넷이 허용된 Windows x64 MSVC Developer Command 환경에서 실행합니다. Ubuntu 사전 빌드나 `--paseo-fork` 입력은 더 이상 사용하지 않습니다.

```powershell
node build/build-bundle.mjs --output C:\Build\kiro-passession-omp-http-0.6.0-windows-x64 --cache C:\Build\download-cache
node test/windows-utilities.mjs C:\Build\kiro-passession-omp-http-0.6.0-windows-x64 C:\Build\qualification
node test/windows-smoke.mjs C:\Build\kiro-passession-omp-http-0.6.0-windows-x64 C:\Build\qualification
```

[Windows 워크플로](.github/workflows/portable-windows.yml)는 조립과 해당 ZIP의 검증을 분리합니다. 네이티브 `paseo` CLI에서 실제 OMP를 실행하여 모델 고정·파일 내용·HTTP 오류/스트림 단절 복구·도구 비반복·Kiro 검색·정밀 사용량·데몬 재시작 후 같은 대화 재개·전용 종료·패키지 무변경을 검사합니다. 별도 유틸리티 검사는 재배치된 한글 경로에서 Python SQLite → rg → jq 결과와 전체 Git Bash를 확인합니다.

[릴리스 승격](.github/workflows/publish-qualified-release.yml)은 성공한 main 검증 실행의 기존 ZIP만 사용합니다. 해시·모든 내부 파일·고정 입력·native OMP qualification 결과를 확인하고 검증 소스 커밋에 태그를 묶습니다. 이 로컬 변경만으로 CI 실행이나 공개 Release를 완료했다고 간주하지 않습니다.

제어된 upstream 결과는 실제 Kiro 계정·회사망 추론 성공의 증거가 아닙니다. 네이티브 CLI 검사만으로 데스크톱 UI도 검증했다고 표시하지 않습니다. 실제 회사 PAC·SSPI 정책·AppLocker/WDAC·계정 권한은 현장 확인이 필요합니다. **Server 2019/build 17763 호환성은 미확인**이며 `server2019Verified:false`를 유지합니다.

**2026-11-13 Windows build 26200 로컬 검증:** 최종 ZIP을 새 한글 경로에 풀어 회귀 테스트 **37개 모두 통과(스킵 0)**, 유틸리티 파이프라인, 실제 OMP 파일 쓰기·검색·30초 HTTP 복구·같은 대화 재개를 확인했습니다. Kiro 외 자동 프록시 요청은 **0건**이고 패키지 파일은 실행 전후 동일했습니다. 기존 설치의 알림 등록을 보존하는 사용자 선택에 따라 **GUI 실행은 보류**했습니다. [0.6.0 변경사항과 검증 범위](releases/0.6.0/RELEASE.md)를 참조하세요. 이 수치는 로컬 실행 기록이며 GitHub 배포의 소스 SHA·Windows 검증 실행·ZIP 해시는 해당 Release에 첨부한 근거를 기준으로 확인하세요.

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
