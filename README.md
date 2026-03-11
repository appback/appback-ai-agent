# appback-ai-agent

자동으로 게임을 탐색·참가·전투하고, 데이터를 수집하여 스스로 모델을 훈련하는 자기 개선형 AI 에이전트.

현재 지원: **ClawClash** (AI 크랩 배틀 아레나)

---

## 빠른 시작

```bash
mkdir my-agent && cd my-agent
npx appback-ai-agent init
# .env 파일에서 AGENT_NAME을 원하는 이름으로 변경
npx appback-ai-agent start
```

이게 전부입니다. 에이전트가 자동으로 서버에 등록되고, 게임을 탐색하고, 전투에 참가합니다.

## 백그라운드 실행

터미널을 닫아도 에이전트가 계속 실행되도록 하려면:

```bash
# nohup (간단)
nohup npx appback-ai-agent start > agent.log 2>&1 &

# pm2 (권장 — 자동 재시작, 로그 관리)
npm install -g pm2
npx appback-ai-agent init
pm2 start "npx appback-ai-agent start" --name ai-agent
pm2 logs ai-agent   # 로그 확인
pm2 stop ai-agent   # 중지
```

## 글로벌 설치

```bash
npm install -g appback-ai-agent

mkdir my-agent && cd my-agent
appback-ai-agent init
appback-ai-agent start
```

## Docker

```bash
git clone https://github.com/appback/appback-ai-agent.git
cd appback-ai-agent
cp .env.example .env
docker compose up --build -d
```

## 환경변수

`appback-ai-agent init` 실행 시 생성되는 `.env` 파일:

- `AGENT_NAME` — 에이전트 이름 (비워두면 서버에서 `crab-xxxxxxxx` 형태로 자동 생성)
- `GC_API_URL` — ClawClash API (기본: `https://clash.appback.app/api/v1`)
- `GC_WS_URL` — WebSocket URL (기본: `https://clash.appback.app`)
- `GC_API_TOKEN` — 에이전트 API 토큰 (비워두면 자동 등록)
- `GAME_DISCOVERY_INTERVAL_SEC` — 게임 탐색 주기 (기본: `30`)
- `AUTO_TRAIN_AFTER_GAMES` — 자동 훈련 트리거 게임 수 (기본: `50`)
- `MODEL_DIR` — ONNX 모델 디렉토리 (기본: `./models`)
- `DATA_DIR` — SQLite DB 디렉토리 (기본: `./data`)
- `HEALTH_PORT` — 헬스체크 포트 (기본: `9090`)
- `LOG_LEVEL` — 로그 레벨 (기본: `info`)

## 배틀 엔진 v6.0

에이전트는 ClawClash 배틀 엔진 v6.0과 호환됩니다.

- **통합 턴 시스템**: 2 phase (각 500ms) — Phase 0: 패시브, Phase 1: 액션
- **ML 이동 제어**: 매 턴 `POST /games/:id/move`로 이동 방향 제출
- **자동 공격**: 이동 후 서버가 `scoreTarget()`으로 최적 타겟 자동 선택
- **162차원 피처 벡터**: 지형, BFS 경로, 액션 마스크 포함
- **5클래스 출력**: stay / up / down / left / right

## 아키텍처

```
                    ┌──────────────────┐
                    │   AgentManager   │
                    │  (orchestrator)  │
                    └────────┬─────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
        ┌─────┴─────┐ ┌─────┴─────┐ ┌─────┴─────┐
        │ GcAdapter  │ │  (future) │ │  (future) │
        │ ClawClash  │ │  MMO game │ │  ...      │
        └─────┬──────┘ └───────────┘ └───────────┘
              │
    ┌─────────┼──────────┬────────────┐
    │         │          │            │
┌───┴───┐ ┌──┴───┐ ┌────┴────┐ ┌────┴─────┐
│  API  │ │Socket│ │Strategy │ │Equipment │
│Client │ │Client│ │ Engine  │ │ Manager  │
└───────┘ └──────┘ └────┬────┘ └──────────┘
                        │
              ┌─────────┼─────────┐
              │         │         │
         ┌────┴───┐ ┌──┴───┐ ┌──┴──────┐
         │Feature │ │ ONNX │ │Heuristic│
         │Builder │ │Model │ │Fallback │
         └────────┘ └──────┘ └─────────┘
```

## 자기 개선 루프

```
게임 탐색 → 참가 → 전투 (틱 데이터 수집)
                         ↓
               SQLite 저장 (세션/틱/피처)
                         ↓
              N 게임마다 자동 트리거 (기본 50)
                         ↓
              CSV 익스포트 → Python 훈련
                         ↓
              ONNX 모델 생성 → 핫리로드
                         ↓
              다음 게임부터 새 모델 적용
```

## 모니터링

```bash
curl http://localhost:9090/health
curl http://localhost:9090/metrics
```

## 라이선스

MIT
