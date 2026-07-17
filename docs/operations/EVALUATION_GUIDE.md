# 오프라인 평가 가이드

AI Agent의 미로 이동 정책을 서버 없이 재현 가능한 시나리오에서 검사하는 관리자 가이드다.

## 현재 범위

- evaluator: `gc-maze-v1`
- policy: BFS teacher baseline
- 기본 시나리오: 200개
- 기본 seed: `20260716`
- maze: 15x15, seed 기반 perfect maze
- 결과: JSON 품질 보고서

현재 ONNX 모델 자체를 추론하지 않는다. teacher 기준선이 올바른 경로와 라벨을 생성하는지 검증하며, 후속 단계에서 같은 evaluator에 ONNX action provider를 연결한다.

## 기본 실행

```bash
npx appback-ai-agent evaluate maze --preset navigator --scenarios 200 --seed 20260716
```

현재 저장된 personality를 평가하려면 `--preset`을 생략한다.

```bash
npx appback-ai-agent evaluate maze
```

기본 보고서 위치:

```text
reports/evaluation/maze-<profile-id>.json
```

## 성격 차별성 평가

```bash
npx appback-ai-agent evaluate personality
```

고정 전투 fixture에서 Easy 5개 profile의 action, reason과 target 종류를 비교한다.

현재 gate:

- low HP 적 조우에서 hunter는 추격하고 survivor는 도주
- 적과 powerup을 함께 제시하면 hunter는 적, collector는 powerup 우선
- 전체 profile에서 최소 3개 고유 decision signature 생성

기본 보고서:

```text
reports/evaluation/personality-differentiation.json
```

## 자동화 출력

```bash
npx appback-ai-agent evaluate maze \
  --preset navigator \
  --scenarios 200 \
  --seed 20260716 \
  --output ./reports/evaluation/navigator-ci.json \
  --json
```

종료 코드:

- `0`: 모든 품질 게이트 통과
- `1`: 명령 또는 설정 오류
- `2`: 평가 실행 완료, 품질 게이트 실패

## 지표와 기준

| 지표 | 기준 | 의미 |
|---|---:|---|
| `goal_reach_rate` | 0.95 이상 | 제한 행동 수 안에 목표 도달 |
| `path_efficiency` | 1.25 이하 | 실제 행동 수 / BFS 최단 행동 수 |
| `loop_rate` | 0.02 이하 | 2-cycle 또는 3-cycle 발생 시나리오 비율 |
| `invalid_action_rate` | 0 | action mask 위반 비율 |
| `no_progress_rate` | 관찰 | 3회 연속 목표 거리가 줄지 않은 시나리오 비율 |

## 재현성

같은 evaluator 버전, profile hash, scenario count, seed와 maze 크기는 같은 보고서를 생성한다. 회귀 비교 시 이 값을 모두 고정한다.

성격 variation이 있는 profile은 `personality show`에서 effective profile hash를 먼저 확인한다.

## 기준 결과

`navigator`, variation 0, seed 1인 profile을 200개 시나리오로 평가한 기준 결과:

```text
goal_reach_rate:    1.000
path_efficiency:    1.000
loop_rate:          0.000
invalid_action_rate:0.000
no_progress_rate:   0.000
```

저장된 기준 보고서: `reports/evaluation/maze-navigator.json`

성격 차별성 기준 보고서: `reports/evaluation/personality-differentiation.json`

## v8.1 Round 7 bootstrap 후보

실제 v8.1 frame이 없는 최초 canary 수집용 모델은 deterministic synthetic raw state로만 생성한다.
이 절차는 운영 데이터가 아니며 결과 metadata에 `observation_policy=synthetic_bootstrap`과 빈
`source_behavior_profile_hashes`를 강제한다.

```bash
npm run gc:v81:bootstrap -- --sessions 256 --samples 8 --seed 8107

for profile in balanced hunter survivor navigator; do
  python3 training/train_gc_strategy_model.py \
    --data-dir "training/data/v8.1-round7/$profile" \
    --output-dir "artifacts/gc-v81-round7/$profile" \
    --epochs 80 --batch-size 128 --seed 8107
done

python3 training/evaluate_gc_strategy_v81_candidates.py \
  --data-root training/data/v8.1-round7 \
  --models-root artifacts/gc-v81-round7

python3 training/validate_gc_strategy_v81_artifacts.py \
  --root artifacts/gc-v81-round7
```

각 profile 디렉토리는 `gc_strategy_model.onnx`, `meta.json`, `evaluation.json` 세 파일을 가진다.
root의 `profile-differentiation.json`은 같은 2,048개 관측에 대한 네 모델의 전략 분포와
pairwise disagreement를 기록한다. validator는 GC upload metadata의 필드 집합, checksum,
evaluation digest, ONNX 214/11 shape 및 모든 offline gate를 fail-closed로 검사한다.

이 후보는 격리 테스트 서버 canary만 허용한다. 운영 active, known-good, rollback 또는 strict
전환에 사용하지 않으며, profile별 실게임 frame 수집 후 `same_profile_only` 후보로 교체한다.
