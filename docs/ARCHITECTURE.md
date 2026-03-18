# appback-ai-agent Architecture

> npm CLI 패키지로 배포되는 자율형 AI 게임 에이전트 프레임워크.
> 현재 ClawClash(GC) 게임 어댑터가 구현되어 있으며, 어댑터 패턴으로 다른 게임 확장 가능.

## 패키지 정보

- **npm**: `appback-ai-agent`
- **현재 버전**: 1.2.2
- **라이선스**: MIT

---

## 시스템 요구사항

에이전트는 두 가지 모드로 동작합니다. 기본 설치만으로 게임 참여/데이터 수집이 가능하고, 학습 환경을 추가하면 자동 모델 학습까지 지원됩니다.

### 기본 설치 (게임 참여 + 데이터 수집)

에이전트 실행에 필요한 최소 환경. 이동은 휴리스틱, 전략은 룰 기반으로 동작합니다.

**런타임:**
- Node.js 18+
- npm 9+

**시스템:**
- OS: Linux / macOS / Windows
- RAM: 512MB 이상
- 디스크: 500MB (npm 패키지 + SQLite DB)
- 네트워크: HTTPS + WebSocket 아웃바운드

**npm 의존성** (자동 설치):
- `socket.io-client` — WebSocket 통신
- `axios` — REST API 호출
- `better-sqlite3` — 로컬 데이터 저장 (네이티브 모듈, C++ 빌드 도구 필요)
- `dotenv` — 환경변수

**C++ 빌드 도구** (`better-sqlite3` 컴파일에 필요):
- Linux: `gcc`, `g++`, `make`, `python3` (대부분 기본 설치)
- macOS: Xcode Command Line Tools (`xcode-select --install`)
- Windows: Visual Studio C++ Build Tools + Python 3

**이 환경에서 동작하는 기능:**
- 게임 자동 탐색/참여/대기열
- 휴리스틱 이동 결정 (가장 가까운 적 방향)
- 룰 기반 전략 결정 (HP/생존자/링 축소 고려)
- UCB1 장비 선택 (탐색 vs 활용)
- 게임 데이터 수집 (SQLite)
- 성과 지표 추적
- 헬스체크 HTTP 엔드포인트
- AI Rewards 등록

### 학습 가능 설치 (기본 + 자동 모델 학습)

기본 환경에 Python ML 스택을 추가하면, 게임 데이터로 ONNX 모델을 자동 학습하고 이동 결정을 모델 기반으로 전환합니다.

**추가 런타임:**
- Python 3.9+

**추가 시스템:**
- RAM: 2GB 이상 여유
- 디스크: 5GB 이상 여유 (PyTorch CPU ~700MB, 기타 패키지, 학습 데이터)
- `/tmp` 공간: 2GB 이상 (pip 빌드 시 사용, tmpfs인 경우 주의)

**Python 패키지 설치:**
```bash
# CPU 전용 PyTorch (경량, 서버에 GPU 없으면 반드시 이 옵션 사용)
pip3 install torch --index-url https://download.pytorch.org/whl/cpu

# ML 패키지
pip3 install numpy pandas scikit-learn onnx onnxruntime
```

또는 한 번에:
```bash
pip3 install -r node_modules/appback-ai-agent/training/requirements.txt
```

> **주의**: `pip install torch` (기본)는 CUDA 포함 2GB+. GPU 없는 서버에서는 반드시 `--index-url https://download.pytorch.org/whl/cpu` 사용.

> **주의**: `/tmp`가 tmpfs(메모리 기반)인 환경에서는 pip 설치 시 공간 부족이 발생할 수 있습니다. `TMPDIR=/path/on/disk pip3 install ...`로 우회하세요.

**이 환경에서 추가로 동작하는 기능:**
- 50게임마다 자동 학습 트리거 (환경변수로 조절 가능)
- 학습 데이터 내보내기 (SQLite → JSON/CSV)
- PyTorch 모델 학습 → ONNX 변환
- ONNX 모델 핫리로드 (재시작 불필요)
- 모델 기반 이동 결정 (162차원 피처 → 5방향 분류)

### 요구사항 비교 요약

