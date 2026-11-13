# Passession + OMP + Kiro HTTP 0.6.1 — Windows x64

**Passession 네이티브 앱 → OMP → Kiro HTTP → 승인된 프록시/게이트웨이 → Kiro 서비스** 구성입니다. 예전 Paseo 웹 UI와 JavaScript 데몬은 포함하지 않습니다. OMP가 파일·명령·도구 실행과 대화 기록을 담당합니다. Kiro CLI·WezTerm·Electron·별도 브라우저 엔진은 필요하지 않습니다.

## 동봉 버전

| 구성요소 | 고정 버전 |
|---|---|
| Passession 앱·Rust 데몬/CLI | 0.13.15 (`428a5f68f5683d9a63a90d506909568e60093e6b`) |
| OMP | 18.20.0 |
| Kiro HTTP 플러그인 (`omp-kiro`) | 0.4.8 (`8056e05380e545afed6a093a1e6e550b4a59fd0d`) |
| Node.js | 26.13.1 LTS |
| Python 표준 라이브러리 | 3.15.2 |
| ripgrep / jq | 15.2.0 / 1.8.2 |
| 전체 Git for Windows·Git Bash | 2.56.1.windows.1 |
| 프록시 | 이 저장소의 WinHTTP·SSPI 네이티브 helper |

조회 시점의 최신 안정판을 고정하며 실행 시 자동으로 다른 버전을 다운로드하지 않습니다. 입력 출처·SHA-256·전체 파일 목록은 `bundle-manifest.json`, 라이선스는 `LICENSES/` 및 각 구성요소에 있습니다. Passession의 과거 `flutter-*.json` 업데이트 피드 이름은 호환성 식별자이며 이 앱은 Rust 네이티브 앱입니다.

OMP에는 `app/omp-network-policy.json`을 적용합니다. 같은 OMP 버전의 공식 정적 카탈로그·동적 제공자 레지스트리에서 기본 제공자 전체를 비활성화하여 Kiro 이외의 모델 목록을 자동 조회하지 않습니다. OMP 시작 시 업데이트 확인·자동 업데이트·marketplace 자동 갱신도 끕니다. 사용자가 직접 실행한 네트워크 도구를 차단하는 방화벽은 아닙니다.

## 처음 사용

1. ZIP 전체를 **새 폴더**에 풉니다. 이전 0.4/0.5 설치 위에 덮어쓰지 마세요. GitHub Source code ZIP은 실행 패키지가 아닙니다.
2. `setup.cmd`로 동봉 OMP 플러그인의 비샌드박스 실행을 검토·승인하고 개인 데몬 비밀번호를 정합니다.
3. 회사망에서는 아래 `network.cmd`로 승인된 Windows 시스템/PAC 또는 수동 프록시를 설정합니다.
4. `auth.cmd login`을 실행합니다. 출력된 공식 device 인증 링크를 승인된 브라우저/기기에서 열어 직접 승인합니다.
5. `models.cmd`로 계정 모델 목록을 갱신한 뒤 `start.cmd`를 실행합니다. 실행기 창을 유지하고 Passession 앱에서 **Kiro HTTP** 제공자를 사용합니다.
6. 종료는 `stop.cmd`입니다. 이 전용 데이터 폴더의 데몬만 종료하며 다른 Passession/Paseo/OMP를 일괄 종료하지 않습니다.

앱 대신 CLI만 사용할 때는 `start.cmd --no-app`을 실행한 뒤 별도 창에서 `paseo.cmd`를 사용합니다. `omp.cmd`는 같은 인증·프록시·전용 설정으로 OMP 터미널을 직접 실행합니다. 프로젝트 폴더에서 런처의 전체 경로를 호출하면 그 작업 폴더를 유지합니다.

