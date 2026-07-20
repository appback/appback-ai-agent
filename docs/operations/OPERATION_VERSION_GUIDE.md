# 운영 버전 관리 가이드

AI Agent는 학습 데이터, 통계, ONNX 모델이 서로 다른 feature 구조나 성격 사이에서 섞이지 않도록 **운영 계약(Operation Contract)** 으로 격리한다.

## 격리 기준

각 게임 세션에는 다음 값이 기록된다.

- `operation_version`: 운영 세대 ID
- `feature_version`, `feature_dim`, `feature_schema_hash`: 입력 feature 계약
- `training_version`: 라벨·reward·학습 파이프라인 버전
- `behavior_profile_id`, `behavior_profile_hash`: 관리자 성격 설정과 실제 적용값

게임 수, 성능 통계, 학습 export는 `operation_version + behavior_profile_hash`가 현재 실행 설정과 정확히 같은 데이터만 사용한다.

기존 DB 행은 마이그레이션 시 삭제하지 않고 `legacy-unversioned`로 태깅한다. 현재 운영 데이터로 자동 승격하지 않으며 새 학습에 포함되지 않는다.

## 경로 규칙

```text
training/data/<operation-version>/<profile-hash>/
models/gc/generations/<operation-version>/<profile-hash>/
```

각 학습 데이터 디렉토리에는 `operation-manifest.json`이 생성된다. 모델의 `meta.json`에도 동일한 운영 계약과 성격 정보가 기록된다.
모델 로더는 ONNX를 열기 전에 metadata의 운영 버전, feature schema, 학습 버전, 성격 hash와 입출력 차원을 현재 계약과 비교한다. 하나라도 다르면 모델을 거부하고 rule-based 수집 모드로 동작한다.

## CLI

```bash
npx appback-ai-agent operation show
npx appback-ai-agent operation verify
npx appback-ai-agent operation history
npx appback-ai-agent operation activate v7 --yes
npx appback-ai-agent operation activate v8 --yes
npx appback-ai-agent operation activate v81 --yes
```

`v8`은 실험 이동 계약 `8.0/192/5`, `v81`은 전략 계약 `8.1/214/11`이다. `init` 또는 최초 실행은 v7 계약을 기본 초기화한다. v8 계열은 대상 agent에서만 명시적으로 활성화한다. 저장된 계약은 재시작 시 자동 감지되며 계약과 다른 데이터, export, model은 사용할 수 없다.

## GC 서버 전환 연동

AI Agent는 agent token으로 인증하는 HTTP 요청에 다음 bridge 헤더를 보낸다. 공유 Socket.IO/WebSocket에는 전역 계약 헤더를 강제하지 않는다.

```http
X-GC-Protocol-Version: 1
X-AI-Agent-Version: <package semver>
```

시작할 때 `GET /api/v1/agent-contract`를 조회한다. `observe`에서는 불일치를 경고만 하고 기존 v7 실행을 유지한다. `strict`에서 protocol, feature version 또는 minimum agent version이 맞지 않으면 등록·queue 진입 전에 시작을 중단한다.

feature version은 로컬 운영 계약과 서버의 `accepted_feature_versions`/`required_feature_version`을 비교한다. ONNX 업로드 시에는 별도의 모델 metadata로 다시 검증한다.

v8 운영 학습 데이터는 GC의 cursor 기반 training frame/result/session API에서 별도 table로 수집한다. operation, feature version/dim/schema hash가 일치하는 frame만 저장하며 batch 저장이 끝난 후에만 cursor를 갱신한다. 상세 계약은 `../design/GC_TRAINING_DATA_INTEGRATION.md`를 따른다.

검토 후 새 운영 세대를 활성화한다.

```bash
npx appback-ai-agent operation show
npx appback-ai-agent operation activate v8 --yes
npx appback-ai-agent doctor
npx appback-ai-agent start
```

`activate v8 --yes`는 이전 계약을 `config/operation.history/`에 보관하고 v8 계약을 활성화한다. 기존 데이터나 모델을 삭제하지 않지만 새 운영 세대에서는 조회하거나 로드하지 않는다.

v8.1 Round 6 격리 E2E는 완료됐으며 운영 전환 전까지 테스트 agent에서만 다음을 사용한다. GC `/agent-contract`가 `8.1`을 광고하고 `capabilities.strategy_v8_1=true`를 반환하며 canonical schema hash가 일치해야 한다. v8.1은 observe 모드에서도 capability가 없거나 계약 조회가 실패하면 시작을 중단한다. 이는 feature 번호만 먼저 광고된 불완전한 서버에서 전략 모델을 실행하지 않기 위한 예외적인 fail-closed 규칙이다.

```bash
npx appback-ai-agent operation activate v81 --yes
npx appback-ai-agent operation verify
npx appback-ai-agent doctor
```

