# appback-ai-agent Architecture

`appback-ai-agent`는 npm CLI로 배포되는 자율형 게임 에이전트 프레임워크다. 현재 구현된
ClawClash(GC) adapter는 게임 참가·성격별 장비 선택·authoritative 학습 데이터 수집·전략
모델 학습과 업로드를 담당한다.

## 현재 기준

| 항목 | 값 |
|---|---|
| 소스 버전 | `2.5.1` |
| Node.js | `>=18` |
| 기본 operation | `gc-v8-strategy-r2` |
| feature 계약 | `8.1 / gc-strategy-v8-214-r1 / 214` |
| model output | 11 strategy classes |
| 추론·이동 실행 | GC 서버 |
| 로컬 저장소 | SQLite WAL |

신규 설치는 v8.1이 기본이다. v7.0 `153 → 5` 이동 builder/trainer는 회귀 테스트·감사용으로
남아 있지만 현재 operation으로 선택할 수 없다. v8.0 `192 → 5`는 명시적으로 선택 가능한
격리 실험 계약이다.

## 런타임 구성

```text
CLI
  -> AiRewardsAgentAuthClient -> AI Rewards code exchange (canonical UUID/JWT)
  -> BehaviorProfileStore + OperationVersionStore
  -> AgentManager
       -> GcAdapter
            -> GcApiClient -- AI Rewards JWT -----> canonical GC REST
            -> GcEquipmentManager
            -> GcV81ModelBootstrapper
            -> legacy GcSocketClient (v7 only)
       -> Scheduler
       -> HealthMonitor
  -> GcTrainingDataConsumer <--------------------- GC cursor feed
  -> SqliteStore
  -> TrainingExporter
  -> GcV81AutoTrainer -> TrainingRunner -> ONNX -> GC model upload
```

### 시작 순서

1. behavior profile과 operation contract를 읽는다.
2. 설정 파일이 없는 신규 설치는 v8.1 r2 계약을 저장한다.
3. `GET /api/v1/agent-contract`로 protocol, feature와 capability를 확인한다.
4. 로컬 UUID가 없으면 AI Rewards에 UUID와 JWT를 요청한다.
5. 기존 UUID와 JWT `sub`가 없거나 만료되면 같은 UUID로 JWT를 자동 재발급한다.
6. JWT `sub`, 저장 UUID와 GC UUID가 같은지 확인하고 `/agents/register`를 호출한다.
7. 세 UUID가 같을 때만 `ACTIVE`로 전환하고 장비·모델·scheduler를 초기화한다.

identity 상태는 `UNBOUND -> ISSUING -> GC_REGISTERING -> ACTIVE`다. JWT 만료·폐기는
`REAUTH_REQUIRED -> ISSUING`으로 자동 복구한다. UUID 불일치는 fail-closed하며 AI Agent는
이메일·소유주·계정 credential을 요청하거나 저장하지 않는다.

v8.1은 `strategy_v8_1`과 r2의 `flee_two_step` capability가 없거나 계약 조회에 실패하면
fail-closed한다. legacy 계약은 observe 정책에 따라 경고 후 호환 경로를 사용할 수 있다.

## v8.1 실행 책임

```text
GC battle state
  -> canonical feature float32[214] + strategy mask[11]
  -> GC ONNX inference
  -> strategy/target candidate 선택
  -> GC goal resolver + BFS
  -> 동적 점유 재검증
  -> 이동·공격
  -> immutable record v2
```

- 모델은 `hold`, `flee`, `seek_powerup`, `explore`, `attack_candidate_0~6` 중 하나를 고른다.
- GC는 후보 slot의 안정적 순서, target 좌표, 경로, 충돌, 공격을 책임진다.
- r2 `flee`는 최대 두 칸을 계획하며 각 step을 다시 검증한다.
- viewer WebSocket과 로컬 `GcFeatureBuilder`는 v8.x 운영 학습 입력에 사용하지 않는다.

## 데이터와 학습

### 저장소

`data/agent.db`의 핵심 table:

- `agent_identity`: AI Rewards canonical UUID, JWT, issuer/type/expiry metadata
- `gc_training_sync_state`: stream/operation별 cursor
- `gc_training_sessions`: authoritative session manifest
- `gc_training_frames`: versioned vector, raw state, inference/execution record
- `gc_training_results`: 완료 결과
- `gc_loadout_results`: operation/profile별 장비 성과
- `game_sessions`, `battle_ticks`, `training_samples`: legacy realtime 경로

cursor batch는 SQLite transaction으로 멱등 저장한 뒤에만 checkpoint를 전진시킨다. 데이터와
모델 경로는 다음 키로 격리한다.