기본 데몬 주소는 `127.0.0.1:16767`이며 외부 인터페이스에 공개하지 않습니다. 웹 UI를 제공하는 주소가 아닙니다. 다른 데이터 경로는 모든 명령에 동일한 `--data-dir 절대경로`를 지정하세요. 사용자 데이터는 기본 `%LOCALAPPDATA%\KiroInternal`이며 시스템 PATH·프록시·인증서 저장소는 변경하지 않습니다.

```bat
auth.cmd login --provider google
auth.cmd login --provider github
auth.cmd login --provider builder-id
auth.cmd login --provider identity-center --start-url https://YOUR-ORGANIZATION.awsapps.com/start
auth.cmd status
auth.cmd profile
models.cmd
usage.cmd
doctor.cmd --verify-all
omp.cmd --model kiro-http/auto
```

`auto`를 포함한 모델은 실제 계정 목록에 있는 경우에만 사용할 수 있습니다. **Passession의 OMP 제공자와 OMP CLI 모두 `kiro-http/<실제 모델 ID>`를 사용합니다.** `models.cmd`의 계정 스냅샷에는 원본 ID가 저장됩니다. 빈 목록·인증 오류를 임의 모델이나 다른 전송 방식으로 대체하지 않습니다. 로그인 계정이나 Kiro 프로필을 바꾸면 목록을 다시 갱신하세요.

Identity Center 계정의 프로필이 여러 개면 임의로 하나를 선택하지 않습니다. `auth.cmd profile --profile 실제_프로필_ARN`으로 선택합니다. 인증서·권한·계정 사용량 오류는 무한 재시도로 감추지 않습니다. `usage.cmd`는 계정 할당량이며 세션별 토큰 사용량이 아닙니다. 예전 JavaScript Paseo 플러그인의 사용량 패널을 네이티브 앱으로 이식했다고 주장하지 않습니다.

기존 CLI social 인증은 `auth.cmd import-cli`로 명시적으로 가져올 수 있습니다. 원본 기본 위치는 원래 사용자 홈의 `.local\share\kiro-cli\data.sqlite3`이며 `--database 절대경로`로 변경할 수 있습니다. 원본 DB는 수정하지 않지만 복사한 refresh token의 회전·폐기는 원래 로그인과 공유될 수 있어 독립적인 `auth.cmd login`을 권장합니다.

## 프록시·내부망·TLS

```bat
network.cmd
network.cmd --mode system
network.cmd --mode manual --proxy http://PROXY-HOST:8080
network.cmd --mode manual --pac C:\ApprovedConfig\proxy.pac
network.cmd --mode system --ca C:\ApprovedConfig\company-root.pem
network.cmd --mode direct
```

네트워크 설정을 바꾸기 전에 이 패키지의 데몬을 중지하세요. 기본값은 현재 Windows 사용자의 시스템/PAC 설정입니다. 주소·사용자명·암호를 배포물에 미리 넣지 않습니다. upstream 인증에는 현재 사용자의 SSPI Negotiate/NTLM을 사용하며 프록시 URL에 인증정보를 넣지 않습니다.

시스템/PAC 모드는 목적지별 DIRECT/프록시와 Windows 내부 주소 예외를 사용합니다. 내부 API·Git·MCP를 Kiro 도메인으로 제한하지 않습니다. 수동 고정 프록시에는 내부 주소도 전달되므로 내부 예외가 필요하면 시스템/PAC 모드를 사용하세요. 로컬 데몬/MCP 연결은 프록시를 우회합니다.

TLS와 호스트명 검증은 유지합니다. `--ca`에는 승인된 **공개 PEM 인증서만** 지정하며 개인키를 넣지 않습니다. PAC 오류를 DIRECT로 숨기지 않습니다. 지원 범위는 HTTP upstream·HTTP/CONNECT·시스템/PAC·HTTP(S)/로컬 PAC 파일입니다. SOCKS/HTTPS upstream·다음 PAC 프록시로 자동 failover는 지원하지 않습니다. PAC 서버에 인증을 위임하지 않으므로 인증이 필요하면 승인된 로컬 PAC 파일을 사용하세요.

