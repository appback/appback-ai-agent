# AI Agent 고도화 계획

현재 ClawClash 게임 규칙과 5방향 이동 출력은 유지하면서, 미로·장애물 대응과 관리자별 학습 성향 설정을 가능하게 만드는 설계다.

이 문서는 `appback-ai-agent`의 데이터 수집·학습·모델 업로드와 Grid Clash Go 서버의 feature 생성·모델 추론 사이의 공동 계약을 정의한다.

운영 wire contract는 `GC_TRAINING_DATA_INTEGRATION.md`를 기준으로 한다.

실행 계획은 다음 두 문서로 분리한다.

- AI Agent: `docs/design/AI_AGENT_DEVELOPMENT_PLAN.md`
- GC: `claw-clash/docs/design/GC_AI_DEVELOPMENT_PLAN.md`

---

## 1. 결론

우선순위는 모델 크기 확대나 온라인 강화학습이 아니다.

1. 기존 데이터와 의미가 달라진 feature를 새 버전으로 격리한다.
2. 미로의 정답 행동을 BFS 기반 교사(oracle)가 생성하도록 한다.
3. 최근 이동 이력과 반복 방문 정보를 feature에 추가한다.
4. 관리자가 선택한 학습 프로필이 목표 선택·라벨·보상에 실제로 반영되게 한다.
5. 고정 미로 평가를 통과한 모델만 업로드한다.

단기에는 현재 서버 계약인 `stay/up/down/left/right` 5클래스를 유지한다. 중기에는 모델이 이동 방향이 아니라 목표를 선택하고, 서버의 경로 실행기가 목표까지 이동하는 계층형 구조로 전환한다.

---

## 2. 현재 구조 진단

### 2.1 현재 학습은 강화학습이 아니다

현재 `train_gc_model.py`는 모델 또는 휴리스틱이 선택한 행동을 라벨로 사용하는 지도학습이다.

- 입력: 단일 틱의 153차원 feature
- 출력: 5방향 분류
- 손실: 가중치가 적용된 cross entropy
- 보상: 정책을 탐색하는 reward가 아니라 각 분류 샘플의 loss 가중치
- 라벨 보정: 공격 가능한 위치에서 `stay`, 이동 후 공격 가능 방향, 인접 파워업 정도만 보정

따라서 기존 휴리스틱이나 모델이 미로에서 잘못 이동했다면, 게임 수가 늘어날수록 그 행동을 더 많이 모방할 수 있다. 승리 보상을 크게 주더라도 학습 데이터에 올바른 우회 행동이 라벨로 존재하지 않으면 미로 탈출 규칙을 발견하지 못한다.

### 2.2 모델은 이동 이력을 모른다

현재 MLP는 각 틱을 독립적으로 판단한다. 다음 상태가 구분되지 않는다.

- 처음 방문한 위치와 여러 번 방문한 위치
- 정상적인 방향 전환과 두 칸 왕복
- 목표에 가까워지는 이동과 제자리 순환
- 일시적으로 멈춘 상태와 장시간 경로를 찾지 못한 상태

### 2.3 feature 의미 변경을 같은 버전으로 처리하면 안 된다

현재 작업 중인 8방향 요약은 단순 ray 거리에서 BFS 경로 거리·첫 이동 방향을 반영하는 형태로 변경됐다. 차원이 153으로 같더라도 feature 의미가 바뀌었으므로 기존 `v7.0` 모델 및 데이터와 호환되지 않는다.

이를 그대로 혼합하면 같은 index가 서로 다른 의미를 갖는 데이터가 한 학습셋에 들어간다. path-aware feature는 반드시 새로운 `feature_version`으로 분리해야 한다.

### 2.4 데이터 저장 범위가 재학습에 부족하다

현재 CSV는 계산이 끝난 feature와 선택 행동을 중심으로 저장한다. 새 feature나 새 프로필로 과거 데이터를 다시 계산하려면 다음 원본 상태가 함께 보존돼야 한다.

