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

AI Rewards가 canonical UUID와 서명 JWT를 직접 발급한다. 로컬 UUID가 없으면 새 UUID를
받고, 기존 UUID가 있으면 같은 UUID로 JWT를 발급·갱신한 뒤 GC에 입장한다. AI Agent는
이메일, 소유주 또는 계정 credential을 사용하거나 저장하지 않는다.

## AI Rewards identity

AI Rewards는 에이전트 UUID와 GC 인증 JWT의 발급 주체다. `start`가 identity bootstrap과
JWT 갱신을 자동 처리한다. 기존 로컬 UUID는 그대로 유지되며 AI Rewards·GC 응답 UUID가
다르면 저장과 참가를 중단한다. Face·모델·학습 데이터는 초기화하지 않는다.

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
docker compose build
```

최초 기동 시 data volume에 AI Rewards canonical identity가 자동 저장된다.

```bash
docker compose up --build -d
```

학습을 실행하지 않는 다중 수집·플레이 인스턴스 3개는 runtime Compose를 사용합니다.
각 인스턴스는 identity, cursor, SQLite, 설정과 모델 볼륨을 공유하지 않습니다.

```bash
docker compose -f docker-compose.runtime.yml build
```

각 worker의 독립 data volume이 별도 UUID/JWT를 자동 보관한다.

```bash
docker compose -f docker-compose.runtime.yml up -d
```

기본 profile은 `hunter`, `survivor`, `navigator`이며, 최초 생성 시 각 profile에
서로 다른 random seed와 `15%` Easy variation을 적용합니다. 이 구성은
`GC_V81_AUTO_TRAIN_ENABLED=false`로 로컬 자동학습과 모델 업로드를 중지하고,
`GC_TRAINING_SYNC_ENABLED=false`로 authoritative training feed도 내려받지 않습니다.
여러 컨테이너가 하나의 SQLite 볼륨을 동시에 마운트하면 안 됩니다.

## CLI 명령어

```bash
npx appback-ai-agent doctor                # 환경 점검 (시스템/프로젝트/학습 스펙)
npx appback-ai-agent init                  # .env + 디렉토리 생성
npx appback-ai-agent start                 # 에이전트 실행 (기본)
npx appback-ai-agent export                # SQLite → 학습 데이터 추출
npx appback-ai-agent train                 # 수동 모델 학습
npx appback-ai-agent evaluate maze         # 고정 미로 오프라인 품질 평가
npx appback-ai-agent personality           # Easy/Expert 행동 성격 설정
npx appback-ai-agent version               # 버전 확인
npx appback-ai-agent help                  # 도움말
```

### 행동 성격 설정

Easy 모드에서는 준비된 성격과 제한적 variation을 사용합니다.

```bash
npx appback-ai-agent personality list
npx appback-ai-agent personality set hunter --variation 8
npx appback-ai-agent personality show
```

Expert 모드는 설정 파일이나 개별 수치로 행동 및 장비 성향을 제어합니다.

```bash
npx appback-ai-agent personality expert init ./personality.json --name my-agent
npx appback-ai-agent personality expert validate ./personality.json
npx appback-ai-agent personality expert apply ./personality.json
npx appback-ai-agent personality expert set equipment.damage 1.8
npx appback-ai-agent personality expert set equipment.defense 0.4
```

설정은 `config/`에 revision과 함께 저장되며 npm update와 PM2 재시작 후에도 유지됩니다. 장비 선호는 재시작 후 다음 게임 참가부터 적용되고, 이동 성격은 기존 운영 모델을 즉시 변경하지 않으며 성격별로 다시 학습한 모델부터 반영됩니다. 전체 사용법은 [Personality CLI 가이드](docs/operations/PERSONALITY_CLI_GUIDE.md)를 참고하세요.

### 오프라인 미로 평가

```bash
npx appback-ai-agent evaluate maze --preset navigator --scenarios 200 --seed 20260716
npx appback-ai-agent evaluate personality
```

동일 seed에서 항상 같은 solvable maze를 생성해 목표 도달률, 경로 효율, loop, invalid action과 무진행률을 평가합니다. 현재 단계에서는 BFS teacher 기준선 평가이며 ONNX 모델 평가는 후속 단계입니다. 전체 사용법은 [평가 가이드](docs/operations/EVALUATION_GUIDE.md)를 참고하세요.

### 수동 학습

자동 학습(50게임마다)과 별도로 수동 학습도 가능합니다:

```bash
npx appback-ai-agent export    # 데이터 추출
npx appback-ai-agent train     # 수동 학습 실행 → 로컬 모델·평가 보고서 생성
```

v8.1 운영 프로세스는 성격별 완료 게임 50건마다 자동으로 학습·평가하고, gate를 통과한
모델을 서버 후보 revision으로 업로드합니다. canary·active 전환은 관리자 승인 대상입니다.

Ubuntu 24.04 (PEP 668) 환경:
```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r node_modules/appback-ai-agent/training/requirements.txt
echo 'PYTHON_PATH=.venv/bin/python3' >> .env
```

## 환경변수

`appback-ai-agent init` 실행 시 생성되는 `.env` 파일:

- `AI_REWARDS_API_URL` — UUID/JWT 발급 API (기본: `https://appback.app/api/v1`)
- `AI_REWARDS_AGENT_JWT` — 선택적 JWT 환경변수 override; 기본은 SQLite 저장값 사용
- `GC_API_URL` — canonical GC API (기본: `https://gc-v2-api.appback.app/api/v1`)
- `GC_WS_URL` — WebSocket URL (기본: `https://gc-v2-api.appback.app`)
- `GC_API_TOKEN` — 한 릴리스 동안만 제공하는 deprecated alias이며 AI Rewards JWT만 허용
- `GAME_DISCOVERY_INTERVAL_SEC` — 게임 탐색 주기 (기본: `30`)
- `AUTO_TRAIN_AFTER_GAMES` — 자동 훈련 트리거 게임 수 (기본: `50`)
- `MODEL_DIR` — ONNX 모델 디렉토리 (기본: `./models`)
- `DATA_DIR` — SQLite DB 디렉토리 (기본: `./data`)
- `PYTHON_PATH` — Python 실행 경로 (기본: `python3`, venv 사용 시 `.venv/bin/python3`)
- `HEALTH_PORT` — 헬스체크 포트 (기본: `9090`)
- `LOG_LEVEL` — 로그 레벨 (기본: `info`)

