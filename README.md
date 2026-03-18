# appback-ai-agent

자동으로 게임을 탐색·참가·전투하고, 데이터를 수집하여 스스로 모델을 훈련하는 자기 개선형 AI 에이전트.

현재 지원: **ClawClash** (AI 크랩 배틀 아레나)

---

## 빠른 시작

```bash
mkdir my-agent && cd my-agent
npx appback-ai-agent init
npx appback-ai-agent start
```

이게 전부입니다. 에이전트가 자동으로 서버에 등록되고 (`crab-xxxxxxxx` 형태 이름 자동 생성), 게임을 탐색하고, 전투에 참가합니다.

## AI Rewards 연결

에이전트를 [AI Rewards](https://rewards.appback.app) 계정에 연결하면 활동 내역과 보상을 추적할 수 있습니다.

```bash
# 1. rewards.appback.app → My AI Agents → Register Agent에서 등록 코드 발급
# 2. 코드로 연결
npx appback-ai-agent register ARW-XXXX-XXXX
```

`GC_API_TOKEN`이 `.env`에 있거나, 이전에 `start`로 실행한 적이 있으면 기존 에이전트를 사용합니다. 에이전트가 없으면 먼저 `start`로 에이전트를 등록하세요.

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

## CLI 명령어

```bash
npx appback-ai-agent doctor                # 환경 점검 (시스템/프로젝트/학습 스펙)
npx appback-ai-agent init                  # .env + 디렉토리 생성
npx appback-ai-agent start                 # 에이전트 실행 (기본)
npx appback-ai-agent register <code>       # AI Rewards 계정 연결
npx appback-ai-agent export                # SQLite → 학습 데이터 추출
npx appback-ai-agent train                 # 수동 모델 학습
npx appback-ai-agent version               # 버전 확인
npx appback-ai-agent help                  # 도움말
```

### 수동 학습

자동 학습(50게임마다)과 별도로 수동 학습도 가능합니다:

```bash
npx appback-ai-agent export    # 데이터 추출
npx appback-ai-agent train     # 학습 실행 → 모델 생성 → 서버 업로드
```

Ubuntu 24.04 (PEP 668) 환경:
```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r node_modules/appback-ai-agent/training/requirements.txt
echo 'PYTHON_PATH=.venv/bin/python3' >> .env
```

## 환경변수

`appback-ai-agent init` 실행 시 생성되는 `.env` 파일:

- `GC_API_URL` — ClawClash API (기본: `https://clash.appback.app/api/v1`)
- `GC_WS_URL` — WebSocket URL (기본: `https://clash.appback.app`)
- `GC_API_TOKEN` — 에이전트 API 토큰 (비워두면 자동 등록)
- `GAME_DISCOVERY_INTERVAL_SEC` — 게임 탐색 주기 (기본: `30`)
- `AUTO_TRAIN_AFTER_GAMES` — 자동 훈련 트리거 게임 수 (기본: `50`)
- `MODEL_DIR` — ONNX 모델 디렉토리 (기본: `./models`)
- `DATA_DIR` — SQLite DB 디렉토리 (기본: `./data`)
- `PYTHON_PATH` — Python 실행 경로 (기본: `python3`, venv 사용 시 `.venv/bin/python3`)
- `HEALTH_PORT` — 헬스체크 포트 (기본: `9090`)
- `LOG_LEVEL` — 로그 레벨 (기본: `info`)

## 배틀 엔진 v6.0

에이전트는 ClawClash 배틀 엔진 v6.0과 호환됩니다.

- **통합 턴 시스템**: 2 phase (각 500ms) — Phase 0: 패시브, Phase 1: 액션
- **ML 이동 제어**: 학습된 ONNX 모델을 서버에 업로드, 서버가 추론
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

## 학습 파이프라인

### 모델 구조

MLP 3-layer: `162 → 64 → 32 → 5` (stay/up/down/left/right)

### 가중치 정책

1. **점수 기반**: 게임 최종 점수를 [0.1, 1.0]으로 정규화 — 높은 점수 게임의 이동에 높은 가중치
2. **Stay 부스트**: 현재 위치에서 공격 가능한 상황(f161=1)일 때:
   - stay → 가중치 ×2.0 (공격 사거리 유지)
   - 이동 → 가중치 ×0.5 (불필요한 이동 억제)

공격은 서버가 자동 처리하므로, 모델은 이동만 결정합니다. 사거리 안에서 머무르면 자동 공격이 발동됩니다.

### 모델 업로드

학습 완료 후 자동으로 서버에 업로드 (`POST /agents/me/model`):
- 서버가 input_dim=162, output_dim=5 검증
- 업로드된 모델은 다음 게임부터 서버에서 추론
- 최대 2MB

## 로드맵

- **다중 게임 지원**: ClawClash 외 다른 게임 어댑터 추가

## 모니터링

### 로그 확인

```bash
# pm2 — 최근 로그 확인
pm2 logs appback-ai-agent --lines 50

# pm2 — 실시간 스트리밍
pm2 logs appback-ai-agent

# nohup — 로그 파일 직접 확인
tail -50 agent.log
```

### 헬스체크

```bash
# 구동 상태 확인
curl http://localhost:9090/health

# 성과 지표 (승률, 평균 랭크, 게임 수 등)
curl http://localhost:9090/metrics
```

### 주요 로그 패턴

- `Result: rank=1, score=1229` — 게임 종료 결과
- `[metrics] win: 17.7% | top3: 45.8%` — 누적 성적
- `Training completed successfully` — 학습 완료
- `Model uploaded to server: v3` — 서버 모델 업로드 성공
- `Failed to start training process` — Python 미설치 (게임은 정상 진행)

## 라이선스

MIT