| 항목 | 기본 설치 | 학습 가능 설치 |
|---|---|---|
| Node.js | 18+ | 18+ |
| Python | 불필요 | 3.9+ |
| RAM | 512MB | 2GB+ |
| 디스크 | 500MB | 5GB+ |
| 이동 결정 | 휴리스틱 | ONNX 모델 |
| 전략 결정 | 룰 기반 | 룰 기반 (동일) |
| 장비 선택 | UCB1 | UCB1 (동일) |
| 데이터 수집 | O | O |
| 자동 학습 | X (에러 로그만) | O |
| 게임 참여 | O | O |

> Python 환경이 없어도 에이전트는 정상 동작합니다. 학습 트리거 시점에 로그에 에러가 남을 뿐 게임 참여에 영향 없습니다.

---

## 디렉토리 구조

```
appback-ai-agent/
├── bin/
│   └── cli.js                  # CLI 엔트리포인트 (npx appback-ai-agent <cmd>)
├── src/
│   ├── index.js                # 런타임 엔트리포인트 (start 명령 시 실행)
│   ├── core/                   # 프레임워크 코어
│   │   ├── AgentManager.js     # 어댑터 등록/시작/종료 관리
│   │   ├── BaseGameAdapter.js  # 게임 어댑터 추상 클래스
│   │   ├── Scheduler.js        # 주기적 discoverGames 실행
│   │   ├── DataCollector.js    # 게임 데이터 수집 (tick 버퍼링)
│   │   ├── EventBus.js         # 이벤트 기반 통신 (Node EventEmitter)
│   │   ├── ModelRegistry.js    # ONNX 모델 로딩/핫리로드/감시
│   │   ├── HealthMonitor.js    # HTTP 헬스체크 (:9090)
│   │   ├── TrainingRunner.js   # Python 학습 스크립트 실행
│   │   └── BaseModelProvider.js
│   ├── adapters/
│   │   └── gc/                 # ClawClash 게임 어댑터
│   │       ├── GcAdapter.js    # 메인 어댑터 (게임 루프 전체)
│   │       ├── GcApiClient.js  # REST API 클라이언트
│   │       ├── GcSocketClient.js # WebSocket 클라이언트 (socket.io)
│   │       ├── GcStrategyEngine.js  # 전략 결정 엔진 (룰 기반)
│   │       ├── GcFeatureBuilder.js  # 162차원 피처 벡터 생성
│   │       ├── GcEquipmentManager.js # 장비 선택 (UCB1 알고리즘)
│   │       ├── config.js       # 환경변수 기반 설정
│   │       └── constants.js    # INACTIVE_STATES 등 상수
│   ├── data/
│   │   ├── storage/
│   │   │   └── SqliteStore.js  # SQLite 영속 저장소
│   │   └── exporters/
│   │       └── TrainingExporter.js # 학습용 데이터 내보내기 (JSON/CSV)
│   ├── models/
│   │   └── providers/
│   │       ├── OnnxProvider.js     # ONNX Runtime 추론
│   │       └── RuleBasedProvider.js
│   └── utils/
│       ├── logger.js           # 레벨 기반 로거
│       ├── metrics.js          # 게임 성과 지표 추적
│       └── retry.js            # 지수 백오프 재시도
├── training/                   # Python 학습 파이프라인
│   ├── train_gc_model.py       # 이동 5클래스 학습 (score 가중치 + stay 부스트)
│   ├── models/gc_move_net.py   # MLP 162→64→32→5
│   ├── requirements.txt        # torch, onnx, onnxscript 등
│   └── data/raw/               # 내보낸 학습 데이터
├── .env.example
└── package.json
```

사용자 실행 시 생성되는 디렉토리 (CWD 기준):
```
<user-dir>/
├── .env          # init 시 생성
├── data/
│   └── agent.db  # SQLite DB (identity, sessions, ticks, metrics)
└── models/
    └── gc/
        └── gc_move_model.onnx  # 학습된 이동 모델 (선택)
```

---

## CLI 명령어

| 명령 | 설명 |
|---|---|
| `npx appback-ai-agent init` | .env 복사 + data/, models/ 디렉토리 생성 |
| `npx appback-ai-agent start` | 에이전트 실행 (기본 명령) |
| `npx appback-ai-agent register <code>` | AI Rewards 계정에 에이전트 연결 |
| `npx appback-ai-agent export` | SQLite → 학습 데이터 추출 (JSON/CSV) |
| `npx appback-ai-agent train` | 수동 모델 학습 실행 (PYTHON_PATH 지원) |
| `npx appback-ai-agent help` | 도움말 |

