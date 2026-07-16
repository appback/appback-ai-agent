# GC 요청: 계층형 전략 v8.1 계약 검토

AI Agent가 작성한 `docs/design/GC_AI_STRATEGY_V8_PLAN.md`를 GC 현재 코드와 대조해 검토해 주세요.

이번 검토는 구현 요청이 아닙니다. 먼저 계약을 확정해야 하며, 합의 전에는 기존 192차원/5방향 v8.0 모델을 생성하거나 canary로 지정하지 않습니다.

## 제안 요약

- 기존 실험 계약: `8.0 / 192 input / 5 direction output`
- 신규 초안: `8.1 / 214 input / 11 strategy output`
- 모델: 공격 후보, 도주, 파워업, 탐색, 유지 중 전략 선택
- GC: 선택 목표의 경로 계산, 동적 재탐색, 실제 이동·공격 수행
- 후보: 자기 제외 최대 7명을 battle session 동안 stable index로 유지
- 공격 선택: `attack_candidate_0..6`
- 비공격 선택: `hold`, `flee`, `seek_powerup`, `explore`

## 반드시 코드로 확인할 항목

### 1. Candidate lifecycle

- battle 시작 roster로 candidate map을 고정할 수 있는지
- slot 오름차순 고정이 현재 game/session 구조와 안전하게 결합되는지
- 사망한 후보를 제거하지 않고 `alive=0`으로 유지할 수 있는지
- session manifest에 candidate-to-slot map을 저장할 수 있는지

### 2. Move와 attack 연결

- move phase에서 선택한 target을 attack phase까지 전달할 수 있는지
- 현재 `bestAttackTarget` 호출을 선택 target 우선으로 변경할 수 있는지
- 선택 target 사망·이탈·도달 불가 시 override를 원자적으로 기록할 수 있는지
- action order 중 선행 agent 행동으로 target 상태가 바뀌는 경우 처리 방식

### 3. 무기 규칙

- adjacent/ranged/pierce별 공격 가능 목표 셀 계산
- ranged 최소 거리 유지
- pierce primary target과 추가 hit target 구분
- AOE primary target과 splash target 구분
- 선택 target이 사거리 안일 때 불필요한 이동 방지

### 4. Path executor

- BFS와 A* 중 현재 8x8 맵에 적합한 구현
- 살아 있는 agent를 동적 장애물로 반영
- 매 action마다 한 칸 실행하고 다음 action에 재탐색
- flee/explore/powerup goal resolver 구현 가능 여부
- 2-cycle/3-cycle과 no-progress safety의 적용 위치

### 5. 214 feature

제안 block:

- self/game/loadout 26
- enemy candidates 112: 7 x 16
- arena/directional 35
- temporal/navigation 21
- strategy feasibility 20

각 feature가 authoritative state에서 생성 가능한지 확인해 주세요. 없는 powerup/shrink 값을 추측해서 채우지 말고 capability와 mask로 비활성화해야 합니다.

후보별 제안 feature:

- present_alive
- hp_ratio
- dx/dy
- manhattan distance
- BFS attack path
- reachable
- damage/range/defense/evasion
- action readiness
- can_hit_self/self_can_hit
- kills
- weapon tactical code

추가·삭제·정규화 변경이 필요하면 정확한 이유와 대체 block 차원을 제안해 주세요.

### 6. 11 strategy mask

- `hold`: 항상 허용 가능한지
- `flee`: 안전 goal이 없을 때 mask 기준
- `seek_powerup`: 현재 capability false 처리
- `explore`: 유효 미방문 goal 판정 기준
- `attack_candidate_n`: alive/reachable 기준
- 모든 후보가 무효일 때 deterministic fallback

### 7. Training contract

다음 필드를 session/frame/result 저장 구조에 수용할 수 있는지 확인해 주세요.

- strategy candidate map
- raw_argmax_strategy
- model_strategy
- executed_strategy
- selected_target_slot
- executed_target_slot
- path_action
- executed_action
- strategy_override_reason
- movement_override_reason

기존 `model_action/executed_action`과 의미가 충돌하지 않도록 migration 방안을 제안해 주세요.

### 8. Model contract

- 214 input, 11 output validator
- immutable label 순서
- `gc_strategy_net` 모델 경로
- metadata의 feature/schema/training/operation version
- v8.0 192/5 revision과 v8.1 214/11 revision 격리
- canary/activate/rollback API 재사용 가능 여부

### 9. 호환성과 전환

- v7 운영을 유지한 채 v8.1 canary만 선택적으로 적용 가능한지
- `/agent-contract`의 accepted version과 capability 확장안
- protocol version 1 유지 가능 여부
- test server migration과 기존 v8.0 test 데이터 처리

## 요청 답변 형식

각 항목을 아래 형식으로 답해 주세요.

```text
[항목]
판정: ACCEPT | CHANGE | REJECT
코드 근거: 파일:라인
이유:
수정 제안:
AI Agent 영향:
GC 영향:
```

마지막에는 반드시 다음 표를 포함해 주세요.

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

## 검토 완료 조건

- 모호한 동의가 아니라 코드 근거가 있는 항목별 판정
- 수정 제안에 exact dimension/label/field 의미 포함
- AI Agent가 계획서 revision 2를 작성할 수 있을 정도의 구체성
- 구현·배포는 아직 수행하지 않음
