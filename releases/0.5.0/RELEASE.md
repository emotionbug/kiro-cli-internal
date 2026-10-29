# Paseo + Kiro HTTP 0.5.0 · Windows x64 portable

**Paseo → Kiro HTTP → 선택한 계정 모델** 경로만 제공하는 오프라인 설치 패키지입니다. OMP, WezTerm, Kiro CLI, Claude CLI/SDK, 다른 에이전트 CLI와 네이티브 음성 런타임을 배포하지 않습니다. Kiro가 Claude 계열 모델을 제공하는 것과 Claude CLI를 실행하는 것은 별개입니다.

## 이번 변경

- 범용 Paseo 패키지에 따라오던 CLI 제공자·불필요한 네이티브 런타임을 제거했습니다. 실제 플러그인 등록·사용량 API·Paseo 자체 터미널에 필요한 PTY와 플러그인 변환기는 유지합니다. 대체용 가짜 모듈을 넣지 않습니다.
- **사용자 포크 [`emotionbug/paseo@c3bac24`](https://github.com/emotionbug/paseo/commit/c3bac24ccc2df8dcc67d807c805db0efa0817dff)의 서버·CLI·관련 7개 workspace·웹 UI를 함께 빌드**합니다. 세션 중심 탐색, diff 초기 표시/스크롤 최적화와 브라우저 자동화 지연 시작 변경을 포함합니다. 내부 버전 표시는 0.13.0이므로 실제 소스는 `doctor.cmd`의 `paseoSource`로 확인하세요.
- HTTP 플러그인 0.4.6을 고정합니다. Windows short-name/junction 또는 POSIX symlink 별칭으로 지정한 작업 폴더 내부 파일도 실제 경로로 확인한 뒤 읽고 쓸 수 있습니다. 상대 경로의 외부 이동과 물리적으로 폴더 밖을 가리키는 링크는 계속 차단합니다.
- 네트워크·DNS·소켓 단절과 일시적 HTTP 오류를 같은 모델·대화 ID로 **30초 고정 주기, 취소 전까지** 재시도합니다. 더 긴 Retry-After는 지킵니다. 이미 표시한 텍스트를 문맥에 한 번 유지하고 이어받아 추가형 Paseo 스트림에서 텍스트를 지우거나 중복해서 붙이지 않습니다. 완전한 응답 이전의 도구 조각은 실행하지 않으며 완료된 도구를 자동 재시도로 다시 실행하지 않습니다.
- Paseo 재접속도 30초 주기입니다. 수락 여부가 불명확한 프롬프트는 자동 재전송하지 않습니다. 전달된 전용 서버가 일시 연결 실패/비밀번호 요구 상태여도 다른 `localhost:6767`을 대신 탐색하지 않습니다.
- 실제 계정에 결합된 모델 스냅샷을 기본으로 사용합니다. 임의 모델 목록·자동 모델 변경·다른 제공자로 fallback하지 않습니다. ID는 실제 계정의 원래 ID이며 OMP 접두어를 사용하지 않습니다.
- Kiro 인증을 사용하는 기본 `web_search`, 계정 사용량 조회, 독립 OAuth 로그인, 내부망·Windows PAC·SSPI·사설 CA 지원을 유지합니다.
- **Python 3.13.12 표준 라이브러리·python3 별칭, ripgrep 15.1.0, jq 1.8.1, 전체 Git Bash**를 유지합니다. 모델의 도구 선택이나 Python 사용을 제한하는 지침은 추가하지 않습니다.
- HOME/USERPROFILE은 원래 사용자 값을 유지하여 Git/SSH 설정을 사용할 수 있습니다. Paseo home·인증·모델 스냅샷과 네이티브 대화 기록은 명시적인 전용 데이터 경로를 사용합니다. 인증서 저장소·시스템 프록시·시스템 PATH는 수정하지 않습니다.

## 설치와 실행

1. 실행 ZIP 전체를 **새 로컬 폴더**에 풉니다. 0.4.0 위에 덮어 풀지 마세요. GitHub의 자동 `Source code.zip`은 실행 패키지가 아닙니다.
2. `setup.cmd`로 비샌드박스 플러그인 신뢰를 검토·승인하고 개인 Paseo 비밀번호를 설정합니다.
3. `auth.cmd login`으로 본인 Kiro 계정에 로그인합니다. device 링크는 다른 승인된 브라우저/기기에서 열어도 됩니다.
4. `start.cmd`를 실행하고 기존 승인된 최신 Edge/Chrome에서 `http://127.0.0.1:16767`을 엽니다. **Direct connection**에 `127.0.0.1:16767`을 등록하고 개인 비밀번호로 접속한 뒤 **Kiro HTTP**로 새 세션을 만듭니다.
5. `models.cmd`, `usage.cmd`, `doctor.cmd --verify-all`로 모델·사용량·무결성을 확인합니다. 종료는 `stop.cmd`입니다.

기존 전용 데몬은 이전 배포의 `stop.cmd`로 종료한 뒤 새 패키지를 시작하세요. 다른 OMP/Paseo 인스턴스를 종료하거나 기존 대화 파일을 삭제하지 않습니다. OMP 세션을 네이티브 HTTP 세션으로 자동 변환하지 않으므로 그 세션을 재개하려면 기존 0.4.0 배포본을 보관하세요.

기본 도구 정책은 사용자가 선택한 **Full access**입니다. 파일 변경·삭제·명령 실행을 건별 승인 없이 사용자 권한으로 수행합니다. 최초 플러그인 신뢰·로그인은 별도이며 명시적으로 선택한 Ask/Plan은 유지합니다. 계정 데이터 기본 경로는 `%LOCALAPPDATA%\KiroInternal`, 네이티브 기록은 그 아래 `.local\state\omp-kiro\paseo`입니다. 다른 위치는 각 명령에 동일한 `--data-dir 절대경로`를 지정하세요.

## 폐쇄망·내부망

오프라인 설치에 외부 다운로드·npm 설치·컴파일이 필요하지 않습니다. **로그인·목록·사용량·검색·추론에는 승인된 Kiro/인증 서비스 경로가 필요**합니다. 그 경로까지 차단된 완전 망 분리에서는 클라우드 기능을 사용할 수 없습니다.

검색은 Kiro `/mcp`가 수행합니다. PC는 출처 URL을 자동으로 열거나 본문을 내려받지 않으며 Exa·Brave 등 별도 검색 API로 fallback하지 않습니다. 결과·발췌·인용·재현 제한을 보존하지만 원격 `web_fetch`를 제공한다고 가정하지 않습니다. 첨부한 `kiro-web-search-observation.json`은 기존 실제 Kiro 검색 관측 자료이며, 이번 패키지로 실서비스 응답 생성을 새로 검증한 자료는 아닙니다.

시스템/PAC 모드는 내부 주소의 DIRECT/프록시 예외를 사용하며 내부 API·Git·MCP를 Kiro 도메인으로 제한하지 않습니다. 수동 고정 프록시는 내부 주소도 경유하므로 내부망 예외가 필요하면 시스템/PAC 모드를 사용하세요. TLS/호스트명 검증을 유지하고 upstream 인증에는 현재 사용자의 SSPI를 사용합니다. PAC 오류를 DIRECT로 숨기지 않습니다. SOCKS·HTTPS upstream·PAC 대체 프록시 자동 failover·PAC 파일 서버 인증 위임은 지원하지 않습니다. CONNECT PAC는 전체 암호화 경로가 아닌 호스트/포트 기준입니다.

## 출처·검증 범위

- 사용자 포크 소스: `c3bac24ccc2df8dcc67d807c805db0efa0817dff`, 아카이브 SHA-256 `f2351ac409c8fe5228636b0d587b7a9d992ffe276400d1cfb3e40b1a7f4b79ff`.
- HTTP 플러그인 소스: `92d92161471c849780899264a9dc345bc7f7e82e`, 0.4.6. [Node 22/24·실제 HTTP continuation·경로 별칭 회귀 검사](https://github.com/emotionbug/omp-kiro/actions/runs/40813782567)를 통과했습니다.
- source/compiled 투영은 해시와 AST 경계를 확인하며 원본·결과·제거 구성·실제 파일 목록은 `bundle-manifest.json`, `LICENSES/`에 기록합니다. 사용자 포크 전체 소스 아카이브나 개발용 node_modules는 실행 ZIP에 넣지 않습니다. 필수 라이선스·소스 고지는 유지합니다.
- Windows 배포 게이트는 실제 ZIP을 한글·공백 경로에 풀어 private-state/PAC/유틸리티/실제 native HTTP 도구·30초 복구·검색·사용량·재접속·브라우저·종료·전체 파일 무결성을 검사한 산출물만 공개합니다. ZIP 재빌드 없이 모든 내부 파일과 업로드 자산 digest를 확인한 뒤 Release를 공개합니다.
- `report.json`, `reconnect.json`, `utilities.json`, `web-ui.png`가 해당 배포의 실행 증거이고 `release-verification.json`은 ZIP 전체 해시·파일별 검증·실제 압축 구성별 크기입니다. 브라우저는 비인증 첫 화면과 실제 로드된 큐 처리 모듈을 검증하며, 인증된 브라우저 조작은 별도 검증이 필요합니다.
- **Windows Server 2019/build 17763과 실제 회사 PAC/SSPI 정책은 현장 미검증**입니다. 최신 CI Windows 통과를 해당 OS 인증으로 표시하지 않으며 `server2019Verified:false`를 유지합니다.
- 제어된 Kiro upstream은 실서비스 계정의 응답 생성 증명이 아닙니다. 알려진 계정 사용량 한도 때문에 실서비스 추론을 다시 요청하지 않았습니다. OAuth 일회용 교환/refresh의 모호한 성공 여부·영구 인증/권한/인증서/할당량 오류를 무한 재시도로 숨기지 않습니다. 생성 요청이 도착한 뒤 응답이 유실되면 추가 과금될 수 있으며 클라우드 exactly-once를 보장하지 않습니다.

## 이번 Windows 실행 결과

[Windows Server 2022 전체 ZIP 검증](https://github.com/emotionbug/kiro-cli-internal/actions/runs/40813785340)을 통과했습니다. 검증 소스는 `7dbe8ee815c3e67abd43a89202ebfe6e2c3480da`입니다.

- 실제 기본 `kiro-http` 제공자, Full access, 파일 쓰기·Kiro `web_search`·사용량·계정 결합 모델 스냅샷을 확인했습니다. 5회 생성 요청 모두 같은 `fixture-named` 모델을 사용했고 시작 시 실시간 모델 재조회는 없었습니다.
- HTTP 503 전출력 실패 후 약 **30.018초**, 부분 응답 소켓 단절 후 약 **30.024초** 뒤 재시도했습니다. 받아 둔 텍스트는 한 번 유지됐고 완료된 파일 쓰기는 재실행되지 않았습니다.
- 원래 작업 경로가 실제 경로와 다른 Windows 별칭임을 확인한 상태에서 실제 파일 쓰기를 완료했습니다. 네이티브 대화 기록도 전용 데이터 폴더에 저장됐습니다.
- 수락된 요청과 응답 확인이 유실된 요청 모두 WebSocket 복구 후 원래 대화·완료 도구·내역이 복원됐습니다. 각 프롬프트/도구 실행은 한 번이었고 종료 후 30초가 지나도 다시 연결하지 않았습니다.
- 실제 Chrome에서 새 포크의 웹 UI와 실제 로드된 production Metro 큐 함수를 실행했습니다. 전달 결과 불명/시간 초과는 큐에 되넣지 않았고 전송되지 않은 것이 알려진 요청만 큐에 남겼습니다. 외부 페이지 요청은 없었습니다. 로그인 이후의 브라우저 조작 전체를 검증한 것은 아닙니다.
- 완료 에이전트 1개·2초 idle의 애플리케이션 스택은 **working set 합 약 517 MiB, private bytes 합 약 516 MiB**였습니다. 이전 0.4.0의 같은 단계 관측값은 약 827/940 MiB였습니다. 별도 CI 관측 비교이며 브라우저는 제외합니다. working set 합은 공유 페이지를 중복 셀 수 있고 고유 물리 메모리·상한·일반적 성능 보장이 아닙니다.
- 전용 데몬 종료·반복 종료, 남은 owned 프로세스 0개, `doctor --verify-all`과 전체 파일 목록/내용 불변을 확인했습니다. 개인 fixture는 제거됐습니다.

## 실제 배포 크기·무결성

- ZIP: **299.7 MiB** / **314,289,089 bytes**. 이전 0.4.0의 590.3 MiB / 618,990,213 bytes보다 **49.2% 감소**했습니다.
- ZIP SHA-256: `9c97a9ba30f1ce4138cfd455f281c9e4bcb1cb9a85c9b134b75556523dba6f42`.
- ZIP 내부 **21,347개 파일**의 실제 크기·SHA-256, 외부/내부 manifest 일치, 업로드한 자산의 서버 digest를 확인했습니다.
- [공개 전 전체 ZIP 검증·승격](https://github.com/emotionbug/kiro-cli-internal/actions/runs/40815100551) / [검증 영수증](https://github.com/emotionbug/kiro-cli-internal/releases/download/v0.5.0/release-verification.json).

남은 압축 데이터의 주요 구성은 전체 Git Bash **157.4 MiB**, Paseo 의존성 **43.1 MiB**, 라이선스·소스 고지용 아카이브 **42.7 MiB**, Node **36.3 MiB**입니다. 구성별 수치는 ZIP 헤더/디렉터리 메타데이터를 제외한 실제 compressed entry bytes입니다. 유틸리티와 고지를 삭제하여 줄인 수치가 아닙니다.
