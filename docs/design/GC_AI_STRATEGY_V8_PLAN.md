# GC AI 계층형 전략 v8.1 공동 개발계획

상태: **AI Agent 1차 초안, GC 검토 대기**
작성 기준: AI Agent `6270f6b`, GC `6cdc6c4`
상위 계약: `GC_TRAINING_DATA_INTEGRATION.md`

## GC 담당자 전달 지시

**GC 담당자에게는 이 파일 하나만 전달한다.** 별도 요청서나 설명문은 필요하지 않다.

GC 담당자는 현재 GC 코드와 이 계획을 대조하되 아직 구현·배포하지 않는다. 먼저 `10. AI Agent와 GC 교차 검증 절차`의 Round 2 항목을 검토하고 각 항목을 다음 형식으로 회신한다.

```text
[항목]
판정: ACCEPT | CHANGE | REJECT
코드 근거: 파일:라인
이유:
수정 제안:
AI Agent 영향:
GC 영향:
```

회신 마지막에는 feature version, input/output dimension, strategy label 순서, candidate ordering, path executor, attack target, training frame 계약의 GC 최종 제안표를 포함한다. AI Agent는 그 회신을 받아 이 문서를 revision 2로 수정한다.

## 1. 재설계 결론

기존 v8.0은 192차원 입력으로 다음 한 칸의 방향 5개를 선택한다. GC의 BFS는 feature 생성과 안전 fallback에 사용되지만 모델이 선택한 고수준 목표를 끝까지 실행하지 않는다. 공격 대상도 모델이 아니라 GC의 거리·slot 고정 규칙이 선택한다.

이 구조로는 다음 요구를 충족하지 못한다.

- 성격에 따라 동일 사거리의 여러 적 중 다른 대상을 선택
- 공격, 도주, 수집, 탐색의 전략적 차이
- 모델은 목표를 선택하고 서버가 미로 경로를 책임지는 계층형 실행
- 선택한 공격 대상을 이동 단계부터 공격 단계까지 유지

따라서 첫 v8 운영 모델을 만들기 전에 계약을 다음과 같이 재설계한다.

- 기존 실험 계약: `feature 8.0 / 192 / 5방향`은 운영 미적용 상태로 동결
- 신규 계약 초안: `feature 8.1 / 214 / 11전략`
- 모델 역할: 전략과 공격 후보 선택
- GC 역할: 목표 좌표 결정, BFS/A* 경로 실행, 동적 재탐색, 실제 공격
- AI Agent 역할: 성격별 전략 교사 라벨, 학습, 평가, ONNX 생성

`214/11`은 GC 1차 검토 전 draft다. 양측 canonical schema와 fixture가 일치한 뒤에만 동결한다.

## 2. 책임 경계

### 전략 모델

모델은 매 의사결정 시점에 다음 중 하나를 선택한다.

| index | label | 의미 |
|---:|---|---|
| 0 | `hold` | 현재 위치 유지 |
| 1 | `flee` | 현재 위협에서 이탈 |
| 2 | `seek_powerup` | 유효한 파워업 확보 |
| 3 | `explore` | 미방문·저방문 영역 탐색 |
| 4 | `attack_candidate_0` | 고정 후보 0 공격 |
| 5 | `attack_candidate_1` | 고정 후보 1 공격 |
| 6 | `attack_candidate_2` | 고정 후보 2 공격 |
| 7 | `attack_candidate_3` | 고정 후보 3 공격 |
| 8 | `attack_candidate_4` | 고정 후보 4 공격 |
| 9 | `attack_candidate_5` | 고정 후보 5 공격 |
| 10 | `attack_candidate_6` | 고정 후보 6 공격 |

총 11개 단일 softmax 출력을 사용한다. 다중 head는 초기 validator·ONNX·운영 추론 복잡도를 불필요하게 높이므로 첫 계약에서는 사용하지 않는다.

### GC 서버

GC는 모델 선택을 실제 게임 행동으로 변환한다.

- battle 시작 시 자기 자신을 제외한 최대 7명에 stable candidate index 부여
- 선택한 공격 후보의 현재 위치와 공격 가능 위치 계산
- 무기 `range_type`과 사거리를 반영한 목표 셀 집합 생성
- BFS 또는 A*로 목표 셀까지의 첫 이동 계산
- terrain, 생존 agent의 동적 점유, action readiness 반영
- 이동 실패, target 사망, 길 막힘, 2-cycle/3-cycle 발생 시 재탐색
- 공격 단계에서 모델이 선택한 target을 우선 공격
- 선택 target이 무효해진 경우 명시적인 fallback과 override 사유 기록
- 최종 위치 변화와 실제 공격 대상을 authoritative 결과로 기록