- 자기 및 상대의 장비·전투 상태
- 전체 terrain 또는 terrain version
- powerup 위치와 종류
- shrink 상태와 안전 영역
- 틱 이벤트와 이전 행동
- 수집 당시 feature/profile/training 버전

---

## 3. 목표와 비목표

### 목표

- 단순 미로와 장애물 맵에서 반복 이동 없이 목표에 도달한다.
- 관리자가 같은 게임 데이터로도 서로 다른 성향의 모델을 만들 수 있다.
- 학습 feature와 서버 추론 feature가 항상 동일하다.
- 잘못된 자동학습 모델이 즉시 운영에 반영되지 않도록 품질 게이트를 둔다.
- 기존 8인 매칭, 장비 선택, 베팅, 자동 전투 흐름을 유지한다.

### 이번 단계의 비목표

- PPO 같은 온라인 강화학습을 즉시 도입하지 않는다.
- 게임의 승패 규칙이나 기본 전투 루프를 변경하지 않는다.
- 관리자에게 epoch, learning rate 같은 저수준 파라미터를 우선 노출하지 않는다.
- 모델이 BFS 자체를 암기하도록 만들지 않는다. BFS는 정답 생성 및 안전장치에 사용한다.

---

## 4. 목표 아키텍처

### 4.1 1단계: 현재 5방향 모델 개선

```text
GC Go authoritative training frame
        |
        v
공통 feature 계약 v8 + 최근 이동 이력
        |
        +--> BFS 교사: 목표 선정 + 정답 첫 이동 생성
        |
        v
프로필별 라벨/가중치 생성
        |
        v
5클래스 ONNX 학습
        |
        v
오프라인 미로 평가 + 품질 게이트
        |
        v
서버 업로드 및 canary 적용
```

모델 출력은 계속 `[stay, up, down, left, right]`를 사용한다. 기존 모델 업로드 API와 배틀 엔진 변경을 최소화하면서 미로 대응을 먼저 검증하는 단계다.

### 4.2 2단계: 목표 선택과 경로 실행 분리

```text
전략 모델
  -> 공격 대상 / 파워업 / 안전 위치 / 탐색 지점 선택
  -> 위험 허용 수준과 추격 지속 여부 결정

서버 경로 실행기
  -> BFS/A* 경로 계산
  -> 동적 장애물 반영
  -> 첫 이동 실행
  -> 반복 이동 감지 시 재탐색
```

미로 탈출은 결정론적 경로 탐색이 더 정확하고 검증하기 쉽다. 모델은 상황에 따라 어디로 갈지 결정하고, 서버는 그 목표까지 어떻게 갈지 책임지는 구조가 장기 목표다.

---

## 5. 데이터 계약 v8 초안

### 5.1 원칙

- 서버는 실제 추론에 사용한 feature vector/action mask와 동일 시점의 authoritative raw state를 함께 전달한다.
- `ai-agent`와 GC Go 서버는 같은 feature 명세와 정규화 규칙을 사용한다.
- 차원뿐 아니라 각 index의 의미가 바뀌면 feature version을 올린다.
- 운영 학습 입력은 GC vector를 사용하며 AI Agent의 재생성 vector는 parity/synthetic 용도로만 사용한다.
- 데이터 파일, SQLite row, ONNX metadata, 서버 모델 row에 feature version을 기록한다.
- 서로 다른 feature version의 학습 데이터를 절대 자동 병합하지 않는다.

### 5.2 원본 tick 필수 항목

| 그룹 | 필드 |
|---|---|
| 공통 | game_id, tick, phase, map_id, terrain_version |
| 자기 | slot, x/y, hp/max_hp, score, kills, damage_dealt/taken, action_acc, idle_ticks |
| 자기 장비 | weapon slug/damage/range/range_type/cooldown/speed, armor slug/reduction/evasion |
| 상대 | 생존 여부와 자기 항목에 대응하는 공개 상태 |
| 맵 | width/height, terrain 또는 terrain_version으로 조회 가능한 고정 맵 |
| 오브젝트 | powerup 위치·종류·활성 여부 |
| 환경 | shrink phase, 안전 영역, 남은 틱 |
| 이벤트 | 공격, 피격, 처치, 획득, 이동 실패, 제거 |

