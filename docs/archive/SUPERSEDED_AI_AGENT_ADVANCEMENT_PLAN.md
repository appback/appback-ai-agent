# 대체됨: AI Agent 고도화 초기 계획

- 상태: v8.1 구현 완료로 대체·archive
- 과거 범위: v7 문제 진단, v8.0 `192 → 5` 방향 모델 제안, BFS teacher와 성격별 학습 계획
- 대체 이유: 운영 구조가 v8.1 `214 → 11` 계층형 전략 모델과 GC 서버 경로 실행기로 확정됨

초기 계획의 핵심 원칙 중 다음 항목은 현재 계약에 반영됐다.

- feature version/schema hash 기반 데이터·모델 격리
- authoritative raw state와 vector 수집
- profile별 teacher label과 sample weight
- deterministic 평가와 품질 gate
- 모델은 목표를 선택하고 서버가 BFS 경로와 실행을 담당

현재 기준 문서:

- 시스템 구조: `../overview/ARCHITECTURE.md`
- AI Agent 구현 상태: `../design/AI_AGENT_DEVELOPMENT_PLAN.md`
- v8.1 공동 계약·전환 이력: `../design/GC_AI_STRATEGY_V8_PLAN.md`
- wire/data 계약: `../design/GC_TRAINING_DATA_INTEGRATION.md`
- 운영 버전: `../operations/OPERATION_VERSION_GUIDE.md`

과거 전체 내용은 Git 이력에서 확인할 수 있다. 현재 구현 판단에는 위 기준 문서를 사용한다.