GC는 behavior profile 가중치를 해석하지 않는다. 성격 차이는 학습된 모델 출력으로 반영한다.

### AI Agent

- 관리자 성격을 전략 교사 규칙으로 컴파일
- 같은 상태에서 hunter/survivor/collector/navigator가 서로 다른 전략 label을 생성
- 공격 후보별 utility 계산
- 전략 label과 공격 대상 label을 하나의 11-class label로 변환
- GC authoritative vector를 학습 입력으로 사용
- 전략 정확도, target 정확도, path 실행 결과를 분리 평가
- 품질 게이트를 통과한 `gc_strategy_net`만 업로드

## 3. 공격 후보 계약

### Stable candidate map

후보 index가 틱마다 거리순으로 바뀌면 같은 출력 index의 의미가 흔들린다. candidate map은 session 동안 고정한다.

1. battle 시작 roster에서 자기 slot 제외
2. session-local slot 오름차순 정렬
3. `candidate_0..6`에 고정 배정
4. 사망·이탈한 후보 block은 `present=0`, `alive=0`
5. battle 중 index를 당겨 채우지 않음

Training session manifest에 다음 값을 저장한다.

```json
{
  "strategy_candidates": [
    {"candidate": 0, "slot": 0},
    {"candidate": 1, "slot": 2}
  ]
}
```

상대의 영구 agent ID나 소유자 정보는 제공하지 않는다.

### 공격 대상 실행

- `attack_candidate_n`이 선택되고 target이 생존·도달 가능하면 해당 target을 유지한다.
- 이미 사거리 안이면 이동하지 않고 해당 target을 공격한다.
- 사거리 밖이면 GC가 공격 가능한 셀까지 이동한다.
- target이 먼저 사망하면 `target_dead` override 후 현재 살아 있는 후보 중 deterministic fallback을 선택한다.
- target이 도달 불가능하면 `target_unreachable` override 후 재추론 또는 fallback한다.
- 동률 fallback은 slot 오름차순으로 고정하되 반드시 frame에 기록한다.
- pierce/AOE가 다른 적에게 추가 피해를 주더라도 primary target은 모델 선택 target으로 기록한다.

## 4. 입력 feature 8.1 초안

### 차원

현재 v8.0은 적 6명만 표현한다. 최대 8인 게임에서는 상대가 7명이므로 전략 모델에 한 명이 보이지 않는다. 또한 후보별 BFS 비용과 방어 상태가 명확해야 한다.

초안은 214차원으로 구성한다.

| 블록 | 차원 | 내용 |
|---|---:|---|
| self/game/loadout | 26 | 자기 전투 상태, 장비, 진행 상태 |
| enemy candidates | 112 | stable 후보 7명 x 16 feature |
| arena/directional | 35 | terrain, 이동 가능성, 방향별 위험·공간 |
| temporal/navigation | 21 | 이전 전략·행동, 방문, 무진행, loop, target 지속 |
| strategy feasibility | 20 | 11개 전략 mask와 aggregate 위험·목표 가능성 |
| 합계 | 214 | exact finite float vector |

후보별 16개 feature 초안:

1. `present_alive`
2. `hp_ratio`
3. `dx_ratio`
4. `dy_ratio`
5. `manhattan_ratio`
6. `bfs_attack_path_ratio`
7. `reachable`
8. `damage_ratio`
9. `range_ratio`
10. `defense_ratio`
11. `evasion_ratio`
12. `action_readiness`
13. `can_hit_self`
14. `self_can_hit`
15. `kills_ratio`
16. `weapon_tactical_code`

정확한 index, clamp, normalization은 GC가 authoritative schema JSON을 작성하고 AI Agent가 fixture로 검증한 후 동결한다. 의미 없는 padding은 추가하지 않는다.

## 5. 전략 mask

모델 입력과 서버 추론에는 정확히 11개의 binary mask를 사용한다.

- `hold`: 항상 1
- `flee`: 생존 적이 있고 이동 가능한 안전 후보가 있을 때 1
- `seek_powerup`: capability와 활성·도달 가능한 powerup이 있을 때 1
- `explore`: 도달 가능한 저방문 셀이 있을 때 1
- `attack_candidate_n`: 후보가 생존하고 공격 가능 위치까지 경로가 있을 때 1