게임에 실제 `energy`가 없다면 별도 energy를 만들지 않고 `action_acc`, 공격 cooldown, 행동 가능 여부를 사용한다.

### 5.3 파생 feature v8 제안

목표 차원은 192로 잡고 구현 시 canonical fixture로 최종 동결한다.

| 블록 | 차원 | 내용 |
|---|---:|---|
| 기존 전투 상태 | 153 | v7 전투·상대·맵·행동 가능 정보. 변경된 index 의미는 v8로 재정의 |
| 시간 변화 | 12 | HP/점수/피해 변화, 이전 행동 one-hot, 반복 위치, 무진행 틱, 방문 횟수 |
| 경로·목표 | 16 | 목표 종류, BFS 첫 방향, 경로 길이, 거리 변화, 막다른 길, 도달 가능 영역, 인접 칸 방문도 |
| 방향별 위협 | 11 | 4방향 예상 피격 위험, 4방향 탈출 안전도, 자기/대상 행동 준비도, 대상 방어력 |
| 합계 | 192 | 고정 차원 |

`v8.0`의 정확한 index 표는 구현 전에 별도 상수 파일과 테스트 fixture로 확정한다. `ai-agent`와 `cc-api`가 독립적으로 숫자를 하드코딩하는 방식은 사용하지 않는다.

### 5.4 이동 이력 상태

각 에이전트별로 최근 8~16틱의 최소 상태를 유지한다.

- 최근 위치 ring buffer
- 최근 행동 ring buffer
- 같은 위치 방문 횟수
- 목표까지의 이전 경로 거리
- 마지막으로 경로가 짧아진 tick
- 2-cycle 및 3-cycle 반복 여부

게임 종료, 취소, 재연결 시 이력은 반드시 초기화한다.

---

## 6. BFS 교사 라벨

### 6.1 목표 선정 순서

교사는 현재 상태와 학습 프로필을 이용해 먼저 목표를 고른다.

1. 축소 영역 또는 즉시 사망 위험이면 안전 위치
2. 안전하게 공격 가능하면 현재 위치 유지
3. 프로필이 선택한 우선순위에 따라 적, 파워업, 안전 지점, 미방문 지점 선택
4. 목표까지 BFS 경로의 첫 방향을 정답 라벨로 사용
5. 경로가 없거나 동적 점유로 막히면 대체 목표를 선택
6. 반복 이동이 감지되면 최근 방문도가 낮은 경로에 우선권 부여

### 6.2 라벨과 가중치 분리

- `teacher_action`: 교사가 계산한 정답 방향
- `observed_action`: 실제 모델 또는 휴리스틱이 선택한 방향
- `executed_action`: 서버에서 실제 적용된 방향
- `sample_weight`: 프로필과 결과로 계산한 학습 중요도

기본 학습 라벨은 `teacher_action`을 사용한다. `observed_action`은 행동 분석과 교사 대비 정확도 측정에 사용하며, 그대로 정답으로 사용하지 않는다.

### 6.3 미로 학습용 시나리오 생성

운영 게임만 기다리지 않고 고정 맵에서 교사 데이터를 생성한다.

- 직선 복도
- L/U자 우회
- 막다른 길 탈출
- 고리형 통로
- 중앙 장애물 우회
- 여러 경로 중 최단 경로 선택
- 이동하는 상대가 길을 일시적으로 막는 경우
- 파워업과 적의 목표가 서로 다른 방향인 경우

---

## 7. 관리자 학습 프로필

### 7.1 제공 방식

초기에는 에이전트별 프로필 하나를 선택하고 해당 프로필 전용 모델을 생성한다.

```bash
appback-ai-agent profile list
appback-ai-agent profile show
appback-ai-agent profile set navigator
appback-ai-agent profile set custom --config ./training-profile.json
```

