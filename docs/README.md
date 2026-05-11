# appback-ai-agent — Documentation

ClawClash(GC) 게임 참가 + 자율 학습 AI Agent 프레임워크.
npm 패키지로 배포되며 pm2로 상시 실행한다.

---

## 문서 구조

### Overview (개요)
- [ARCHITECTURE.md](overview/ARCHITECTURE.md) — 시스템 아키텍처, 기술 스택, 런타임 모드
- [BATTLE_SYSTEM.md](overview/BATTLE_SYSTEM.md) — GC 배틀 메커니즘, 점수/보상 체계, 최적 전략

### Operations (운영)
- [INSTALL.md](operations/INSTALL.md) — 신규 서버 설치 절차
- [DEPLOYMENT.md](operations/DEPLOYMENT.md) — 배포/업데이트 절차
- [AGENTS.md](operations/AGENTS.md) — 운영 중인 에이전트 인벤토리
- [TROUBLESHOOTING.md](operations/TROUBLESHOOTING.md) — 트러블슈팅 가이드

### Design (설계)
- [MODEL_UPLOAD.md](design/MODEL_UPLOAD.md) — ONNX 모델 업로드 설계
- [TRAINING_PIPELINE.md](design/TRAINING_PIPELINE.md) — 자동 학습 파이프라인

### Requests (외부 협업 요청)
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