---

## 핵심 아키텍처

### 계층 구조

```
CLI (bin/cli.js)
  └─ Runtime (src/index.js)
       ├─ AgentManager
       │    ├─ Scheduler (30s 간격 tick)
       │    └─ GameAdapter (GcAdapter)
       │         ├─ GcApiClient (REST)
       │         ├─ GcSocketClient (WebSocket)
       │         ├─ GcStrategyEngine
       │         ├─ GcFeatureBuilder
       │         └─ GcEquipmentManager
       ├─ DataCollector → SqliteStore
       ├─ ModelRegistry → OnnxProvider
       ├─ Metrics
       ├─ TrainingExporter
       ├─ TrainingRunner
       ├─ HealthMonitor
       └─ EventBus
```

### 어댑터 패턴

`BaseGameAdapter` 추상 클래스를 상속하여 게임별 어댑터 구현:

```javascript
class BaseGameAdapter {
  get gameName()         // 게임 식별자 (예: 'claw-clash')
  get supportsRealtime() // WebSocket 실시간 지원 여부
  async initialize()     // 초기화 (인증, 장비 로드, WS 연결)
  async discoverGames()  // 게임 탐색/참여 (Scheduler가 주기 호출)
  async joinGame(gameId) // 게임 참여
  async onGameEnd(gameId, results) // 게임 종료 처리
  async shutdown()       // 정리
}
```

`AgentManager`가 어댑터를 등록받아 각각 독립 `Scheduler`로 구동.
새 게임 지원 시 어댑터만 추가하면 됨.

---

## GC (ClawClash) 어댑터 상세

### 통신 방식

- **REST API** (`GcApiClient`): 인증, 챌린지, 장비, 전략/이동 제출, 큐 상태
  - Base URL: `https://clash.appback.app/api/v1`
  - 인증: `Authorization: Bearer <agent_token>`
  - 타임아웃: 10초, 재시도: 3회 (지수 백오프)

- **WebSocket** (`GcSocketClient`): 실시간 게임 이벤트 수신
  - URL: `https://clash.appback.app`
  - 프로토콜: socket.io (websocket → polling 폴백)
  - 자동 재접속: 2초 간격, 무제한 시도

### API 엔드포인트 (GcApiClient)

| 메서드 | 엔드포인트 | 설명 |
|---|---|---|
| POST | `/agents/register` | 에이전트 등록 (현재 비활성) |
| GET | `/agents/me` | 토큰 검증 + 에이전트 정보 |
| GET | `/challenge` | 챌린지 가능 여부 확인 |
| POST | `/challenge` | 챌린지 제출 (무기/방어구 선택) |
| GET | `/queue/status` | 대기열 상태 조회 |
| GET | `/games/:id` | 게임 상세 정보 |
| GET | `/games/:id/state` | 게임 상태 (terrain 등) |
| POST | `/games/:id/strategy` | 전략 제출 |
| POST | `/games/:id/move` | 이동 방향 제출 |
| GET | `/equipment` | 장비 카탈로그 |
| POST | `/agents/me/model` | ONNX 모델 업로드 (multipart, max 2MB) |
| DELETE | `/agents/me/model` | 커스텀 모델 삭제 |
| POST | `/agents/verify-registration` | AI Rewards 등록 코드 인증 |

### WebSocket 이벤트

| 이벤트 | 방향 | 설명 |
|---|---|---|
| `join_game` | emit | 게임 룸 입장 |
| `leave_game` | emit | 게임 룸 퇴장 |
| `tick` | receive | 매 틱 게임 상태 (에이전트 위치/HP/점수 등) |
| `game_state` | receive | 게임 페이즈 변경 (betting → sponsoring → battle) |
| `battle_ended` | receive | 전투 종료 + 랭킹 |
| `game_cancelled` | receive | 게임 취소 (서버 재시작 등) |

### 게임 라이프사이클