identity 갱신도 transaction으로 처리한다. 기존 UUID, AI Rewards 교환 UUID, GC 등록 UUID 중
하나라도 다르면 JWT와 만료 시각을 저장하지 않으며 기존 Face·모델·학습 row를 유지한다.

```text
operation_version + behavior_profile_hash
```

```text
training/data/<operation-version>/<profile-hash>/
models/gc/generations/<operation-version>/<profile-hash>/
```

### 자기 개선 루프

```text
GC authoritative feed
  -> contract/profile 검증 후 SQLite 저장
  -> 같은 profile의 완료 session N개(기본 50)
  -> teacher_strategy + sample_weight export
  -> GcStrategyNet 214 → 128 → 64 → 11
  -> offline gate + checksum 검증
  -> immutable 후보 revision upload
  -> GC canary/runtime gate
  -> active 또는 rejected
```

기본 export는 `same_profile_only`다. 다른 성격의 raw observation을 재사용할 때는 기존 label을
버리고 현재 profile teacher로 다시 라벨링하며 provenance를 manifest에 남긴다.

## 성격과 장비

Easy profile은 `balanced`, `hunter`, `survivor`, `collector`, `navigator`를 제공한다.
variation은 설정 시 한 번만 적용하고 seed와 함께 고정한다. Expert mode는 목표·정책·장비
가중치를 직접 설정한다.

profile은 다음에 함께 기록된다.

- `behavior_profile_id`, `behavior_profile_hash`, revision
- training session/frame
- export manifest와 ONNX metadata
- challenge loadout context

설정 변경은 기존 active 모델을 즉시 바꾸지 않는다. 장비는 재시작 후 다음 challenge부터
적용되며 모델 행동은 새 profile 데이터로 학습하고 gate를 통과한 revision부터 바뀐다.

## 모델과 계약 격리

| 세대 | 형태 | 상태 |
|---|---|---|
| v7.0 | `153 → 5 direction` | legacy 코드·회귀 테스트, operation 선택 불가 |
| v8.0 | `192 → 5 direction` | 격리된 실험 계약 |
| v8.1 | `214 → 11 strategy` | 현재 기본 |

서버와 AI Agent는 `(feature_version, feature_schema_hash)` registry로 shape와 label 순서를
검증한다. 다른 세대의 DB row, export 또는 ONNX를 자동 병합·padding·fallback하지 않는다.

## 주요 소스

```text
bin/cli.js
src/auth/AiRewardsAgentAuthClient.js
src/auth/agentJwt.js
src/auth/issueCanonicalAgent.js
bin/commands/operation.js
bin/commands/personality.js
src/index.js
src/adapters/gc/GcAdapter.js
src/adapters/gc/GcApiClient.js
src/adapters/gc/GcEquipmentManager.js
src/config/operationContract.js
src/config/gcStrategyV81Contract.js
src/config/BehaviorProfileStore.js
src/data/GcTrainingDataConsumer.js
src/data/storage/SqliteStore.js
src/data/exporters/TrainingExporter.js
src/core/GcV81ModelBootstrapper.js
src/core/GcV81AutoTrainer.js
src/core/TrainingRunner.js
training/models/gc_strategy_net.py
training/train_gc_strategy_model.py
```

## 사용자 생성 경로

```text
<agent-cwd>/
├── .env
├── config/
│   ├── operation.json
│   ├── operation.history/
│   └── behavior-profile files
├── data/
│   └── agent.db
├── training/data/<operation>/<profile>/
└── models/gc/generations/<operation>/<profile>/
    ├── gc_strategy_model.onnx
    ├── meta.json
    ├── evaluation.json
    └── auto-training-state.json
```

## 운영 인터페이스

```bash
npx appback-ai-agent init
npx appback-ai-agent doctor
npx appback-ai-agent operation show
npx appback-ai-agent operation verify
npx appback-ai-agent personality show
npx appback-ai-agent start
npx appback-ai-agent export
npx appback-ai-agent train
```

Health monitor는 기본 `:9090`에서 `/health`와 `/metrics`를 제공한다. 포트가 사용 중이면 제한된
범위에서 다음 포트를 찾는다. 프로세스는 SIGINT/SIGTERM graceful shutdown을 지원한다.

## 기준 문서

- 운영 계약: `../operations/OPERATION_VERSION_GUIDE.md`
- 학습 wire/data 계약: `../design/GC_TRAINING_DATA_INTEGRATION.md`
- v8.1 공동 계약과 이력: `../design/GC_AI_STRATEGY_V8_PLAN.md`
- 성격 CLI: `../operations/PERSONALITY_CLI_GUIDE.md`
- 모델 업로드: `../design/MODEL_UPLOAD.md`
