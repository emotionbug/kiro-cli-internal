# Paseo + OMP + Kiro HTTP · Windows x64

**오프라인 설치용 실험 배포**입니다. 대상 PC에서 npm 설치·네이티브 컴파일·Kiro CLI 설치를 요구하지 않습니다. Kiro 로그인·모델 목록·사용량·검색·응답 생성에는 승인된 Kiro/인증 HTTPS 프록시·게이트웨이가 필요합니다. Kiro 경로까지 차단된 완전한 망 분리에서는 클라우드 기능을 사용할 수 없습니다.

## 구성과 사용

- 기본 경로: **Paseo → OMP → Kiro HTTP**. 선택형 OMP 없는 직접 HTTP 제공자도 포함합니다.
- Node 22.23.4, Paseo 0.13.0, OMP 18.12.6, omp-kiro 0.4.4를 고정합니다.
- Python 3.13.12 표준 라이브러리·python3 별칭, ripgrep 15.1.0, jq 1.8.1, 전체 Git Bash를 동봉합니다. pip/서드파티 Python 패키지는 포함하지 않습니다.
- 새 로컬 폴더(예: `C:\KiroOffline`)에 ZIP 전체를 풀고 `setup.cmd` → `auth.cmd login` → `start.cmd` 순서로 실행합니다.
- 승인된 최신 Edge/Chrome에서 `http://127.0.0.1:16767`을 열고 **Direct connection**으로 같은 서버 주소를 등록합니다. 개인 비밀번호로 접속한 뒤 `Kiro HTTP (OMP)`를 선택합니다.
- `models.cmd`: 실제 계정의 모델 목록과 계정 결합 스냅샷을 갱신합니다. 새 세션/OMP 재로드에 반영합니다.
- `usage.cmd`: 계정 할당량을 조회합니다. Paseo SDK에서도 할당량을 제공합니다.
- `omp.cmd`: 독립 OMP TUI. `stop.cmd`: 이 패키지의 데몬만 종료합니다.

## 요청한 동작

- 인터넷/DNS/연결 단절과 일시적 HTTP 오류는 **30초 고정 주기, 사용자 취소 전까지** 같은 모델로 재시도합니다. 더 긴 Retry-After는 존중합니다.
- OMP의 중단된 부분 텍스트를 이어가며 완료한 도구를 다시 실행하지 않도록 복구합니다. 모호한 전송의 서버 측 중복 과금이나 모든 실패에 대한 exactly-once는 보장하지 않습니다. 인증·TLS·권한·계정 한도·프로토콜 오류는 무한 재시도하지 않습니다.
- 기본 **Full access**: 건별 도구 승인창 없이 실행합니다. 최초 플러그인 신뢰 검토와 Kiro 로그인 승인은 별도입니다. 명시적으로 선택한 Ask/Plan은 유지합니다.
- 기본 `web_search`는 같은 Kiro 인증으로 **Kiro `/mcp`**에 요청합니다. Exa/Brave fallback이나 검색 결과 URL의 직접 본문 다운로드는 하지 않습니다. 출처·인용 ID·재현 제한을 보존합니다. 원격 `web_fetch`가 있다고 가정하지 않습니다.
- Windows WinHTTP PAC + 현재 사용자 SSPI 네이티브 helper를 재사용합니다. 내부 API·Git·MCP 주소를 Kiro 도메인으로 제한하지 않습니다. 내부망 DIRECT/프록시 예외는 시스템/PAC 모드로 유지합니다. 수동 고정 프록시 모드는 내부 주소도 그 프록시를 경유합니다.
- 승인된 사설 CA를 지원하며 TLS 검증을 끄지 않습니다. 시스템 프록시/인증서 저장소를 변경하지 않습니다.
- 전용 홈/데이터를 사용합니다. 기존 Git/SSH 설정·인증은 자동 복사하지 않으므로 필요한 명시적 도구 설정을 적용하세요.
- 전달된 전용 데몬 주소가 실패해도 다른 `localhost:6767` 인스턴스로 자동 fallback하지 않습니다. 기본 서버 수신은 로컬 `127.0.0.1:16767`뿐입니다.
- 모델의 도구 선택/Python 사용을 제한하는 지침은 추가하지 않습니다.

## 검증과 메모리

실제 배포 ZIP을 Windows Server 2022 CI의 새 한글·공백 경로에 풀어 검사했습니다. OMP 파일 쓰기·완료 도구 중복 실행 방지·부분 응답 복구·동일 명시 모델 유지·Kiro 검색 및 인용 전달·계정 모델 스냅샷·CLI/SDK 할당량·ConPTY TUI·Chrome 첫 화면·격리된 종료·전체 파일 무결성이 통과했습니다. 두 실제 재시도 간격은 약 **30.017초 / 30.018초**였습니다.

Node 22/24 검사와 실제 Bun 1.3.11 CA 신뢰·잘못된 인증서/호스트명 거절·취소 경계도 통과했습니다. 검색 도구 자체는 기존 실제 Kiro 인증으로 검색 10건을 반환한 별도 관측이 있습니다. 제어된 모델 fixture를 실제 Kiro 응답 생성의 증거로 취급하지 않습니다.

- 네이티브 PAC helper: 40개 목적지·동시 터널 8개 후 **private 약 1.83 MiB / working set 약 5.77 MiB**. 이는 helper만의 측정값입니다.
- 완료한 에이전트 1개의 Paseo+OMP 스택: 합산 working set 약 **827 MiB**, private 약 **940 MiB**. 별도 Chrome 스택은 합산 working set 약 **679 MiB**, private 약 **387 MiB**였습니다.
- 위 값은 해당 CI의 표본이며 전체 RSS/힙 상한이나 고유 물리 메모리 합계가 아닙니다. Node old-space 기본 상한 256 MiB는 프로세스별 V8 old-space만 제한합니다. 브라우저·Bun·Paseo 전체가 32 MiB라는 뜻이 아닙니다.

첨부된 `report.json`, `reconnect.json`, `startup.json`, `utilities.json`, `bundle-manifest.json`, `web-ui.png`, `release-verification.json`에서 범위와 무결성 정보를 확인할 수 있습니다. 브라우저의 벤더 백그라운드 요청은 CI의 별도 거부 프록시로 막았으며, 페이지의 외부 HTTP/WebSocket 요청과 애플리케이션의 비-Kiro upstream 요청은 별도로 검사했습니다. 이 CI 전용 차단 플래그는 배포 실행기에 넣지 않습니다.

## 미검증 범위

- **Server 2019 / build 17763과 실제 회사 내부주소·PAC·SSPI 정책은 현장 미검증**입니다. `server2019Verified: false`를 유지합니다.
- 실제 Kiro 응답 생성은 알려진 월 사용량 한도 소진 때문에 재요청하지 않았습니다.
- 브라우저 검증은 비인증 첫 화면까지입니다. 인증된 에이전트 동작/사용량은 CLI와 SDK로 검증했으며 인증 후 브라우저 조작은 미검증입니다.
- WezTerm GUI, 로컬 음성 모델, 원격 전체 페이지 가져오기, PAC 대체 프록시 자동 failover는 검증/지원 범위에 포함하지 않습니다.
- 비공식 HTTP/OAuth 재구현이므로 회사의 보안·서비스 정책과 실행 파일 허용목록을 검토해야 합니다.