```
initialize()
  ├─ 토큰 로드 (SQLite → env 순서)
  ├─ 토큰 검증 (GET /agents/me)
  ├─ 장비 카탈로그 로드
  ├─ ONNX 모델 로드 (선택)
  └─ WebSocket 연결 + 이벤트 핸들러 등록

discoverGames() [매 30초]
  ├─ activeGameId 있으면 → 게임 상태 확인 (active/ended)
  ├─ getQueueStatus() → active_game_id → 입장
  ├─ in_queue → 대기 (2분 타임아웃)
  └─ getChallenge() → ready → joinGame()

joinGame()
  ├─ 장비 선택 (UCB1 기반)
  ├─ submitChallenge() → queued/joined
  └─ _enterGame() 또는 _startQueuePolling()

_enterGame(gameId, slot)
  ├─ 슬롯 확인, WS 룸 입장
  ├─ DataCollector.startSession()
  └─ Terrain 캐시

_onTick(data) [실시간]
  ├─ 피처 벡터 생성 (162차원)
  ├─ ONNX 추론 또는 휴리스틱 → 이동 방향 결정
  ├─ submitMove()
  ├─ DataCollector.recordTick()
  └─ 전략 결정 (N틱마다) → submitStrategy()

_onBattleEnded(data)
  ├─ onGameEnd() → 결과 기록
  ├─ Metrics 업데이트
  ├─ 장비 성과 기록
  └─ 세션 종료 + 정리

_onGameCancelled(data)
  ├─ DataCollector.dropSession() (데이터 삭제)
  └─ 상태 초기화 → 다음 게임 대기
```

### 재접속 로직

서버 재시작/네트워크 끊김 시:

```
WebSocket disconnect
  └─ socket.io 자동 재접속 (2초 간격)

WebSocket reconnected
  └─ _onReconnect()
       ├─ 큐 폴링 중지 (stale 상태 방지)
       ├─ activeGameId 없으면 → 다음 Scheduler tick에서 재큐
       └─ activeGameId 있으면 → 게임 상태 확인
            ├─ inactive → _onGameCancelled() + 정리
            └─ active → 룸 재입장

Scheduler tick (안전장치)
  ├─ 큐 2분 타임아웃 → 강제 재큐
  ├─ busy 3회 연속 → 강제 challenge 재제출
  └─ tick 60초 stuck → force-reset _running
```

---

## 데이터 레이어

### SQLite 스키마 (agent.db)

**agent_identity**: 에이전트 인증 정보
- game, agent_id, api_token, name, registered_at

**game_sessions**: 게임 세션 기록
- id, game, game_id, started_at, ended_at, my_slot, result (JSON), strategy_log (JSON)

**battle_ticks**: 틱 데이터 (피처 + 결정)
- session_id, tick, sub_tick, state (JSON), my_features (JSON), my_decision (JSON)

**training_samples**: 학습 샘플
- model_type, features (BLOB), label, reward, session_id

**model_metrics**: 모델 성과
- model_key, version, games_played, avg_rank, avg_score, win_rate

### 데이터 흐름

```
게임 틱
  → DataCollector (버퍼, 50틱마다 flush)
  → SqliteStore (battle_ticks)

게임 종료
  → SqliteStore (game_sessions.result 업데이트)
  → Metrics (인메모리 집계)
  → GcEquipmentManager (장비 성과 기록)

N게임마다 (기본 50)
  → TrainingExporter → JSON/CSV 파일
  → TrainingRunner → Python 학습
  → models/gc/gc_move_model.onnx 생성
  → ModelRegistry 핫리로드 (파일 감시)
```

---

## ML 파이프라인

### 피처 벡터 (162차원)

| 범위 | 차원 | 설명 |
|---|---|---|
| 0-21 | 22 | 자신 상태 (HP, 위치, 장비, 점수 등) |
| 22-25 | 4 | 현재 전략 (mode, target, flee 등) |
| 26-115 | 90 | 상대 6명 × 15 피처 |
| 116-119 | 4 | 아레나 컨텍스트 (축소 단계 등) |
| 120-144 | 25 | 5×5 로컬 지형 |
| 145-148 | 4 | 방향별 이동 가능 여부 |
| 149-156 | 8 | BFS 경로 거리 |
| 157-160 | 4 | 이동 후 공격 가능 여부 |
| 161 | 1 | 현재 위치에서 공격 가능 여부 |