v8에서는 기존 viewer snapshot과 로컬 153차원 FeatureBuilder 결과를 저장하거나 자동학습에 사용하지 않는다. GC가 제공하는 authoritative frame/result/session feed만 30초 간격으로 수집한다. 필요하면 `.env`에서 `GC_TRAINING_SYNC_ENABLED=false`로 중지하거나 `GC_TRAINING_SYNC_INTERVAL_SEC`로 주기를 조정한다.

수집된 v8 frame은 다음 명령으로 현재 성격의 teacher label과 sample weight를 적용해 내보낸다. v8.0은 192차원 이동 label, v8.1은 214차원 전략 label을 생성한다.

```bash
npx appback-ai-agent export
npx appback-ai-agent train
```

v8.1은 현재 성격으로 완료된 authoritative session이 `AUTO_TRAIN_AFTER_GAMES`에
도달할 때마다 `same_profile_only` dataset을 export하고 214→11 모델을 학습한다.
offline gate를 모두 통과한 모델만 immutable revision으로 자동 업로드하며, 서버의
`model_auto_rollout` capability가 있으면 GC가 canary와 runtime 품질 평가를 수행해 자동 active
전환한다. 30게임 gate 실패 시 기존 active를 유지하고 후보만 거부한다. 실패한 동일 세대의 재시도
간격은 `AUTO_TRAIN_RETRY_MINUTES`이고, 필요하면
`GC_V81_AUTO_TRAIN_ENABLED=false`로 학습만 중지할 수 있다.

## 성격 변경 시 동작

성격의 effective hash가 바뀌면 동일 운영 버전 안에서도 별도 학습 세대로 시작한다. 이전 성격 데이터와 모델은 유지되지만 새 성격의 50게임 카운트, 통계, export 및 ONNX에는 포함되지 않는다.

- 실행 중인 agent와 이미 시작된 학습은 시작 시점의 profile snapshot으로 완료한다.
- 변경된 성격은 agent 재시작 후 teacher·export·학습 generation에 적용한다.
- 기본 `export`는 현재 `behavior_profile_hash`로 수집된 frame만 사용한다.
- 다른 성격의 raw frame을 재사용하려면 `export --reuse-observations`를 명시해야 한다.
- 재사용 모드는 과거 label을 섞지 않고 모든 raw frame을 현재 teacher로 다시 라벨링하며, manifest에 `observation_policy=reuse_and_relabel`과 원본 profile hash 목록을 기록한다.
- GC frame의 profile hash는 실제 추론 모델 revision에서 오므로, 새 성격과 일치하는 strict frame 수집은 해당 hash의 모델이 GC canary 또는 active에 진입한 이후 시작한다.

새 성격에 데이터가 전혀 없을 때는 다음 둘 중 하나를 선택한다.

1. 이전 raw observation을 `--reuse-observations`로 다시 라벨링해 최초 후보 모델을 만든 뒤 canary에서 새 성격 전용 데이터를 수집한다.
2. 검증된 bootstrap 모델을 새 profile metadata로 업로드해 canary 수집부터 시작한다.

어느 경우에도 이전 성격의 label이나 ONNX를 새 성격 dataset에 그대로 포함하지 않는다.
초기 v8.1 bootstrap은 `balanced`, `hunter`, `survivor`, `navigator`를 독립 모델로 생성한다.
powerup capability가 false인 동안 `collector`와 `seek_powerup` label은 bootstrap 대상에서 제외한다.
synthetic 모델은 GC의 `synthetic_bootstrap` transition 정책에 따라 canary만 가능하며 active와
rollback은 금지된다. 실제 frame을 수집한 뒤 `same_profile_only` provenance로 재학습해야 한다.
신규 설치는 기본 성격을 revision 1로 저장하고, GC가 `model_auto_rollout=true`를 광고할 때 현재 Easy
프리셋의 checksummed bootstrap을 자동 업로드한다. 네 프리셋 외 custom 성격은 다른 모델로 위장하지
않으며 별도 bootstrap 생성 또는 raw observation 재라벨링이 필요하다. bootstrap 업로드 실패는
프로세스를 재시작시키지 않고 training sync 주기에서 재시도한다.

## v8 전환 원칙

1. GC 서버의 v8 API와 canary 모델 준비를 확인한다.
2. 대상 agent에서만 `operation activate v8 --yes`를 실행한다.
3. `operation verify`와 `doctor`가 v8 192차원 계약을 확인하는지 검사한다.
4. v8 성격별 데이터는 0게임부터 새로 수집한다.
5. v8 데이터로 학습된 모델만 v8 generation 경로에서 업로드한다.

기존 v7 DB와 ONNX는 즉시 삭제하지 않는다. 롤백 및 감사용으로 보관하고, 보존기간이 지난 후 별도 운영 절차로 정리한다.
