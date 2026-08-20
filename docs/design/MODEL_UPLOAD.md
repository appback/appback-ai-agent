# GC 모델 업로드 계약

현재 기준은 GC 계층형 전략 모델 v8.1이다. AI Agent는 학습·평가를 통과한 ONNX와
metadata를 후보 revision으로 업로드하고, GC 서버는 계약 검증·canary·runtime 품질 gate를
담당한다.

v6.0 `162 → 5`와 v7.0 `153 → 5` 이동 모델 업로드 방식은 legacy다. 신규 설치와 신규
학습은 `gc-v8-strategy-r2 / feature 8.1 / 214 → 11` 계약을 사용한다.

## 1. 책임 경계

```text
GC authoritative session/frame/result
  -> AI Agent cursor consumer
  -> profile별 teacher_strategy + sample_weight
  -> 214 → 128 → 64 → 11 학습
  -> offline gate + metadata/checksum 검증
  -> POST /agents/me/models/v8
  -> GC immutable candidate revision
  -> GC canary/runtime gate
  -> active 또는 rejected
```

- AI Agent: 데이터 동기화, 성격별 라벨·가중치, 학습, 오프라인 평가, 후보 업로드
- GC: canonical vector 생성, ONNX 계약 검증, revision 저장, 추론, 경로·공격 실행, rollout
- 모델: 전략과 target candidate를 선택
- 서버 실행기: BFS 경로, 동적 충돌, 실제 이동과 공격을 처리

## 2. 현재 모델 계약

| 항목 | 값 |
|---|---|
| operation | `gc-v8-strategy-r2` |
| feature version | `8.1` |
| schema ID | `gc-strategy-v8-214-r1` |
| input | finite `float32[214]` |
| network | `214 → 128 → 64 → 11` |
| output | 11 strategy logits |
| format | ONNX |
| max upload | 2MB |

출력 순서는 고정이다.

```text
hold
flee
seek_powerup
explore
attack_candidate_0
attack_candidate_1
attack_candidate_2
attack_candidate_3
attack_candidate_4
attack_candidate_5
attack_candidate_6
```

`operation_version`이 r2로 바뀌어도 canonical feature schema는 `gc-strategy-v8-214-r1`을
사용한다. r2의 주요 실행 차이는 `flee`를 최대 두 칸으로 실행하고 각 칸의 안전성을 다시
검증하는 것이다.

## 3. 업로드 API

```http
POST /api/v1/agents/me/models/v8
Content-Type: multipart/form-data
Authorization: Bearer <agent token>
```

multipart 필드:

- `model`: ONNX 파일
- `metadata`: JSON 문자열

AI Agent 구현은 `GcApiClient.uploadModelV8()`을 사용한다. 구
`POST /agents/me/model`은 legacy 이동 모델용이며 v8.1 후보 업로드에 사용하지 않는다.

metadata에는 최소한 다음 계약·provenance가 일치해야 한다.

- `operation_version`, `feature_version`, `feature_schema_hash`, `training_version`
- `feature_dim=214`, `output_dim=11`, 고정된 `action_labels`
- `behavior_profile_id`, `behavior_profile_hash`, `behavior_profile_revision`
- `observation_policy`, `source_behavior_profile_hashes`
- dataset session 수와 manifest hash
- model checksum과 evaluation report digest

서버는 feature version과 schema hash registry로 input/output shape와 label 순서를 검증한다.
교차 계약, 비정상 ONNX, 잘못된 metadata는 후보 생성 전에 거부한다.

## 4. 학습 및 자동 업로드

v8.1 runtime은 viewer WebSocket의 로컬 tick을 학습 입력으로 사용하지 않는다. GC가 제공하는
authoritative feed만 operation/profile별 SQLite table에 멱등 저장한다.

현재 성격으로 완료된 session이 `AUTO_TRAIN_AFTER_GAMES` 임계값(기본 50)에 도달하면:

1. `same_profile_only` dataset을 export한다.
2. `train_gc_strategy_model.py`로 `gc_strategy_model.onnx`를 만든다.
3. offline gate와 artifact checksum을 검증한다.
4. immutable 후보 revision으로 업로드한다.
5. `model_auto_rollout=true`이면 GC가 canary와 30게임 runtime gate를 수행한다.
6. gate 실패 시 기존 active를 유지하고 후보를 거부한다.

초기 데이터가 없는 기본 Easy profile은 패키지에 포함된 checksummed bootstrap 후보를 사용할
수 있다. `synthetic_bootstrap` 후보는 실제 frame 기반 `same_profile_only` 모델과 provenance가
구분된다.

## 5. 호환성과 격리

- v7.0 `153 → 5`: 과거 이동 모델 및 로컬 viewer 코드. 현재 operation 선택과 서버 광고 계약에서 제외됨.
- v8.0 `192 → 5`: 실험 direction 계약. v8.1과 registry·데이터·모델을 섞지 않음.
- v8.1 `214 → 11`: 현재 기본 전략 계약.

DB row, export, model generation은 `operation_version + behavior_profile_hash`로 격리한다.
v7/v8.0 artifact를 v8.1 후보로 자동 변환하거나 fallback하지 않는다.

## 6. 검증 명령

```bash
npx appback-ai-agent operation show
npx appback-ai-agent operation verify
npx appback-ai-agent doctor
npx appback-ai-agent export
npx appback-ai-agent train
```

구현 기준:

- 계약 상수: `src/config/operationContract.js`
- schema 검증: `src/config/gcStrategyV81Contract.js`
- 자동 학습·업로드: `src/core/GcV81AutoTrainer.js`
- trainer: `training/train_gc_strategy_model.py`
- wire/data 계약: `GC_TRAINING_DATA_INTEGRATION.md`