mask 적용 전 최대 logit은 `raw_argmax_strategy`, mask 적용 후 결과는 `model_strategy`로 분리한다. 모든 attack 후보가 mask 0이면 서버가 임의의 죽은 target을 선택해서는 안 된다.

## 6. 경로 실행 계약

전략 선택과 실제 이동을 분리한다.

```text
214 feature + 11 mask
        |
        v
ONNX model_strategy
        |
        v
GC goal resolver
        |
        v
BFS/A* first step + dynamic collision check
        |
        v
executed_action + executed_target
```

전략별 goal resolver:

- `attack_candidate_n`: target을 공격할 수 있는 유효 셀 집합
- `flee`: 예상 피격 수를 최소화하고 적과의 최소 거리를 최대화하는 셀
- `seek_powerup`: 활성 powerup 셀
- `explore`: 방문 수와 경로 비용이 낮은 reachable 셀
- `hold`: 현재 셀

GC는 한 번에 경로 전체를 예약하지 않고 매 action 시점에 한 칸만 실행한다. target·점유·위험이 바뀌면 다음 action에서 재탐색한다.

## 7. 학습 frame 계약 변경

기존 방향 action 필드와 전략 필드를 혼용하지 않는다.

```json
{
  "input": {
    "feature_vector": "exactly 214 finite numbers",
    "strategy_mask": [1, 1, 0, 1, 1, 0, 0, 0, 0, 0, 0]
  },
  "inference": {
    "raw_argmax_strategy": "attack_candidate_1",
    "model_strategy": "attack_candidate_0"
  },
  "execution": {
    "executed_strategy": "attack_candidate_0",
    "selected_target_slot": 2,
    "executed_target_slot": 2,
    "path_action": "left",
    "executed_action": "left",
    "strategy_override_reason": null,
    "movement_override_reason": null
  }
}
```

AI Agent 파생 필드:

- `teacher_strategy`
- `teacher_target_slot`
- `teacher_reason`
- `observed_strategy`
- `sample_weight`

모델의 전략 선택, 서버 path step, 실제 이동, 실제 공격 target을 각각 분리 저장한다.

## 8. 성격별 교사 정책

### 공격 후보 utility

교사는 모든 생존 후보를 평가한다.

```text
target_utility
  = kill_weight * kill_probability
  + damage_weight * expected_damage
  + threat_weight * enemy_threat
  + finish_weight * enemy_low_hp
  - survival_weight * retaliation_risk
  - path_weight * bfs_attack_path
```

- hunter: 낮은 HP, 높은 처치 가능성, 높은 피해 기대값 우선
- survivor: 위협이 낮고 반격 위험이 작은 target만 선택, 불리하면 flee
- collector: 안전한 powerup이 있으면 전투보다 수집 우선
- navigator: 도달 가능성과 경로 효율을 강하게 반영
- balanced: 처치·생존·경로 비용을 균형 반영

동일 사거리의 다수 적도 HP, 방어, 위협, 반격 가능성, 성격 가중치에 따라 다른 target label을 생성한다.

## 9. 버전 및 격리

초안 식별자:

- protocol: `1` 유지 가능 여부 GC 검토
- feature version: `8.1`
- feature schema: `gc-strategy-v8-214-r1`
- operation version: `gc-v8-strategy-r1`
- training version: `teacher-strategy-v8-r1`
- model name: `gc_strategy_net`
- input dimension: `214`
- output dimension: `11`

격리 규칙:

- v7 153/5, v8.0 192/5, v8.1 214/11 데이터·모델을 혼합하지 않음
- 기존 v8.0 frame은 v8.1 운영 학습 입력으로 자동 변환하지 않음
- raw state는 새 교사 검증용으로만 명시적 재사용 가능
- model validator는 schema hash, 214 input, 11 output, label 순서를 모두 검사
- v8.1 known-good revision 없이 strict 전환하지 않음

## 10. AI Agent와 GC 교차 검증 절차

양쪽이 독립적으로 구현한 뒤 마지막에 맞추는 방식을 금지한다. 다음 순서로 번갈아 검증한다.

### Round 1: AI Agent 초안

이 문서로 다음을 제안한다.

- 214 feature block
- stable candidate map
- 11 strategy labels/mask
- target 유지와 override 의미
- training frame 필드

산출물: 본 계획서와 GC 검토 질문.

### Round 2: GC 계약 검토

