# appback-ai-agent — Documentation

ClawClash(GC) 게임 참가 + 자율 학습 AI Agent 프레임워크.
npm 패키지로 배포되며 pm2로 상시 실행한다.

---

## 기준 문서와 갱신 원칙

아래 문서는 구현과 운영 판단의 기준 문서다. 기능, API 계약, 책임 경계 또는 운영 절차가 바뀌면 코드 변경과 같은 작업 단위에서 반드시 함께 갱신한다.

| 영역 | 기준 문서 |
|---|---|
| 전체 구조와 장기 방향 | `overview/ARCHITECTURE.md`, `design/AI_AGENT_ADVANCEMENT_PLAN.md` |
| AI Agent 실행 계획과 구현 상태 | `design/AI_AGENT_DEVELOPMENT_PLAN.md` |
| GC/AI 계층형 전략 v8.1 공동 계약 | `design/GC_AI_STRATEGY_V8_PLAN.md` |
| GC 서버 학습 데이터 계약 | `design/GC_TRAINING_DATA_INTEGRATION.md` |
| 성격 관리자 CLI | `operations/PERSONALITY_CLI_GUIDE.md` |
| operation·데이터·모델 격리 | `operations/OPERATION_VERSION_GUIDE.md` |

갱신 규칙:

1. 구현을 완료하면 계획서의 구현 상태와 완료 조건을 동시에 갱신한다.
2. AI Agent와 GC 양쪽에 영향을 주는 변경은 연동 계약에 필드, 책임 주체, 전환 순서와 호환성 영향을 기록한다.
3. 관리자 명령이나 적용 시점이 바뀌면 운영 가이드와 CLI help를 함께 갱신한다.
4. 미구현 항목은 완료처럼 쓰지 않고 `pending`, `implemented`, `deployed`를 구분한다.
5. 임시 대화나 작업 보고만을 계약 근거로 사용하지 않는다. 최종 합의는 기준 문서에 남긴다.

## 문서 구조

### Overview (개요)
- [ARCHITECTURE.md](overview/ARCHITECTURE.md) — 시스템 아키텍처, 기술 스택, 런타임 모드
- [BATTLE_SYSTEM.md](overview/BATTLE_SYSTEM.md) — GC 배틀 메커니즘, 점수/보상 체계, 최적 전략

### Operations (운영)
- [INSTALL.md](operations/INSTALL.md) — 신규 서버 설치 절차
- [DEPLOYMENT.md](operations/DEPLOYMENT.md) — 배포/업데이트 절차
- [AGENTS.md](operations/AGENTS.md) — 운영 중인 에이전트 인벤토리
- [TROUBLESHOOTING.md](operations/TROUBLESHOOTING.md) — 트러블슈팅 가이드
- [PERSONALITY_CLI_GUIDE.md](operations/PERSONALITY_CLI_GUIDE.md) — Easy/Expert 성격 설정 CLI 가이드
- [OPERATION_VERSION_GUIDE.md](operations/OPERATION_VERSION_GUIDE.md) — 데이터·모델 운영 버전 격리 및 전환 가이드
- [EVALUATION_GUIDE.md](operations/EVALUATION_GUIDE.md) — 재현 가능한 미로 평가와 품질 게이트 운영 가이드

### Design (설계)
- [MODEL_UPLOAD.md](design/MODEL_UPLOAD.md) — ONNX 모델 업로드 설계
- [TRAINING_PIPELINE.md](design/TRAINING_PIPELINE.md) — 자동 학습 파이프라인
- [AI_AGENT_ADVANCEMENT_PLAN.md](design/AI_AGENT_ADVANCEMENT_PLAN.md) — 미로 대응, 학습 프로필, v8 데이터 계약 고도화 계획
- [AI_AGENT_DEVELOPMENT_PLAN.md](design/AI_AGENT_DEVELOPMENT_PLAN.md) — 관리자 성격 Easy/Expert 모드, CLI, 학습·평가 실행 계획
- [GC_AI_STRATEGY_V8_PLAN.md](design/GC_AI_STRATEGY_V8_PLAN.md) — 214차원/11전략, 공격 대상 선택과 GC 경로 실행 공동 계획
- [GC_TRAINING_DATA_INTEGRATION.md](design/GC_TRAINING_DATA_INTEGRATION.md) — GC v8 training frame·cursor·모델 revision 연동 계약

### Requests (외부 협업 요청)
- [REQUEST_GC_LOADOUT_PROFILE_CONTRACT.md](requests/REQUEST_GC_LOADOUT_PROFILE_CONTRACT.md) — 장비 선택 성격 식별자의 challenge/session 계약 보강 요청
- [REQUEST_SAME_IP_MATCHING_BLOCK.md](requests/REQUEST_SAME_IP_MATCHING_BLOCK.md) — 매칭 정책 요청
- [REQUEST_TICK_WEAPON.md](requests/REQUEST_TICK_WEAPON.md) — Tick state weapon 필드 추가 (완료)

### Archive (완료/폐기)
- [PLAN_cancelled_game_fix.md](archive/PLAN_cancelled_game_fix.md) — 취소 게임 처리 (완료)

---

## 빠른 참조

| 항목 | 위치 |
|---|---|
| 소스 코드 | GitHub: `appback/appback-ai-agent` |
| npm 패키지 | `appback-ai-agent` (appbackhub 계정) |
| GC API | `https://clash.appback.app/api/v1` |
| AI Rewards | `https://rewards.appback.app` |