## 현재 GC AI 계약

현재 기본 운영 계약은 **v8.1 계층형 전략 모델**입니다.

- **214차원 입력**: GC 서버가 생성한 authoritative feature vector
- **11전략 출력**: hold, flee, seek_powerup, explore, attack_candidate_0~6
- **책임 분리**: 모델은 전략·대상을 고르고, GC 서버는 BFS 경로와 실제 이동·공격을 실행
- **서버 추론**: AI Agent가 ONNX 후보를 업로드하면 GC가 계약 검증과 runtime gate를 수행
- **authoritative 학습 feed**: session/frame/result를 cursor 방식으로 수집하며 로컬 viewer snapshot은 v8.x 학습에 사용하지 않음
- **legacy 참고**: v7.0 `153→5` 이동 코드와 회귀 테스트는 남아 있지만 현재 operation으로 선택할 수 없고 신규 설치에도 사용하지 않음

## 아키텍처

```
AI Rewards UUID/JWT issue → canonical UUID + JWT
                              │
                              v
AgentManager → GcAdapter → JWT-authenticated GC REST discovery/challenge
                    │
                    ├─ EquipmentManager (성격별 장비)
                    ├─ ModelBootstrapper (초기 v8.1 후보)
                    └─ TrainingDataConsumer ← GC authoritative feed
                                           │
                                           v
                          SQLite → Exporter → 214→11 Trainer
                                                   │
                                                   v
                                    GC candidate upload/rollout
```

## 자기 개선 루프

```
게임 탐색 → 참가 → GC 서버 전투·추론
                         ↓
        authoritative session/frame/result 동기화
                         ↓
             SQLite 저장 + profile별 격리
                         ↓
              N 게임마다 자동 트리거 (기본 50)
                         ↓
           teacher strategy 생성 → Python 훈련
                         ↓
           ONNX 후보 업로드 → GC 품질 gate
                         ↓
              통과한 revision만 active 전환
```

## 학습 파이프라인

### 모델 구조

MLP: `214 → 128 → 64 → 11`

### 가중치 정책

AI Agent는 raw state와 behavior profile을 이용해 `teacher_strategy`와 `sample_weight`를 계산합니다.
기본 export는 같은 `operation_version + behavior_profile_hash`의 실제 frame만 사용하며, 다른
성격의 관측을 재사용하려면 명시적인 재라벨링 옵션이 필요합니다.

### 모델 업로드

학습 완료 후 자동으로 서버에 업로드 (`POST /agents/me/models/v8`):
- 서버가 feature version, schema hash, `input_dim=214`, `output_dim=11`, label 순서를 검증
- 업로드 모델은 immutable 후보 revision이며 GC runtime 품질 gate를 통과해야 active 전환
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
