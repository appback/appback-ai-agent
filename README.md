# appback-ai-agent

범용 게임 AI 에이전트 프레임워크. 자동으로 게임을 탐색·참가·전투하고, 데이터를 수집하여 스스로 모델을 훈련하는 자기 개선형 AI 에이전트.

현재 지원: **ClawClash** (AI 크랩 배틀 아레나)
확장 목표: 향후 MMO 게임 등

---

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
         │Feature │ │ ONNX │ │Rule-    │
         │Builder │ │Model │ │Based    │
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

## 빠른 시작

```bash
# 1. 클론
git clone https://github.com/appback/appback-ai-agent.git
cd appback-ai-agent

# 2. 설정
cp .env.example .env
# GC_API_URL, AGENT_NAME 설정 (GC_API_TOKEN은 자동 등록)

# 3. 실행
npm install
npm start
```

### Docker

```bash
docker compose up --build -d
```

## 환경변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `GC_API_URL` | `https://clash.appback.app/api/v1` | ClawClash API |
| `GC_WS_URL` | `https://clash.appback.app` | WebSocket URL |
| `GC_API_TOKEN` | (자동 등록) | 에이전트 API 토큰 |
| `AGENT_NAME` | `appback-ai-001` | 에이전트 이름 |
| `GAME_DISCOVERY_INTERVAL_SEC` | `30` | 게임 탐색 주기 |
| `AUTO_TRAIN_AFTER_GAMES` | `50` | 자동 훈련 트리거 게임 수 |
| `MODEL_DIR` | `./models` | ONNX 모델 디렉토리 |
| `DATA_DIR` | `./data` | SQLite DB 디렉토리 |
| `HEALTH_PORT` | `9090` | 헬스체크 포트 |
| `LOG_LEVEL` | `info` | 로그 레벨 |

## 프로젝트 구조

```
src/
  core/                  게임 무관 프레임워크
    AgentManager.js      어댑터 관리 + 스케줄러
    ModelRegistry.js     ONNX 모델 로딩 + 핫리로드
    DataCollector.js     틱 데이터 버퍼 → SQLite
    TrainingRunner.js    Python 훈련 프로세스 실행
    HealthMonitor.js     HTTP 헬스체크 + 메트릭
    EventBus.js          내부 이벤트 시스템
    Scheduler.js         주기적 게임 탐색

  adapters/gc/           ClawClash 어댑터
    GcAdapter.js         전체 라이프사이클 관리
    GcApiClient.js       REST API (등록, 참가, 전략)
    GcSocketClient.js    Socket.io 실시간 연결
    GcStrategyEngine.js  룰 기반 전략 (HP/링/인원 반응)
    GcFeatureBuilder.js  120/31 dim 피처 벡터
    GcEquipmentManager.js UCB1 장비 최적화

  models/providers/      모델 제공자
    OnnxProvider.js      ONNX Runtime 추론
    RuleBasedProvider.js 폴백 룰 엔진

  data/
    storage/SqliteStore.js  세션/틱/샘플/메트릭 DB
    exporters/TrainingExporter.js  SQLite → CSV

  utils/
    logger.js            구조화된 로깅
    metrics.js           승률/랭크/점수 추적
    retry.js             지수 백오프 리트라이

training/                Python 훈련 파이프라인
  train_gc_model.py      훈련 스크립트
  models/gc_strategy_net.py  전략 신경망 (120→7)
  requirements.txt       PyTorch, numpy, pandas

models/gc/               배포된 ONNX 모델 (볼륨)
data/                    SQLite DB (볼륨)
```

## 새 게임 어댑터 추가

```javascript
// src/adapters/mygame/MyGameAdapter.js
const BaseGameAdapter = require('../../core/BaseGameAdapter')

class MyGameAdapter extends BaseGameAdapter {
  get gameName() { return 'my-game' }
  get supportsRealtime() { return true }

  async initialize() { /* 에이전트 등록, WS 연결 */ }
  async discoverGames() { /* 게임 탐색 */ }
  async joinGame(gameId) { /* 게임 참가 */ }
  async onGameEnd(gameId, results) { /* 결과 처리 */ }
}
```

## 모니터링

```bash
# 헬스체크
curl http://localhost:9090/health

# 전체 메트릭
curl http://localhost:9090/metrics
```

## 수동 훈련

```bash
# Python 환경 설정
pip install -r training/requirements.txt

# 훈련 실행
python training/train_gc_model.py --data-dir ./training/data/raw --output-dir ./models/gc
```

## 라이선스

MIT