CLI는 신규 기능이며 구현 후 제공한다. `.env`에는 선택된 프로필 ID만 저장하고, 상세 설정은 versioned JSON으로 관리한다.

### 7.2 기본 프로필

| 프로필 | 중점 | 예상 행동 |
|---|---|---|
| balanced | 승리·생존·공격 균형 | 상황에 따라 목표 변경 |
| hunter | 킬·추격·피해량 | 약한 적을 긴 거리까지 추적 |
| survivor | 생존·안전 지역·피해 회피 | 불리한 교전을 피하고 후반 진입 |
| collector | 파워업·장비 이점 | 전투 전 자원 확보 우선 |
| navigator | 경로 효율·반복 방지 | 미로와 장애물에서 빠른 목표 도달 |

### 7.3 설정 예시

```json
{
  "schema_version": 1,
  "profile_id": "navigator",
  "objective_weights": {
    "win": 1.0,
    "top3": 0.5,
    "kills": 0.3,
    "damage": 0.3,
    "survival": 0.8,
    "powerup": 0.4,
    "path_progress": 1.5,
    "exploration": 1.0,
    "anti_stuck": 2.0
  },
  "policy": {
    "flee_hp_ratio": 0.3,
    "max_chase_path": 8,
    "replan_after_no_progress_ticks": 3,
    "target_priority": "reachable_nearest"
  }
}
```

가중치는 허용 범위 내에서 정규화하고, schema validation 실패 시 학습을 시작하지 않는다. 프로필 ID와 설정 hash는 ONNX metadata 및 업로드 이력에 기록한다.

### 7.4 프로필이 실제 행동을 바꾸는 위치

프로필은 단순히 최종 reward 배수만 바꾸지 않는다.

- 교사가 어떤 목표를 선택하는지
- 여러 정답 경로 중 어느 경로를 선호하는지
- 어떤 샘플을 더 강하게 학습하는지
- 도주·추격·재탐색 임계값을 어떻게 적용하는지
- 게임 참가 전에 어떤 무기·방어구 조합을 선택하는지

같은 상태에서 모든 프로필의 라벨이 같고 reward만 다르면 행동 차이가 제한적이다. 목표 선정과 교사 라벨 단계부터 프로필을 적용해야 한다.

### 7.5 성격 기반 무기·방어구 선택

성격은 특정 장비 이름을 고정하지 않고 GC 카탈로그의 평균 피해량, 사거리, 합산 속도, 방어, 회피, 스킬 기대값을 정규화해 선호도를 계산한다. 이후 같은 operation/profile에서 기록한 평균 순위와 덜 사용한 조합을 탐색하는 UCB 값을 결합한다.

- hunter: 피해량과 공격 스킬 우선
- survivor: 방어, 회피, 사거리 우선
- collector: 속도와 회피 우선
- navigator: 속도와 사거리 우선
- balanced: 모든 특성을 균형 있게 평가

장비 성과는 `operation_version + behavior_profile_hash`로 격리한다. 성격 변경 직후에는 새 성격의 선호도를 prior로 사용하고, 게임 결과가 쌓이면 해당 성격의 실제 성과가 선택에 반영된다. 이 로직은 AI Agent가 challenge 전에 실행하며 GC 서버의 이동 추론이나 v8 192차원 계약을 변경하지 않는다.

---

## 8. 평가와 모델 품질 게이트

### 8.1 오프라인 내비게이션 지표

- `goal_reach_rate`: 제한 틱 내 목표 도달 비율
- `path_efficiency`: 실제 이동 수 / BFS 최단 이동 수
- `loop_rate`: 2-cycle 또는 3-cycle에 진입한 시나리오 비율
- `invalid_action_rate`: 이동 불가능 방향 선택 비율
- `no_progress_rate`: 일정 틱 동안 목표 거리가 줄지 않은 비율

1차 통과 기준:

- 고정 미로 200개 seed에서 목표 도달률 95% 이상
- path efficiency 평균 1.25 이하
- loop rate 2% 이하
- invalid action rate 0%

구현 상태:

- `gc-maze-v1` evaluator와 `evaluate maze` CLI 구현 완료
- 15x15 perfect maze를 seed 기반으로 생성해 모든 시나리오가 재현 가능하고 도달 가능하도록 보장
- navigator BFS teacher 기준 200개 시나리오에서 도달률 100%, path efficiency 1.000, loop/invalid/no-progress 0% 확인
- 현재 report의 policy는 `bfs_teacher`이며 ONNX 모델 품질 게이트는 후속 연결

### 8.2 전투 지표

- win rate, top3, avg rank
- damage dealt/taken 비율
- kills 및 생존 ticks
- 안전 영역 이탈 사망률
- 공격 가능 상태에서 불필요하게 이탈한 비율

기존 운영 모델 대비 top3가 3%p 이상 하락하면 자동 업로드하지 않는다. 표본이 적으면 판단을 보류하고 canary 게임 수를 늘린다.

### 8.3 프로필 차별성 지표

- hunter: 추격 비율, 적과의 평균 경로 거리, 킬 시도
- survivor: 위험 방향 진입률, 평균 생존 ticks, 불리한 교전 회피율
- collector: 파워업 획득률과 획득 전 전투 회피율
- navigator: 경로 효율, 재방문율, loop rate
- 전체 프로필: 장비 조합 분포, 선호 장비 선택률, 조합별 평균 순위

프로필 간 핵심 지표 차이가 사전에 정한 최소값보다 작으면 서로 다른 모델로 인정하지 않는다.

구현 상태:

- `gc-personality-v1` evaluator와 `evaluate personality` CLI 구현 완료
- low HP 적 조우, 적·powerup 선택, 일반 추격, 방문 이력 분기 fixture를 고정
- hunter 추격과 survivor 도주, hunter 적 우선과 collector powerup 우선 gate 통과
- 5개 Easy profile에서 3개 고유 decision signature 확인
- 현재 결과는 teacher label 차별성 기준이며 운영 replay와 ONNX 모델 차별성 평가는 후속 연결

### 8.4 업로드 정책

```text
학습 완료
  -> feature/profile metadata 검증
  -> ONNX shape 검증
  -> canonical feature parity 검증
  -> 미로 평가
  -> 전투 replay 평가
  -> canary 적용
  -> 기준 통과 시 정식 적용
  -> 실패 시 이전 모델 유지
```

현재의 `50게임 -> 즉시 업로드` 흐름은 `50게임 -> 학습 -> 평가 -> 조건부 업로드`로 변경한다.

---

## 9. 단계별 구현 계획

### Phase 0. 계약 동결 및 데이터 격리

- path-aware feature를 `v8.0`으로 버전 변경
- 기존 v7 데이터와 v8 데이터를 디렉터리·metadata 기준으로 분리
- `feature_version`, `feature_dim`, `schema_hash` 검증 추가
- ai-agent와 cc-api canonical fixture 비교 테스트 작성

완료 기준: 동일 fixture에서 전체 feature와 action mask의 차이가 0이고, v7 데이터가 v8 학습에 포함되지 않는다.

### Phase 1. 원본 데이터와 평가기 구축

- tick 원본 상태 저장 범위 확장
- 이동 이력 수집
- terrain/version 저장
- 고정 미로 시나리오 및 BFS 기준 경로 생성
- 내비게이션 지표 계산기 구현

완료 기준: 모델 없이도 교사가 모든 고정 미로의 기준 행동과 최단 경로를 생성한다.

### Phase 2. 관리자 프로필과 교사 라벨

- 프로필 JSON schema와 preset 정의
- CLI `profile list/show/set` 구현
- 프로필별 목표 선택기 구현
- `teacher_action`, `observed_action`, `executed_action` 분리 저장
- 프로필별 샘플 통계 출력