설치·기동에는 외부 다운로드가 없지만 로그인·목록·사용량·검색·추론에는 승인된 HTTPS 연결이 필요합니다. 완전 망 분리에서는 Kiro 클라우드를 사용할 수 없습니다. 승인 검토 시작점은 `prod.us-east-1.auth.desktop.kiro.dev`, `runtime.us-east-1.kiro.dev`, `management.us-east-1.kiro.dev`이며 계정에 따라 EU Central과 지정 지역의 AWS OIDC도 사용합니다. 브라우저 로그인은 Kiro/AWS SSO/선택한 IdP의 별도 허용이 필요합니다. 이 목록은 모든 조직의 완전한 허용목록이 아닙니다.

### 작업 중 SSO 통신 오류와 0.6.0 업데이트

0.6.0에는 HTTPS/웹소켓의 유지 연결이 신규 연결 처리 스레드 8개를 점유할 수 있는 결함이 있습니다. 이 상태에서는 모델 통신 중 뒤늦게 필요한 SSO 토큰 갱신 연결도 대기합니다. 0.6.1은 유지 연결을 별도 I/O 루프에서 처리합니다. 동시 터널 상한은 128개이며 한도 초과는 새 연결에 502를 반환하고 기존 연결을 끊거나 무한 대기시키지 않습니다. 연결 종료 후에는 재시작 없이 자리를 재사용합니다.

업데이트 시 기존 폴더에서 `stop.cmd`를 실행하고 앱도 닫은 다음, 0.6.1 ZIP을 **새 폴더**에 풉니다. 새 폴더에서 `setup.cmd`를 수행하고 `start.cmd`로 실행합니다. 같은 사용자와 데이터 경로를 유지하면 인증·설정·대화 기록을 그대로 사용합니다. 별도 `--data-dir`를 사용했다면 모든 명령에 이전과 동일한 경로를 지정하세요. 인증 DB를 삭제하거나 토큰을 다른 설치에서 복사하지 마세요.

`Cannot reach AWS SSO OIDC`만으로 원인을 확정할 수는 없습니다. 업데이트 후에도 지속되면 회사망에서 `https://oidc.<SSO 리전>.amazonaws.com/token` 통신이 허용되는지 확인하세요. Identity Center 로그인에는 회사 포털 주소와 실제 SSO 리전을 함께 지정합니다. 예: `auth.cmd login --provider identity-center --start-url https://YOUR-ORGANIZATION.awsapps.com/start --region ap-northeast-2`. 인증서 검증을 끄거나 임의로 DIRECT로 우회하지 마세요.

## 도구·검색·복구

OMP 도구는 사용자 권한으로 실행합니다. Full Access는 파일 변경·명령 실행을 건별 승인 없이 허용하므로 신뢰하는 작업에서만 선택하세요. Passession OMP 모드는 Full Access, Write Approval, Always Ask이며 OS 샌드박스가 아닙니다. 플러그인 신뢰와 실제 계정 로그인은 별도 승인입니다.

`web_search`는 같은 Kiro 인증으로 Kiro `/mcp`에 검색을 요청하고 출처·인용·재현 제한을 보존합니다. 이 검색 도구가 반환 URL을 자동으로 가져오거나 다른 검색 서비스로 fallback하지는 않습니다. OMP의 다른 도구를 사용자가 실행하여 별도 네트워크 요청을 하는 것까지 막는 기능은 아닙니다.

Kiro HTTP의 일시적인 연결·DNS·소켓·HTTP 오류는 사용자 취소 전까지 30초 주기로 재시도하며 더 긴 `Retry-After`를 지킵니다. 선택 모델·대화 ID·완료된 도구 결과를 유지하고, 중단 전에 표시한 텍스트를 한 번 보존하여 이어받습니다. 완료된 도구를 다시 실행해서 복구하지 않습니다. 이미 서비스가 받은 요청은 응답이 유실되어도 과금될 수 있으며 exactly-once를 보장하지 않습니다.