### 의사결정

1. **이동** (매 틱): ONNX 모델 → 5방향 logits → action mask 적용 → 최선 방향
   - 모델 없으면: 휴리스틱 (가장 가까운 적 방향)
2. **전략** (N틱마다): 룰 기반 (HP 비율, 생존자 수, 축소 단계 고려)
3. **장비 선택** (게임 시작): UCB1 알고리즘 (탐색 vs 활용)

### 자동 학습

> 요구사항은 상단 [시스템 요구사항 > 학습 가능 설치](#학습-가능-설치-기본--자동-모델-학습) 참조.

#### 학습 흐름

```
50게임 완료 (AUTO_TRAIN_AFTER_GAMES 간격)
  → TrainingExporter: SQLite → JSON/CSV 파일 (training/data/raw/)
  → TrainingRunner: python3 train_gc_model.py 실행
  → 모델 생성: models/gc/gc_move_model.onnx
  → 서버 업로드: POST /agents/me/model
  → ModelRegistry: 파일 변경 감시 → 핫리로드 (재시작 불필요)
```

#### 학습 파이프라인 상세

1. **데이터 내보내기**: `TrainingExporter`가 SQLite에서 완료된 세션과 틱 데이터를 JSON/CSV로 추출
   - CSV에 162차원 피처 + action 컬럼 포함
   - `my_decision IS NOT NULL` 필터로 유효 데이터만 추출
2. **모델 학습**: `TrainingRunner`가 `python3 training/train_gc_model.py` 실행 (PyTorch)
   - 이동 5클래스 분류 (stay/up/down/left/right)
   - 가중치 정책:
     - **점수 기반**: 게임 최종 점수 [0.1, 1.0] 정규화
     - **Stay 부스트**: f161=1 (공격 가능)일 때 stay ×2.0, 이동 ×0.5
3. **ONNX 변환**: PyTorch → ONNX (opset 17), 단일 파일로 재저장 (torch 2.10+ .data 분리 대응)
4. **서버 업로드**: `POST /agents/me/model`로 자동 업로드 (서버가 input_dim=162, output_dim=5 검증)
5. **핫리로드**: `ModelRegistry`의 파일 감시자가 .onnx 파일 변경 감지 → 자동 로드
6. **적용**: 서버에서 업로드된 모델로 추론 (로컬은 fallback용)

---

## 환경변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `GC_API_URL` | `https://clash.appback.app/api/v1` | GC REST API |
| `GC_WS_URL` | `https://clash.appback.app` | GC WebSocket |
| `GC_API_TOKEN` | (비어있음) | 에이전트 인증 토큰 (비워두면 자동 등록) |
| `GAME_DISCOVERY_INTERVAL_SEC` | `30` | 게임 탐색 간격 (초) |
| `MODEL_DIR` | `./models` | 모델 파일 경로 |
| `DATA_DIR` | `./data` | SQLite DB 경로 |
| `AUTO_TRAIN_AFTER_GAMES` | `50` | 자동 학습 트리거 게임 수 |
| `PYTHON_PATH` | `python3` | Python 실행 경로 (venv 사용 시 `.venv/bin/python3`) |
| `LOG_LEVEL` | `info` | 로그 레벨 (debug/info/warn/error) |
| `HEALTH_PORT` | `9090` | 헬스체크 HTTP 포트 |

---

## 헬스체크 API

- `GET :9090/health` → `{ "status": "ok", "uptime": "1h 30m 5s" }`
- `GET :9090/metrics` → 게임 성과 + 어댑터 상태 (activeGameId, gamePhase)

---

## 운영

### 실행 방식
```bash
# 직접 실행
npx appback-ai-agent start

# pm2 데몬
pm2 start "npx appback-ai-agent start" --name appback-ai-agent
```

### 프로세스 관리
- pm2로 운영 시 자동 재시작
- SIGINT/SIGTERM graceful shutdown 지원
- WebSocket 자동 재접속 (무제한)
- Scheduler 60초 stuck 안전장치

### AI Rewards 연동
1. https://rewards.appback.app 에서 등록 코드 발급
2. `npx appback-ai-agent register ARW-XXXX-XXXX`
3. Hub 프록시를 통해 에이전트 모니터링/Face 변경 가능
