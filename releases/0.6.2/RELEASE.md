# Passession + OMP + Kiro HTTP 0.6.2

## 구성요소 갱신

| 구성요소 | 이전 → 현재 |
|---|---|
| Passession 앱·Rust 데몬/CLI | 0.13.15 → 0.13.35 |
| OMP standalone | 18.20.0 → 18.22.0 |
| omp-kiro HTTP 플러그인 | 0.4.8 → 0.5.2 |

Passession과 OMP는 확인 시점의 최신 안정 릴리스입니다. omp-kiro는 별도 태그·릴리스가 없어 main의 0.5.2 소스를 `e2dba938acd89c60e5d3f2e269c9047a5a038ddf`로 고정합니다. 모든 입력은 SHA-256으로 검증합니다. Python 표준 라이브러리·ripgrep·jq·전체 Git Bash는 유지하며, 0.6.1의 SSO 프록시 연결 고갈 수정도 유지합니다.

Passession은 새 공식 app·daemon component ZIP을 사용합니다. 파일별 해시·소스 식별자·ABI를 검증하고 설치기는 실행하지 않습니다. 이전 번들과 동일하게 실행 중 자동 버전 변경과 내장 Tailscale은 제공하지 않습니다. GUI의 Windows 알림 등록 동작은 upstream 구현을 따릅니다.

전용 데몬에서 Antigravity·Muse·Hoplite 제공자도 명시적으로 비활성화합니다. 설치된 다른 CLI를 자동 탐색하며 해당 계정의 네트워크 요청을 발생시키지 않도록 하기 위한 것으로, 원래 사용자 HOME·Git·SSH 설정을 변경하거나 다른 프로그램을 삭제하지 않습니다.

## 인증·프로필

- `auth.cmd profiles --usage`: 사용 가능한 프로필과 사용량 조회
- `auth.cmd profile`: 현재 선택 조회
- `auth.cmd profile --profile "ARN 또는 고유한 이름"`: 프로필 선택
- OMP의 `/kiro-profiles`, `/kiro-profile`로도 조회·변경할 수 있습니다. 변경 후 `models.cmd`로 Passession 모델 목록을 갱신하세요.
- 계정 모델 메타데이터에 따라 지원되는 추론 수준 선택을 구성합니다. 고정된 임의 모델로 대체하지 않습니다.

## 업데이트

1. 이전 폴더에서 `stop.cmd`를 실행하고 Passession 앱과 해당 OMP 터미널을 닫습니다.
2. 새 ZIP을 새 폴더에 풉니다. 이전 설치 위에 덮어쓰지 마세요.
3. 새 폴더의 `setup.cmd`에서 변경된 플러그인 코드를 검토·승인합니다.
4. `models.cmd` 후 `start.cmd`로 실행합니다.

동일한 사용자 데이터 경로를 사용하면 기존 인증·설정·대화 기록을 보존합니다. 별도 `--data-dir`를 사용했다면 같은 경로를 지정하세요. 다시 로그인하거나 인증 DB를 삭제할 필요는 없습니다.

## 검증 범위

배포 ZIP의 검증 소스 SHA·실행 링크·해시는 아래 배포 무결성 근거로 확인하세요. 합성 계정과 제어된 TLS 서버의 검사는 실제 회사망·AWS 계정 추론 성공을 뜻하지 않습니다. 기존 설치의 알림 등록을 보존하는 사용자 선택에 따라 GUI 실행은 보류하며 Windows Server 2019도 미검증입니다.
