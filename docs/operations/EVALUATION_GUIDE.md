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
