# GC AI 계층형 전략 v8.1 공동 개발계획

상태: **revision 2, Round 5 parity 완료, GC Round 6 선행 구현 교차 검증 중**
작성 기준: AI Agent `25858b3`, GC `20d9aa5a`
상위 계약: `GC_TRAINING_DATA_INTEGRATION.md`

## GC 담당자 전달 지시

**GC 담당자에게는 이 파일 하나만 전달한다.** Round 2 계약 검토, Round 4 canonical 구현, Round 5 AI Agent parity가 완료됐다.

GC `20d9aa5a`에서 v8.1 runtime, record v2 frame, 8.1 capability 광고, AOE primary-first 격리 경로가 구현됐다. 교차 검증에서 모델 upload는 8.1을 허용하지만 관리자 canary/activate/rollback 전환은 아직 v8.0 단일 계약만 허용하는 누락이 확인됐다. GC는 `admin_model_v8.go`의 전환 검사를 feature contract registry 기반으로 바꾸고 v8.0/8.1 전환 회귀 테스트를 추가해야 한다. 이 보강 후에만 격리 테스트 서버에 배포하고 AI Agent가 fixture model·test identity로 Round 6 E2E를 검증한다. 운영 배포와 strict 전환은 수행하지 않는다.

## 1. 재설계 결론

기존 v8.0은 192차원 입력으로 다음 한 칸의 방향 5개를 선택한다. GC의 BFS는 feature 생성과 안전 fallback에 사용되지만 모델이 선택한 고수준 목표를 끝까지 실행하지 않는다. 공격 대상도 모델이 아니라 GC의 거리·slot 고정 규칙이 선택한다.

이 구조로는 다음 요구를 충족하지 못한다.

- 성격에 따라 동일 사거리의 여러 적 중 다른 대상을 선택
- 공격, 도주, 수집, 탐색의 전략적 차이
- 모델은 목표를 선택하고 서버가 미로 경로를 책임지는 계층형 실행
- 선택한 공격 대상을 이동 단계부터 공격 단계까지 유지

따라서 첫 v8 운영 모델을 만들기 전에 계약을 다음과 같이 재설계한다.

- 기존 실험 계약: `feature 8.0 / 192 / 5방향`은 운영 미적용 상태로 동결
- 신규 계약: `feature 8.1 / 214 / 11전략`
- 모델 역할: 전략과 공격 후보 선택
- GC 역할: 목표 좌표 결정, BFS 경로 실행, 동적 재탐색, 실제 공격
- AI Agent 역할: 성격별 전략 교사 라벨, 학습, 평가, ONNX 생성

출력 11개와 label 순서 및 입력 214개 exact schema는 GC canonical fixture와 AI Agent Round 5 parity 통과 결과를 기준으로 동결한다.

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
- BFS로 목표 셀까지의 첫 이동 계산
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
4. 사망·미배정 후보 block은 `available_alive=0`
5. battle 중 index를 당겨 채우지 않음

candidate map은 agent별 session-local map이다. 같은 battle에서도 자기 자신을 제외하므로 agent마다 candidate index와 slot의 대응이 다르다. `available_alive`는 `assigned && alive`로 정의하며 배정 여부 자체는 manifest로 감사한다.

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
- target이 사망·도달 불가이면 같은 action에서 ONNX를 다시 호출하지 않는다.
- 상황에 따라 `target_dead`, `target_unreachable`, `target_not_in_range_after_move` override를 기록한다.
- `target_not_in_range_after_move`는 이번 한 칸으로 공격 가능할 예정이었으나 동적 충돌·상태 변경으로 실패한 경우에만 기록한다. BFS 경로가 2칸 이상인 정상 중간 이동에는 기록하지 않는다.
- 현재 공격 가능한 후보 중 candidate index가 가장 작은 대상을 deterministic fallback으로 선택한다.
- fallback 후보가 없으면 `hold/no_attack`으로 종료한다.
- `hold`은 이동하지 않고 자동 공격도 하지 않는다.

무기별 primary target 규칙:

- `adjacent`: Manhattan 거리 `1..range`
- `ranged`: Manhattan 거리 `2..range`; 거리 1은 공격 불가
- `pierce`: 같은 행 또는 열이고 Manhattan 거리 `1..range`; 현재 계약에서는 terrain projectile occlusion을 적용하지 않음
- AOE: primary normal hit 후 primary cell 기준 Chebyshev 거리 1에 splash 적용
- pierce/AOE 추가 피격 대상은 event에만 기록하며 `executed_target_slot`은 primary target을 뜻함

## 4. 입력 feature 8.1 확정 schema

### 공통 규칙

- vector는 정확히 214개의 finite `float32`다.
- `safe(v)`는 NaN/Inf를 0으로 바꾸고 `[-1, 1]`로 clamp한다.
- `ratio(v,d)=safe(v/max(1,d))`, `max_path=max(1,width+height-2)`를 사용한다.
- binary와 one-hot은 정확히 0 또는 1이다.
- 방향 순서는 `up, down, left, right`, 8방향 순서는 `up, down, left, right, up_left, up_right, down_left, down_right`다.
- weapon 순서는 `sword, dagger, hammer, bow, spear`다. 알 수 없는 weapon의 one-hot/code는 모두 0이다.
- `strategy_mask` 11개는 vector index `194..204`와 별도 inference mask에 동일한 builder 결과를 사용한다.
- powerup capability가 false이면 관련 raw state는 empty이고 `seek_powerup` mask와 teacher label은 비활성화한다.

### 블록 경계

| 블록 | index | 차원 | 내용 |
|---|---|---:|---|
| self/game/loadout | 0..25 | 26 | 자기 전투 상태, 무기, 진행 상태 |
| enemy candidates | 26..137 | 112 | stable 후보 7명 x 16 feature |
| arena/directional | 138..172 | 35 | terrain, 이동 가능성, 방향별 거리 |
| temporal/navigation | 173..193 | 21 | 이전 전략, 방문, 무진행, loop |
| strategy feasibility | 194..213 | 20 | 11 mask와 전술 aggregate |
| 합계 | 0..213 | 214 | exact finite vector |

### Self/game/loadout 0..25

| index | 이름 | 값 |
|---:|---|---|
| 0 | `self.hp_ratio` | `HP / MaxHP` |
| 1 | `self.x_ratio` | `X / width` |
| 2 | `self.y_ratio` | `Y / height` |
| 3 | `self.damage_ratio` | `((DamageMin+DamageMax)/2) / 20` |
| 4 | `self.range_ratio` | attack range `/ 5` |
| 5 | `self.armor_reduction_ratio` | flat armor reduction `/ 20` |
| 6 | `self.bonus_defense_ratio` | flat bonus defense `/ 20` |
| 7 | `self.evasion_ratio` | evasion `/ 0.5` |
| 8 | `self.effective_speed_ratio` | effective speed `/ 120` |
| 9 | `self.action_readiness` | action accumulator `/ 100` |
| 10 | `self.score_ratio` | score `/ 1000` |
| 11 | `self.kills_ratio` | kills `/ 7` |
| 12 | `self.damage_taken_ratio` | cumulative damage taken `/ 1000` |
| 13 | `self.damage_dealt_ratio` | cumulative damage dealt `/ 1000` |
| 14 | `self.survived_ticks_ratio` | survived ticks `/ max_ticks` |
| 15 | `self.alive` | alive binary |
| 16..20 | `self.weapon_*` | weapon 5-way one-hot |
| 21 | `self.range_type_adjacent` | adjacent binary |
| 22 | `self.range_type_ranged` | ranged binary |
| 23 | `self.range_type_pierce` | pierce binary |
| 24 | `game.alive_enemy_ratio` | alive enemies `/ 7` |
| 25 | `game.tick_ratio` | current tick `/ max_ticks` |

강화 tier 문자열은 직접 입력하지 않는다. 강화가 반영된 authoritative damage, range, defense, evasion, speed만 사용하므로 별도 tier snapshot이 없어도 vector를 재현할 수 있다.

### Candidate 26..137

후보 `n=0..6`의 `base=26+16*n`이다.