GC는 코드 기준으로 다음을 답한다.

1. stable candidate map을 battle/session lifecycle에 유지 가능한가?
2. 선택 target을 move phase에서 attack phase까지 전달 가능한가?
3. ranged/pierce/AOE target 실행 규칙에 누락이 있는가?
4. 214 feature 각 블록에 authoritative 원천이 존재하는가?
5. 11 mask를 추론 서비스와 validator에 적용 가능한가?
6. frame/session/result에 새 필드를 immutable하게 저장 가능한가?
7. 기존 v7 운영을 유지하며 8.1 canary를 격리할 수 있는가?

GC는 각 항목을 `accept/change/reject`로 답하고 변경안을 제시한다.

회신 마지막 표:

| 계약 | AI 초안 | GC 제안 | 합의 가능 여부 |
|---|---|---|---|
| feature version | 8.1 | | |
| input dimension | 214 | | |
| output dimension | 11 | | |
| strategy labels | hold/flee/seek_powerup/explore/attack_candidate_0..6 | | |
| candidate ordering | session 고정 slot 오름차순 | | |
| path executor | GC 소유 | | |
| attack target | model 선택 우선 | | |
| training frame | strategy/path/action/target 분리 | | |

### Round 3: AI Agent 계약 수정

GC 답변을 반영해 다음을 확정한다.

- schema ID와 정확한 214 index 표
- strategy label 순서
- teacher target utility와 mask parity
- CSV/manifest/model metadata
- Easy/Expert profile 필드 영향

### Round 4: GC fixture 선구현

GC가 source of truth로 제공한다.

- canonical schema JSON과 SHA-256
- raw state -> 214 vector fixture
- candidate map과 11 mask fixture
- strategy -> path step -> attack target fixture
- target 사망, unreachable, dynamic collision, flee, maze fixture

### Round 5: AI Agent parity

AI Agent는 fixture를 그대로 읽어 다음을 검증한다.

- 214 vector/mask 완전 일치
- teacher strategy/target 기대값
- exporter와 trainer 11-class shape
- ONNX input/output와 metadata
- personality differentiation

### Round 6: 테스트 서버 E2E

1. GC 8.1 observe 배포
2. AI Agent test identity 등록
3. 214/11 fixture model upload
4. 관리자 canary 지정
5. 실제 게임 생성
6. 선택 target과 실제 공격 target 비교
7. 미로·동적 충돌·target 사망 재탐색 확인
8. frame/result cursor 수집
9. 임시 데이터 정리

### Round 7: 운영 전환

- canary 품질 게이트 승인
- known-good 8.1 revision 지정
- v8.1 agent 범위 확대
- 구 v8.0 test revision 폐기
- 마지막에 strict 최소 버전 전환

## 11. 품질 게이트

필수 gate:

- invalid strategy rate = 0
- masked strategy execution rate = 0
- selected target mismatch rate = 0, override 제외
- target override reason 누락 = 0
- unreachable target loop rate < 1%
- 2-cycle/3-cycle rate < 기존 v7 기준
- deterministic maze 해결률 = 100%
- 동일 상태 personality strategy 차별성 fixture 통과
- 공격 가능한 다수 target fixture에서 profile별 기대 target 일치
- inference timeout/failure 시 게임 정상 진행률 = 100%

성능 gate는 canary 데이터 분포를 확인한 뒤 절대값을 동결한다.

## 12. 작업 순서

현재는 계획과 계약 검토만 수행한다. 구현은 GC Round 2 답변 이후 시작한다.

1. GC 계약 검토 및 수정안 회신
2. AI Agent 계획서 revision 2 확정
3. GC schema/fixture/path executor 구현
4. AI Agent teacher/export/trainer 구현
5. 양쪽 fixture parity
6. test server model upload/canary E2E
7. 문서·CLI guide·operation guide 동시 갱신
8. npm 배포 및 관리 agent 순차 업데이트

## 13. 미결정 항목

GC 검토에서 반드시 확정한다.

- 214차원 구성과 후보별 16개 feature의 정확한 정규화
- BFS와 A* 중 운영 path executor
- `hold` 상태에서 자동 공격 허용 여부
- target 사망 시 즉시 재추론 또는 deterministic fallback
- flee goal의 최대 탐색 반경과 위험 비용
- powerup 기능 비활성 기간의 label/mask 처리
- protocol version 유지 또는 증가
- v8.0 test 데이터·revision 폐기 시점