완료 기준: 같은 fixture에서 hunter/survivor/navigator가 의도된 서로 다른 목표와 라벨을 선택한다.

### Phase 3. v8 모델 학습

- 192차원 feature index 확정
- v8 모델과 metadata export
- 세션 단위 train/validation 분할로 데이터 누수 방지
- 클래스 불균형 및 profile 가중치 적용
- 미로/전투 평가 결과를 학습 산출물에 포함

완료 기준: navigator 모델이 오프라인 내비게이션 통과 기준을 만족한다.

### Phase 4. 서버 안전장치와 조건부 배포

- cc-api에 반복 이동 감지와 재탐색 safety layer 추가
- 모델 validator에 feature/profile/schema 검사 추가
- 품질 게이트 실패 시 업로드 중단
- 이전 모델 보존 및 자동 rollback 구현
- 일부 agent에 canary 적용

완료 기준: canary에서 미로 loop가 재현되지 않고 전투 성능 회귀 기준을 넘지 않는다.

### Phase 5. 계층형 정책 검토

- 모델 출력 후보를 목표 유형 및 target slot으로 확장
- 서버 경로 실행기와 동적 재탐색 구현
- 기존 5방향 모델과 A/B 비교
- 충분한 시뮬레이터가 준비된 뒤 offline RL/PPO 도입 여부 결정

---

## 10. 저장소별 작업 범위

### appback-ai-agent

- `GcFeatureBuilder`: v8 feature 및 이동 이력 입력
- `GcAdapter`: 원본 tick, 세 가지 action, profile ID 수집
- `TrainingExporter`: feature version/profile별 데이터 분리
- `train_gc_model.py`: BFS 교사 라벨 및 프로필 가중치
- CLI: profile 관리와 평가 명령
- ONNX metadata: feature/profile/schema/evaluation 결과
- 자동학습: 품질 게이트 통과 시에만 업로드

### cc-api

- 서버 featureBuilder v8 구현
- canonical fixture parity test
- 배틀별 이동 이력 또는 safety layer
- v8 모델 validator 및 metadata 검증
- canary/rollback을 위한 모델 버전 보존
- 2단계에서 목표 기반 추론 및 서버 경로 실행기

두 저장소 작업은 feature 계약 확정 이후 같은 배포 단위로 관리해야 한다. 한쪽만 먼저 운영에 반영하면 학습과 추론 입력이 다시 어긋난다.

---

## 11. 주요 위험과 대응

| 위험 | 대응 |
|---|---|
| 같은 차원이라 구버전 모델이 잘못 로드됨 | 차원 외에 feature version과 schema hash 검증 |
| 운영 데이터가 기존 모델 행동에 편향됨 | BFS 교사 데이터와 고정 시나리오를 별도 생성 |
| 프로필이 이름만 다르고 행동은 같음 | 목표 선정·라벨 단계에 프로필 적용, 차별성 지표 검증 |
| 미로 개선 후 전투 성능 하락 | 내비게이션과 전투 평가를 모두 업로드 게이트에 포함 |
| 동적 상대 때문에 BFS 경로가 자주 막힘 | 일시 점유와 고정 terrain 분리, 짧은 주기로 재탐색 |
| 자동학습이 나쁜 모델을 즉시 배포함 | canary, 이전 모델 보존, 자동 rollback |

---

## 12. 최종 완료 조건

- 현재 게임 흐름과 5방향 서버 추론이 정상 유지된다.
- v7/v8 데이터와 모델이 명확하게 격리된다.
- ai-agent와 cc-api feature parity가 자동 테스트된다.
- 관리자가 preset 또는 custom 프로필을 설정할 수 있다.
- 같은 상태에서 프로필에 따라 목표와 행동이 실제로 달라진다.
- 고정 미로 목표 도달률 95% 이상, loop rate 2% 이하를 만족한다.
- 품질 게이트를 통과하지 못한 모델은 운영 서버에 적용되지 않는다.
- 배포 후 문제가 발생하면 이전 모델로 자동 복구된다.