| offset | 이름 | 값 |
|---:|---|---|
| 0 | `available_alive` | `assigned && alive` |
| 1 | `hp_ratio` | `HP / MaxHP` |
| 2 | `dx_ratio` | `(enemy.X-self.X) / width` |
| 3 | `dy_ratio` | `(enemy.Y-self.Y) / height` |
| 4 | `manhattan_ratio` | Manhattan distance `/ max_path` |
| 5 | `bfs_attack_path_ratio` | shortest attack path `/ max_path`; unreachable은 1 |
| 6 | `reachable` | 공격 가능한 셀에 도달 가능하면 1 |
| 7 | `damage_ratio` | `((DamageMin+DamageMax)/2) / 20` |
| 8 | `range_ratio` | attack range `/ 5` |
| 9 | `defense_ratio` | `(armor_reduction+bonus_defense) / 20` |
| 10 | `evasion_ratio` | evasion `/ 0.5` |
| 11 | `action_readiness` | action accumulator `/ 100` |
| 12 | `can_hit_self` | 현재 위치에서 후보가 self를 primary로 공격 가능하면 1 |
| 13 | `self_can_hit` | 현재 위치에서 self가 후보를 primary로 공격 가능하면 1 |
| 14 | `kills_ratio` | kills `/ 7` |
| 15 | `weapon_tactical_code` | unknown=0, sword=0.2, dagger=0.4, hammer=0.6, bow=0.8, spear=1.0 |

미배정 후보는 16개 모두 0이다. 배정됐지만 사망한 후보는 `available_alive=0`이며 마지막 authoritative state는 유지한다. mask는 `available_alive && reachable`일 때만 1이다.

### Arena/directional 138..172

| index | 이름 | 값 |
|---:|---|---|
| 138 | `arena.shrink_phase_ratio` | capability=false이면 0 |
| 139 | `arena.living_agent_ratio` | living agents `/ 8` |
| 140 | `arena.nearest_powerup_path_ratio` | capability=false 또는 없음이면 1 |
| 141 | `arena.safe_zone_path_ratio` | capability=false 또는 없음이면 1 |
| 142..165 | `direction[8].free_run/enemy_distance/enemy_present` | 방향별 3개, 아래 정의 |
| 166..169 | `move_mask.up/down/left/right` | terrain과 동적 점유 반영 binary |
| 170 | `arena.reachable_area_ratio` | self 도달 셀 `/ walkable cells` |
| 171 | `arena.walkable_area_ratio` | walkable cells `/ (width*height)` |
| 172 | `arena.dead_end` | 현재 유효 이동 방향이 1개 이하면 1 |

방향별 `free_run`은 해당 ray에서 첫 terrain/경계 전까지의 셀 수를 `max(width,height)`로 나눈다. `enemy_distance`는 해당 octant에서 가장 가까운 살아 있는 후보의 Manhattan 거리 `/ max_path`이며 없으면 1이다. `enemy_present`는 해당 octant에 살아 있는 후보가 있으면 1이다.

### Temporal/navigation 173..193

| index | 이름 | 값 |
|---:|---|---|
| 173 | `delta.hp_ratio` | `(HP-previousHP)/MaxHP` |
| 174 | `delta.score_ratio` | `(score-previousScore)/1000` |
| 175 | `delta.damage_dealt_ratio` | delta damage dealt `/ 1000` |
| 176 | `delta.damage_taken_ratio` | delta damage taken `/ 1000` |
| 177..187 | `previous_strategy[11]` | 직전 executed strategy one-hot; 없으면 전부 0 |
| 188 | `history.same_position_streak_ratio` | streak `/ 8` |
| 189 | `history.no_progress_ratio` | no-progress actions `/ 16` |
| 190 | `history.current_cell_visits_ratio` | visits `/ 8` |
| 191 | `history.two_cycle_ratio` | 2-cycle count `/ 4` |
| 192 | `history.three_cycle_ratio` | 3-cycle count `/ 4` |
| 193 | `history.target_persistence_ratio` | 같은 selected candidate 연속 action 수 `/ 8` |

history는 GC의 실제 `executed_action`, 실제 위치, 실제 primary target을 기준으로 갱신한다.

### Strategy feasibility 194..213

