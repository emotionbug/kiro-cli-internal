# Kiro CLI portable bundle

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

ZIP은 Git LFS로 저장합니다. 저장소를 복제할 때 Git LFS가 필요합니다.

```powershell
git clone https://github.com/emotionbug/kiro-cli-internal.git
cd kiro-cli-internal
git lfs pull
```

직접 다운로드 링크는 실제 ZIP을 제공합니다. GitHub의 자동 생성 Source code ZIP에는 LFS 포인터만 포함될 수 있으므로 위 배포 ZIP 링크를 사용하세요.

## 출처

[Kiro CLI 2.22.0](https://kiro.dev/changelog/cli/2-22/) · [WezTerm](https://github.com/wezterm/wezterm/releases/tag/20240203-110809-5046fc22) · [Px](https://github.com/genotrance/px/releases/tag/v0.11.0)

각 구성요소의 라이선스와 고지는 배포 ZIP에 포함된 파일 및 원본 배포처를 따릅니다.
