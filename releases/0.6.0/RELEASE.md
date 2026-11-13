# Passession + OMP + Kiro HTTP 0.6.0 — Windows x64

## 변경사항

- JavaScript Paseo 데몬·웹 UI를 Passession 0.13.15의 공식 Rust 데몬과 네이티브 데스크톱 앱으로 교체했습니다. OMP 18.20.0의 `rpc-ui` 제공자에 `omp-kiro` 0.4.8을 연결합니다.
- Node.js 26.13.1 LTS, Python 3.15.2 표준 라이브러리, ripgrep 15.2.0, jq 1.8.2, 전체 Git for Windows 2.56.1.windows.1을 동봉합니다. 별도 Bun·npm 설치는 필요하지 않습니다.
- Windows 시스템/PAC·HTTP/CONNECT·현재 사용자 SSPI 프록시를 유지합니다. Node와 OMP/Bun에 승인된 공개 CA를 전달하며 TLS·호스트명 검증을 해제하지 않습니다.
- OMP의 공식 카탈로그·제공자 레지스트리에서 95개 기본 제공자를 비활성화하는 설정을 생성합니다. Kiro 외 제공자의 자동 모델 조회와 OMP 시작 시 업데이트·marketplace 조회를 중지합니다. 프록시 허용목록을 넓히거나 요청 실패를 숨기는 방식이 아닙니다.
- 네이티브·OMP 상태는 과거 직접 HTTP 세션과 분리합니다. 과거 기록을 삭제·자동 변환하지 않으며 기존 사용자 `~/.omp`와 공유하지 않습니다. 다른 드라이브의 데이터 폴더는 별도 홈 하위 부가 캐시를 사용합니다.
- 빌드는 Windows x64 MSVC 환경의 단일 `build/build-bundle.mjs` 명령으로 수행합니다. Ubuntu 포크 빌드, `--paseo-fork`, 이전 웹 UI 재접속 패치는 제거했습니다.

## 실행과 주의사항

새 폴더에 압축을 풀고 `setup.cmd` → 승인된 `network.cmd` 설정 → `auth.cmd login` → `models.cmd` → `start.cmd` 순서로 실행합니다. CLI만 사용할 때는 `start.cmd --no-app` 및 `paseo.cmd`, OMP 터미널은 `omp.cmd`입니다. 모델 선택자는 `kiro-http/<실제 계정 모델 ID>`입니다. 종료는 `stop.cmd`이며 데스크톱 창은 별도로 닫습니다.

설치·기동에는 다운로드가 없지만 Kiro 인증·조회·검색·추론에는 승인된 HTTPS 연결이 필요합니다. 완전 망 분리에서 클라우드 추론을 제공하지 않습니다. Python은 표준 라이브러리 유틸리티이며 pip·Tk·과학 패키지나 완전한 개발 환경은 아닙니다.

**네이티브 앱은 시작 시 HKCU 알림/AUMID·CLSID 등록을 자신의 EXE로 갱신합니다.** 기존 Paseo Sessions의 알림 활성화 대상도 바뀔 수 있습니다. 레지스트리 변경이 허용되지 않으면 `--no-app`과 CLI를 사용하세요. Windows 세션당 앱 한 인스턴스만 지원하며 다른 인스턴스를 자동 종료하지 않습니다. 세부 사항은 동봉 `README.ko.md`를 참조하세요.

## 확인한 로컬 검증

다음은 2026-11-13 Windows x64 build 26200에서 조립한 ZIP을 새 한글 경로에 풀어 수행한 기록입니다. 개별 배포의 SHA-256·파일 목록·결과는 해당 `bundle-manifest.json`, `report.json`, `utilities.json`을 기준으로 확인하세요.

| 검증 | 결과 |
|---|---|
| 개인 상태·프록시 회귀 | 37개 통과, 실패·스킵 0개. 실제 Windows `AcceptSecurityContext`와 현재 사용자 Negotiate의 HTTP/CONNECT 인증 포함 |
| 유틸리티 | PATH Python, Git Bash Python, Git Bash Python3에서 SQLite → rg → jq의 한글 내용·정확한 합계·검색 위치·숫자 타입 확인 |
| 실제 네이티브 연결 | Passession CLI → 실제 OMP → Kiro HTTP → 네이티브 프록시 경로 통과 |
| 파일·검색·모델 | 실제 파일 내용, 완료된 쓰기 비반복, 검색 인용·재현 제한, 6회 요청의 선택 모델 유지 확인 |
| HTTP 복구 | HTTP 503 후 30.028초, 부분 스트림 단절 후 30.010초에 복구. 중단 전 텍스트와 도구 결과 보존 |
| 영속성·종료 | 데몬 재시작 후 같은 대화 재개, 관련 없는 로컬 서비스 보존, 실행 전후 패키지 무변경 확인 |
| 외부 조회·TLS | Kiro 외 자동 프록시 요청 0건. 신뢰하지 않는 인증서 거부·승인된 CA 수용 확인 |

실서비스를 대신하는 제어된 HTTPS 서버와 폐기 가능한 계정 데이터로 검증했습니다. 실제 Kiro 계정의 클라우드 추론·회사 PAC/SSPI 정책·AppLocker/WDAC·Server 2019는 미검증입니다. **GUI 실행은 기존 설치의 알림 등록을 보존하기로 한 사용자 선택에 따라 보류했습니다.** 네이티브 CLI 검증을 GUI 검증으로 표시하지 않습니다.