네이티브 Passession의 연결 복구는 해당 버전의 구현을 따릅니다. 예전 웹 UI에 적용했던 고정 30초 패치를 새 앱에도 적용했다고 주장하지 않습니다. 전송 수락 여부가 불명확한 변경 요청은 내역부터 확인하세요.

## 동봉 유틸리티

Python(`python.exe`, `python3.exe`)·ripgrep(`rg`)·jq·전체 Git Bash를 포함합니다. 런처의 자식 프로세스에만 PATH를 적용하고 활성 virtualenv/Conda의 Python을 우선합니다. 원래 HOME/USERPROFILE과 Git/SSH 설정은 유지합니다.

Python은 격리된 표준 라이브러리 유틸리티입니다. pip/ensurepip/Tk/과학 패키지·완전한 프로젝트 개발 환경은 포함하지 않으며 현재 폴더나 스크립트 옆 모듈을 자동 import하지 않습니다. 표준 입출력은 UTF-8이고 일반 파일은 `encoding="utf-8"`을 명시하세요. `-S`는 입출력 사용자 설정도 생략합니다. 세부 범위는 `manifests/utilities.json`과 `LICENSES/UTILITY-CHANGES.txt`에 있습니다.

Node wrapper의 프로세스별 V8 old-space 설정은 OMP/Bun·네이티브 앱·전체 RSS의 메모리 상한이 아닙니다. 실제 사용량은 동시 세션과 작업에 따라 달라집니다.

## 이전 데이터와 검증 한계

기존 0.5의 직접 HTTP 세션을 OMP 세션으로 자동 변환하지 않습니다. 새 네이티브/OMP 상태는 이전 기록과 분리하고 이전 기록을 삭제하지 않습니다. 과거 세션을 재개하려면 원래 배포본을 보관하세요. 새 패키지는 다른 사용 중인 Passession/OMP 설치를 업데이트하거나 재시작하지 않습니다.

개인 인증·설정·대화가 있는 데이터 폴더를 재배포하지 마세요. 현재 사용자와 SYSTEM용 ACL로 보호하지만 프로그램이 실행하는 모든 도구·OS 캐시를 한 폴더에 격리하는 샌드박스는 아닙니다.

OMP의 계정·설정·세션·모델은 `<data-dir>\omp\agent`에 저장합니다. 데이터 폴더와 사용자 홈이 서로 다른 드라이브이면 OMP의 부가 로그·캐시·worktree·런타임 상태는 홈의 `.kiro-internal-omp\<데이터 경로 해시>`에 따로 저장합니다(`doctor.cmd`의 `ompMachineRoot`). 기존 `~\.omp`와 공유하지 않습니다.

네이티브 앱은 Windows 세션당 한 인스턴스만 지원합니다. 다른 `paseo_sessions.exe`가 실행 중이면 실행기가 앱 기동을 거부합니다. **앱 시작 시 upstream이 HKCU 알림/AUMID·CLSID 등록을 자기 EXE 경로로 갱신합니다.** 설치된 Paseo Sessions의 알림 활성화 대상도 바뀔 수 있습니다. 완전히 무설치·레지스트리 무변경인 앱은 아니며, 이 영향이 허용되지 않는 PC에서는 `--no-app`과 CLI를 사용하세요.

`doctor.cmd --verify-all`은 파일 무결성을 확인하며 실서비스 로그인·추론 성공을 의미하지 않습니다. 제어된 upstream 검사도 실제 회사망·PAC·SSPI·계정 권한·할당량의 현장 검증을 대신하지 않습니다. **Server 2019/build 17763 호환성은 확인되지 않았습니다.** 최신 구성요소를 과거 OS에서 실행할 수 있다고 가정하지 마세요.