| index | 이름 | 값 |
|---:|---|---|
| 194..204 | `strategy_mask[11]` | 동결된 strategy label 순서의 binary mask |
| 205 | `aggregate.alive_candidate_ratio` | alive candidates `/ 7` |
| 206 | `aggregate.reachable_candidate_ratio` | reachable attack candidates `/ 7` |
| 207 | `aggregate.attackable_now_ratio` | 현재 self가 공격 가능한 후보 `/ 7` |
| 208 | `aggregate.current_threat_ratio` | 현재 self를 공격 가능한 후보 `/ 7` |
| 209 | `aggregate.min_attack_path_ratio` | reachable 후보 최소 BFS path `/ max_path`; 없으면 1 |
| 210 | `aggregate.best_finish_opportunity` | reachable 후보 중 `max(1-hp_ratio)`; 없으면 0 |
| 211 | `aggregate.max_immediate_threat_damage` | 현재 self를 공격 가능한 후보의 최대 평균 damage `/ self.MaxHP`; 없으면 0 |
| 212 | `aggregate.flee_safety_gain` | `(현재 threat 수-최적 reachable 셀 threat 수)/7`; 현재 셀도 후보에 포함 |
| 213 | `aggregate.explore_opportunity` | `1-min(reachable cell visit count,8)/8`; 현재 셀 외 도달 셀이 없으면 0 |

index 210..213은 성격 가중치를 사용하지 않는 authoritative aggregate다. GC와 AI Agent는 같은 raw-state fixture에서 exact 값과 tie-break를 검증한다.

## 5. 전략 mask

모델 입력과 서버 추론에는 정확히 11개의 binary mask를 사용한다.

- `hold`: 항상 1이며 선택 시 이동과 자동 공격을 모두 하지 않음
- `flee`: 생존 적이 있고 이동 가능한 안전 후보가 있을 때 1
- `seek_powerup`: capability와 활성·도달 가능한 powerup이 있을 때 1
- `explore`: 도달 가능한 저방문 셀이 있을 때 1
- `attack_candidate_n`: 후보가 생존하고 공격 가능 위치까지 경로가 있을 때 1

mask 적용 전 최대 logit은 `raw_argmax_strategy`, mask 적용 후 결과는 `model_strategy`로 분리한다. powerup capability가 false이면 `seek_powerup=0`이며 AI Agent teacher도 해당 label을 만들지 않는다. 모든 attack 후보가 mask 0이면 서버가 임의의 죽은 target을 선택해서는 안 된다.

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
BFS first step + dynamic collision check
        |
        v
executed_action + executed_target
```

전략별 goal resolver:

- `attack_candidate_n`: target을 primary로 공격할 수 있는 유효 셀 중 BFS path가 가장 짧은 셀
- `flee`: 모든 reachable 셀을 대상으로 `(threat 수 오름차순, 가장 가까운 적 거리 내림차순, visit 수 오름차순, BFS path 오름차순, BFS 발견 순서)` tuple 최소 셀
- `seek_powerup`: 활성 powerup 셀
- `explore`: 현재 셀 외 reachable 셀 중 `(visit 수 오름차순, 가장 가까운 적 거리 내림차순, BFS path 오름차순, BFS 발견 순서)` tuple 최소 셀
- `hold`: 현재 셀

GC는 한 번에 경로 전체를 예약하지 않고 매 action 시점에 한 칸만 실행한다. target·점유·위험이 바뀌면 다음 action에서 재탐색한다.

BFS neighbor 순서는 `up, down, left, right`로 고정한다. 동일 비용 목표 셀 tie-break도 이 순서와 candidate index 순서를 사용한다. target 무효화는 같은 action 재추론 사유가 아니며, 다음 action에서만 새 state로 ONNX를 다시 호출한다.

## 7. 학습 frame 계약 변경

기존 방향 action 필드와 전략 필드를 혼용하지 않는다.

```json
{
  "record_version": 2,
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

frame lifecycle:

1. action 시작 전 pre-state, history, vector, mask를 capture한다.
2. ONNX 전략과 selected target을 저장할 pending execution을 만든다.
3. move와 attack을 실행하고 실제 primary target과 override를 확정한다.
4. attack phase 종료 후 immutable frame을 단 한 번 append한다.
5. append 성공 후 authoritative 실행 결과로 history를 갱신한다.

process crash로 action이 완결되지 않으면 부분 frame을 만들거나 기존 frame을 UPDATE하지 않는다. 해당 training session은 재시작 시 `aborted` 처리한다. session manifest에는 agent별 `strategy_candidates`와 model/profile/loadout snapshot을 한 번만 기록한다.

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

revision 2 식별자:

- protocol: `1`
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
- Go API와 inference sidecar는 `(feature_version, schema_hash)` contract registry로 v8.0 192/5와 v8.1 214/11을 동시에 검증
- observe accepted versions는 `7.0,8.0,8.1`; v8.1 capability 확인 전 AI Agent는 upload·activation하지 않음
- sidecar는 mask 전 `raw_argmax_strategy`와 mask 후 `model_strategy`를 모두 반환
- v8.0 삭제는 known-good 8.1 지정 및 active/canary v8.0 pointer 0개 확인 후 수행

## 10. AI Agent와 GC 교차 검증 절차

양쪽이 독립적으로 구현한 뒤 마지막에 맞추는 방식을 금지한다. 다음 순서로 번갈아 검증한다.

### Round 1: AI Agent 초안

상태: **완료**

이 문서로 다음을 제안한다.

- 214 feature block
- stable candidate map
- 11 strategy labels/mask
- target 유지와 override 의미
- training frame 필드

산출물: 본 계획서와 GC 검토 질문.

### Round 2: GC 계약 검토

상태: **완료, GC `2aaaec25` 기준 조건부 합의**

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
| feature version | 8.1 | 8.1 | 합의 |
| input dimension | 214 | exact schema/fixture 통과 후 freeze | 조건부 합의 |
| output dimension | 11 | 11 | 합의 |
| strategy labels | hold/flee/seek_powerup/explore/attack_candidate_0..6 | 초안 순서 유지 | 합의 |
| candidate ordering | session 고정 slot 오름차순 | agent별 session-local, 자기 제외 | 합의 |
| path executor | GC 소유 | GC BFS, U/D/L/R | 합의 |
| attack target | model 선택 우선 | primary=model, deterministic fallback | 합의 |
| training frame | strategy/path/action/target 분리 | record v2, attack 후 append | 합의 |

### Round 3: AI Agent 계약 수정

상태: **본 revision 2로 완료**

GC 답변을 반영해 다음을 확정한다.

- schema ID와 정확한 214 index 표
- strategy label 순서
- teacher target utility와 mask parity
- CSV/manifest/model metadata
- Easy/Expert profile 필드 영향

### Round 4: GC fixture 선구현

상태: **완료, GC `5af6377f`**

GC가 source of truth로 제공한다.

- canonical schema JSON과 SHA-256
- raw state -> 214 vector fixture
- candidate map과 11 mask fixture
- strategy -> path step -> attack target fixture
- target 사망, unreachable, dynamic collision, flee, maze fixture
- hold 시 move/attack 없음 fixture
- ranged 최소거리, pierce 정렬·부가 hit, AOE primary·splash fixture
- 8.0/8.1 contract registry와 validator 격리 테스트

GC canonical schema raw-byte hash는 `sha256:330be3849f095e9ffca2c46bb4a13b2c9cbbc0c55aade67aa163e0307a1e1a82`로 동결했다. v8.1 실행 연결 시 AOE는 기존 v7/v8.0의 splash-first를 변경하지 않고 별도 v8.1 경로에서 primary-first로 실행한다.

### Round 5: AI Agent parity

상태: **완료**

AI Agent는 fixture를 그대로 읽어 다음을 검증한다.

- 214 vector/mask 완전 일치
- teacher strategy/target 기대값
- exporter와 trainer 11-class shape
- ONNX input/output와 metadata
- personality differentiation

검증 결과:

- GC schema와 fixture를 raw byte 그대로 동기화하고 SHA-256 일치
- 독립 JS builder의 214 vector 전체 `diffCount=0`
- candidate slots와 11 mask exact 일치
- mask와 vector index `194..204` parity 강제
- hunter는 동일 canonical state에서 `attack_candidate_0/slot 0`, survivor·navigator는 `explore` 선택
- record v2 parser, 214 feature exporter, 11-class strategy trainer 구현
- Node 전체 테스트 58개 통과
- Python model shape `214 -> 11`, manifest·dataset parser 검증 통과

### Round 6: 테스트 서버 E2E

상태: **GC 관리자 모델 전환 경로 보강 대기**

GC `20d9aa5a` 완료 항목:

- agent별 v8.1 214/11 전략 runtime과 GC BFS 실행 연결
- move와 attack을 하나의 strategy execution으로 유지하고 attack 완료 후 record v2 frame을 한 번만 append
- accepted feature versions에 `8.1` 추가 및 `strategy_v8_1` capability 광고
- v8.1 전용 AOE primary-first 실행 경로 연결
- 기존 v7/v8.0 runtime, record v1 feed, AOE 순서 유지

남은 선행조건:

- 관리자 canary/activate/rollback의 모델 계약 검사를 `featurecontract` registry 기반으로 변경
- v8.0 `192/5`와 v8.1 `214/11` revision 전환을 각각 허용하고 교차 계약은 거부하는 회귀 테스트 추가
- 가능하면 실제 PostgreSQL에서 v8.1 battle → record v2 → result lifecycle 통합 테스트 추가
- AI Agent는 feature 8.1에서 `capabilities.strategy_v8_1=true`가 아니면 observe 모드에서도 fail-closed

현재 `admin_model_v8.go`의 전환 검사가 `featurev8.Version`/`featurev8.Hash()`만 비교하므로 v8.1 revision은 upload 후 canary 지정 단계에서 `MODEL_CONTRACT_MISMATCH`로 거부된다. 이 누락이 수정되고 회귀 테스트가 통과하기 전에는 테스트 서버 배포, model upload, canary 지정을 수행하지 않는다.

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

상태: **미착수**

- canary 품질 게이트 승인
- known-good 8.1 revision 지정
- v8.1 agent 범위 확대
- 구 v8.0 test revision 폐기
- 마지막에 strict 최소 버전 전환

## 11. 품질 게이트

필수 gate:

- invalid strategy rate = 0
- masked strategy execution rate = 0
- selected target mismatch rate = 0; 분모는 override 없는 attack 실행 건
- target override reason 누락 = 0
- unreachable target loop rate < 1%; 분모는 attack strategy 선택 건
- 2-cycle/3-cycle rate는 canary에서 v7 baseline을 먼저 산출한 뒤 threshold 동결
- deterministic maze 해결률 = 100%
- 동일 상태 personality strategy 차별성 fixture 통과
- 공격 가능한 다수 target fixture에서 profile별 기대 target 일치
- inference timeout/failure 시 게임 정상 진행률 = 100%

baseline이 없는 `2-cycle/3-cycle < v7` 조건은 현재 release blocker로 사용하지 않는다. 성능 gate는 canary 데이터 분포와 v7 baseline을 확인한 뒤 절대값을 동결한다.

## 12. 작업 순서

Round 5까지 완료했고 GC `20d9aa5a`에서 v8.1 runtime 및 record v2 생성 경로가 연결됐다. 현재는 관리자 model rollout 경로가 v8.1 contract registry를 사용하도록 보강되는 것을 기다린다.

1. GC 계약 검토 및 수정안 회신: 완료
2. AI Agent 계획서 revision 2 확정: 완료
3. GC schema/fixture/path executor 격리 구현: 완료
4. AI Agent teacher/export/trainer 및 양쪽 fixture parity: 완료 (`25858b3`)
5. GC v8.1 runtime·record v2·8.1 capability·AOE primary-first 경로 연결: 완료 (`20d9aa5a`)
6. GC 관리자 canary/activate/rollback의 8.0/8.1 registry 전환 및 회귀 테스트: 진행 필요
7. 격리 test server model upload/canary E2E
8. 문서·CLI guide·operation guide 최종 동기화
9. canary 품질 게이트 승인 후 npm 배포 및 관리 agent 순차 업데이트
10. known-good v8.1 확보 후 별도 승인으로 운영 확대·strict 검토

## 13. 남은 확인 항목

- Round 6에서 record v2 실제 frame이 AI Agent parser/exporter와 일치하는지
- 선택 target과 실제 primary target, 정상 중간 이동과 override 구분이 실게임에서도 일치하는지
- v8.1 AOE primary-first 실행 fixture와 실게임 event 순서 일치
- v7 baseline과 v8.1 canary 품질 지표 산출
- v8.0 test 데이터·revision 폐기 시점은 Round 7에서 운영 pointer 확인 후 결정
