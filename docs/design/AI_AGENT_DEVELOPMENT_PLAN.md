# AI Agent 개발계획

관리자가 AI Agent에 성격을 부여하고, 선택한 성격에 따라 데이터 라벨·학습 가중치·최종 모델 행동이 달라지게 만드는 실행 계획이다.

상위 방향은 `AI_AGENT_ADVANCEMENT_PLAN.md`를 따르며, 이 문서는 `appback-ai-agent` 저장소가 구현할 범위와 CLI 사용 계약을 정의한다.

## 구현 상태

- v8.1 계층형 전략 계약 및 Round 6 격리 E2E 완료: 214차원/11전략 모델, GC BFS 실행기, record v2, cursor consumer 연동을 검증했다. 기준 문서: `GC_AI_STRATEGY_V8_PLAN.md`

- AA-1 완료: Easy/Expert 설정, variation/seed, 장비 선호, 검증, revision/history/rollback, CLI, doctor 확인, 운영 가이드
- AA-2 완료: GC authoritative frame consumer, BFS 교사 라벨, 성격별 sample weight, 192차원 export와 Python 학습 입력 분리
- AA-3 완료: 200개 deterministic maze, BFS teacher 평가, canonical 전투 fixture 성격 차별성 평가, JSON report와 CLI 품질 게이트
- v8.1 정식 자동학습 경로 완료: 네 Easy 프리셋 bootstrap, 50게임 same-profile 학습·upload, GC 30게임 runtime gate와 자동 active 전환
- 기존 v8.0 ONNX 생성·upload·canary는 운영 학습 경로에서 제외한다.
- 현재 성격 변경은 기존 운영 모델을 즉시 변경하지 않는다.
- 운영 버전 관리 완료: operation/feature/training/profile 계약별 DB·export·모델 경로 격리, CLI 전환 차단
- GC-1 연동 완료: v7 동작을 유지한 protocol/agent-version bridge header, agent-contract preflight, strict 조기 차단
- GC training data 계약 확정: authoritative vector + raw pre-state, cursor API, teacher/model/executed action 분리
- consumer runtime 구현 완료: v8 operation 전용 scheduler, frame/result/session validator, SQLite 멱등 저장, operation별 cursor checkpoint
- GC loadout profile 계약 완료: 서버 migration/API/queue/session/result/capability와 AI Agent capability 기반 challenge 전송 구현. capability는 지원 여부만 나타내며 필수화는 별도 전환

---

## 1. 제품 목표

핵심 기능은 "모델을 자주 학습한다"가 아니라 "관리자가 원하는 성격으로 학습시킨다"이다.

- Easy 모드: 준비된 성격 중 하나를 선택한다.
- Easy 모드에는 제한된 무작위 변형을 적용해 같은 성격의 에이전트도 조금씩 다르게 만든다.
- Expert 모드: 관리자가 목표 가중치와 행동 임계값을 직접 설정한다.
- 성격은 전투 중 이동뿐 아니라 게임 참가 전 무기·방어구 선택에도 적용한다.
- 모든 설정은 CLI에서 조회·변경·검증·내보내기할 수 있다.
- 설정 변경만으로 운영 모델을 즉시 교체하지 않는다. 새 설정으로 학습하고 품질 게이트를 통과한 모델만 적용한다.
- 장비 선택은 모델 교체 없이 재시작 후 다음 challenge부터 새 성격을 적용한다.
- 현재 게임 참가, 데이터 수집, 50게임 자동학습, ONNX 업로드 흐름을 확장한다.

---

## 2. 책임 범위

### AI Agent가 담당한다

- 관리자 성격 설정 저장과 CLI 제공
- 성격별 무기·방어구 선호와 과거 성과를 결합한 장비 선택
- Easy 프리셋을 실제 학습 파라미터로 컴파일
- 원본 게임 데이터와 이동 이력 수집
- 성격별 목표 선정과 BFS 교사 라벨 생성
- 성격별 reward/sample weight 계산
- ONNX 학습, 평가, metadata 생성
- 평가를 통과한 모델만 GC에 업로드
- 현재 설정과 운영 중인 모델 성격의 차이 표시

### AI Agent가 담당하지 않는다

- 운영 배틀에서 실제 이동 실행
- 서버의 action mask와 충돌 판정
- terrain의 authoritative 판정
- 업로드된 모델의 최종 로드와 추론
- 운영 모델 rollback의 서버 저장

이 항목은 GC 서버 개발계획에서 담당한다.

---

## 3. 성격 아키텍처

```text
관리자 CLI
   |
   +-- Easy: preset + variation + seed
   |
   +-- Expert: 직접 수치 설정
   |
   v
BehaviorProfile 원본 설정
   |
   v
ProfileCompiler
   |
   +-- 목표 선정 가중치
   +-- 위험/도주/추격 임계값
   +-- 경로/반복 방지 설정
   +-- 학습 sample weight
   +-- 무기·방어구 선호와 탐색 강도
   |
   v
고정된 EffectiveProfile + hash
   |
   +-- 데이터 수집 metadata
   +-- BFS 교사 라벨
   +-- 모델 학습/평가
   +-- ONNX metadata
   v
조건부 서버 업로드
```

### 명칭 충돌 방지

GC에는 이미 등록 시 사용하는 `personality`가 있으며 채팅·표현 성격으로 쓰인다. 학습 행동 성격과 혼합하면 기존 API 의미가 깨진다.

- 사용자 CLI 명칭: `personality`
- AI Agent 내부 명칭: `behavior_profile`
- GC 기존 필드: `personality` 유지
- 모델 metadata: `behavior_profile_id`, `behavior_profile_hash`

향후 두 성격을 연결하더라도 명시적인 매핑을 사용하고 같은 DB 필드를 재사용하지 않는다.

---

## 4. Easy 모드

### 4.1 기본 성격

| ID | 사용자 표시 | 중점 | 대표 행동 |
|---|---|---|---|
| `balanced` | 균형형 | 승리·생존·공격 균형 | 상황에 따라 목표를 전환 |
| `hunter` | 공격형 | 추격·피해·킬 | 약한 상대를 적극적으로 추적 |
| `survivor` | 생존형 | 도주·안전 지역·후반 생존 | 불리한 전투를 피함 |
| `collector` | 수집형 | 파워업·장비 이점 | 초반 자원 확보를 우선 |
| `navigator` | 탐색형 | 경로 효율·미방문 지역·반복 방지 | 미로와 장애물에서 빠르게 탈출 |

장비 기본 성향은 다음과 같다.

| ID | 선호 장비 특성 | 현재 GC 카탈로그 기준 초기 선택 예시 |
|---|---|---|
| `balanced` | 모든 능력 균형 | `spear + cloth_cape` |
| `hunter` | 피해량·공격 스킬 | `hammer + cloth_cape` |
| `survivor` | 방어·회피·사거리 | `spear + iron_plate` |
| `collector` | 속도·회피·탐색 | `dagger + cloth_cape` |
| `navigator` | 속도·사거리·탐색 | `bow + cloth_cape` |

카탈로그 수치나 과거 성과가 바뀌면 실제 선택은 달라질 수 있다. 특정 장비 slug를 고정하는 것이 아니라 장비 능력치를 평가한다.

첫 릴리스에서는 5개만 제공한다. 성격 수를 늘리기보다 실제 행동 차이를 검증하는 것이 우선이다.

### 4.2 무작위성 적용 원칙

무작위 이동을 매 틱 추가하지 않는다. 성격을 설정할 때 프리셋 수치를 작은 범위에서 한 번 변형한 뒤 고정한다.

- 기본 variation: `8%`
- 허용 범위: `0~15%`
- 변형 대상: 목표 가중치, 도주 기준, 추격 거리, 탐색 성향, 장비 선호 가중치
- 변형 금지: feature index, 모델 shape, action label, 안전 제한값
- seed: 명시한 값 또는 agent ID와 profile revision으로 생성
- 같은 seed와 설정은 항상 같은 EffectiveProfile을 생성
- `reroll` 명령을 실행하기 전에는 자동으로 다시 뽑지 않음

이 방식은 개체차를 만들면서 학습 재현성과 문제 분석 가능성을 유지한다.

### 4.3 Easy 설정 예시

```json
{
  "schema_version": 1,
  "mode": "easy",
  "preset": "hunter",
  "variation_percent": 8,
  "seed": 42719,
  "revision": 3
}
```

컴파일 결과는 별도 파일에 저장한다.

```json
{
  "profile_id": "hunter",
  "profile_hash": "sha256:...",
  "objective_weights": {
    "win": 1.0,
    "top3": 0.35,
    "kills": 1.45,
    "damage": 1.2,
    "survival": 0.45,
    "powerup": 0.25,
    "path_progress": 0.85,
    "exploration": 0.2,
    "anti_stuck": 1.0
  },
  "policy": {
    "flee_hp_ratio": 0.18,
    "max_chase_path": 12,
    "replan_after_no_progress_ticks": 3
  },
  "equipment": {
    "damage": 2.0,
    "range": 0.8,
    "speed": 1.1,
    "defense": 0.3,
    "evasion": 0.3,
    "skill": 1.5,
    "history": 0.8,
    "exploration": 0.5
  }
}
```

숫자는 설계 예시이며 실제 preset 기본값은 시나리오 평가 후 동결한다.

---

## 5. Expert 모드

Expert 모드는 모델의 epoch나 learning rate가 아니라 행동에 직접 영향을 주는 수치를 제어한다. 저수준 학습 파라미터는 별도 고급 옵션으로 분리한다.

### 5.1 직접 제어 항목

| 경로 | 범위 | 의미 |
|---|---:|---|
| `objective.win` | 0.0~2.0 | 승리 결과 중요도 |
| `objective.top3` | 0.0~2.0 | 상위 순위 중요도 |
| `objective.kills` | 0.0~2.0 | 처치 목표 중요도 |
| `objective.damage` | 0.0~2.0 | 피해량 중요도 |
| `objective.survival` | 0.0~2.0 | 생존 중요도 |
| `objective.powerup` | 0.0~2.0 | 파워업 목표 중요도 |
| `objective.path_progress` | 0.0~2.0 | 목표 경로 단축 중요도 |
| `objective.exploration` | 0.0~2.0 | 미방문 지역 탐색 중요도 |
| `objective.anti_stuck` | 0.0~2.0 | 반복 이동 회피 중요도 |
| `policy.flee_hp_ratio` | 0.05~0.80 | 도주를 고려할 HP 비율 |
| `policy.max_chase_path` | 1~32 | 추격을 유지할 최대 BFS 거리 |
| `policy.replan_ticks` | 1~10 | 무진행 후 목표 재선정 틱 |
| `policy.target_persistence` | 0.0~1.0 | 현재 목표 유지 성향 |
| `policy.teacher_exploration_rate` | 0.0~0.15 | 동률 경로에서 대안 라벨 허용률 |
| `equipment.damage` | 0.0~2.0 | 평균 공격력 선호도 |
| `equipment.range` | 0.0~2.0 | 공격 사거리 선호도 |
| `equipment.speed` | 0.0~2.0 | 무기·방어구 합산 속도 선호도 |
| `equipment.defense` | 0.0~2.0 | 피해 감소 선호도 |
| `equipment.evasion` | 0.0~2.0 | 회피율 선호도 |
| `equipment.skill` | 0.0~2.0 | 발동 확률과 효과 기대값 선호도 |
| `equipment.history` | 0.0~2.0 | 같은 성격에서 축적된 실전 순위 반영도 |
| `equipment.exploration` | 0.0~2.0 | 덜 사용한 조합을 시험하는 강도 |

위 범위를 벗어나면 저장과 학습을 거부한다. `anti_stuck=0`처럼 위험한 값은 Expert 모드에서 허용할 수 있지만 CLI가 경고하고 `--force`를 요구한다.

### 5.2 Expert 설정 예시

```json
{
  "schema_version": 1,
  "mode": "expert",
  "name": "late-game-sniper",
  "objective": {
    "win": 1.4,
    "top3": 0.8,
    "kills": 0.7,
    "damage": 1.1,
    "survival": 1.3,
    "powerup": 0.4,
    "path_progress": 1.0,
    "exploration": 0.2,
    "anti_stuck": 1.2
  },
  "policy": {
    "flee_hp_ratio": 0.35,
    "max_chase_path": 6,
    "replan_ticks": 3,
    "target_persistence": 0.7,
    "teacher_exploration_rate": 0.03
  },
  "equipment": {
    "damage": 0.8,
    "range": 1.8,
    "speed": 1.0,
    "defense": 1.4,
    "evasion": 1.2,
    "skill": 0.6,
    "history": 1.0,
    "exploration": 0.4
  }
}
```

---

## 6. CLI 명령 계약 및 사용 가이드

CLI는 현재 단일 파일 분기 구조에서 `commands/personality.js`와 profile service로 분리한다. 모든 변경 명령은 적용 전 diff를 출력한다.

### 6.1 공통 조회

```bash
# 사용 가능한 성격 목록
npx appback-ai-agent personality list

# 현재 원본 설정, 실제 적용값, 운영 모델 metadata 표시
npx appback-ai-agent personality show

# 자동화용 JSON 출력
npx appback-ai-agent personality show --json

# 현재 설정 유효성 검사
npx appback-ai-agent personality validate
```

`show`는 다음 세 상태를 구분해야 한다.

- configured: 관리자가 저장한 설정
- effective: variation을 반영해 실제 학습에 사용하는 값
- deployed: 현재 GC 서버에 업로드된 모델의 profile ID/hash

configured와 deployed hash가 다르면 `pending training` 또는 `pending deployment`를 표시한다.

### 6.2 Easy 모드 설정

```bash
# 기본 variation 8%로 공격형 선택
npx appback-ai-agent personality set hunter

# 개체차 없이 고정 preset 사용
npx appback-ai-agent personality set navigator --variation 0

# 재현 가능한 seed 지정
npx appback-ai-agent personality set survivor --variation 10 --seed 20260715

# 같은 preset에서 변형값만 다시 생성
npx appback-ai-agent personality reroll

```

현재 `set`은 설정 저장까지만 수행한다. 기존 운영 모델은 유지되며, 학습 연동 단계에서 별도의 `train --profile current` 흐름을 연결한다.

### 6.3 Expert 모드 설정

```bash
# Expert 템플릿 생성
npx appback-ai-agent personality expert init ./personality.json

# 파일 검증
npx appback-ai-agent personality expert validate ./personality.json

# 설정 적용
npx appback-ai-agent personality expert apply ./personality.json

# 단일 값 변경
npx appback-ai-agent personality expert set objective.kills 1.4
npx appback-ai-agent personality expert set policy.flee_hp_ratio 0.3
npx appback-ai-agent personality expert set equipment.damage 1.8
npx appback-ai-agent personality expert set equipment.defense 0.4

# 현재 Expert 설정 내보내기
npx appback-ai-agent personality export ./personality-backup.json

# 현재 설정과 파일 비교
npx appback-ai-agent personality diff ./personality.json
```

### 6.4 학습과 배포

다음 명령은 AA-3/AA-4에서 추가할 예정이며 현재 CLI에는 아직 제공하지 않는다.

```bash
# 현재 성격으로 데이터 재추출
npx appback-ai-agent export --profile current

# 현재 성격으로 수동 학습과 오프라인 평가
npx appback-ai-agent train --profile current --evaluate

# 평가 결과 확인
npx appback-ai-agent model evaluate

# 통과한 모델만 업로드
npx appback-ai-agent model deploy
```

자동학습도 동일한 `export -> train -> evaluate -> deploy` pipeline을 사용한다. CLI 수동 실행과 자동 실행이 서로 다른 경로를 갖지 않게 한다.

### 6.5 되돌리기

```bash
# 성격 설정을 기본 balanced로 되돌림. 운영 모델은 즉시 변경하지 않음
npx appback-ai-agent personality reset

# 이전 설정 revision으로 복구
npx appback-ai-agent personality history
npx appback-ai-agent personality rollback 2
```

### 6.6 가이드 제공 요구사항

릴리스 전 다음 내용을 `docs/operations/PERSONALITY_CLI_GUIDE.md`에 별도로 제공한다.

- Easy 모드 5분 시작 가이드
- 각 성격의 실제 행동 예시
- variation과 seed 설명
- Expert 전체 필드·범위·부작용
- 설정 변경 후 학습/배포 상태 확인법
- 기존 모델을 유지한 채 설정만 바꾸는 방법
- validation 실패와 품질 게이트 실패 해결법
- PM2 환경에서 재시작 후 설정 유지 확인법
- backup/export/rollback 절차

CLI `personality --help`에도 같은 예제를 축약해서 포함한다.

---

## 7. 설정 저장 구조

설정은 npm 패키지 내부가 아니라 설치 프로젝트 디렉터리에 저장한다. 패키지를 업데이트해도 관리자 설정이 보존돼야 한다.

```text
<agent-project>/
  config/
    personality.json             # 관리자가 설정한 원본
    personality.effective.json   # 컴파일된 실제 수치와 hash
    personality.history/         # revision별 백업
  data/
    agent.db
  models/gc/
    gc_move_model.onnx
    meta.json
```

SQLite에는 학습·배포 이력을 저장한다.

- profile revision, mode, preset/name
- profile hash와 seed
- feature/training version
- 학습 시작·종료와 데이터 범위
- 평가 결과
- 업로드 model version

비밀값은 personality 파일에 저장하지 않는다.

---

## 8. 학습 파이프라인 변경

### 성격 기반 장비 선택

장비 선택은 ONNX 이동 추론과 별개이며 challenge 참가 직전에 AI Agent가 수행한다. GC 장비 카탈로그의 현재 수치를 매번 평가하므로 새 장비가 추가되어도 slug별 코드를 추가하지 않는다.

```text
personality_score
  = weighted_normalized(damage, range, speed, defense, evasion, skill)

final_score
  = personality_score
  + equipment.history * profile_scoped_performance
  + equipment.exploration * normalized_UCB
```

- 모든 호환 가능한 무기·방어구 조합을 평가한다.
- 동률은 `weapon:armor` 정렬 순서로 결정해 재현성을 유지한다.
- 실전 성과는 `operation_version + behavior_profile_hash` 단위로 SQLite에 저장한다.
- 다른 성격이나 v7/v8의 성과를 혼합하지 않는다.
- Easy variation은 장비 가중치에도 한 번 적용되며 profile hash에 포함된다.
- 성격 변경 후 재시작하면 새 profile hash의 장비 성과를 처음부터 축적한다.

GC 서버는 추가 성격 로직을 실행하지 않는다. AI Agent가 계산한 무기·방어구 조합을 적용하고 `loadout_profile_id/hash/revision`을 all-or-none으로 전송한다. GC는 이를 queue와 game entry를 거쳐 session manifest/result에 기록한다. AI Agent는 `/agent-contract`의 `loadout_profile_context=true`를 확인한 서버에만 세 필드를 보내며, 미지원 서버에는 기존 payload를 유지한다.

### 데이터 수집

- shared WebSocket이 아닌 authenticated cursor API에서 GC training frame/result/session을 수집
- GC가 실제 추론에 사용한 vector/mask와 raw pre-state를 함께 저장
- frame ID dedupe와 frame/result cursor checkpoint 기록
- 최근 위치·행동·목표 거리 이력 기록
- observed/teacher/executed action 분리
- v7 데이터와 v8 데이터를 자동 분리

### 교사 라벨

- profile objective로 적·파워업·안전 위치·미방문 지점의 목표 점수 계산
- 선택 목표까지 BFS 첫 이동을 teacher action으로 사용
- 반복 이동 시 방문도가 낮은 대체 경로 선택
- 실제 모델 행동은 분석용으로만 보존

### 학습

- profile별 별도 모델 생성
- session 단위 train/validation 분리
- profile 가중치는 라벨 선정과 sample weight 양쪽에 반영
- ONNX metadata에 profile ID/hash/revision 기록

### 품질 게이트

- feature parity
- ONNX input/output shape
- 고정 미로 평가
- 전투 replay 평가
- profile 차별성 평가
- 이전 운영 모델 대비 성능 회귀 검사

---

## 9. 구현 모듈 계획

| 모듈 | 작업 |
|---|---|
| `bin/cli.js` | personality/model 하위 명령 라우팅 |
| `src/config/BehaviorProfileStore.js` | 설정·revision·history 저장 |
| `src/config/ProfileCompiler.js` | preset + variation을 effective profile로 컴파일 |
| `src/config/ProfileValidator.js` | schema와 값 범위 검증 |
| `src/adapters/gc/GcAdapter.js` | profile/원본 tick/이동 이력 수집 |
| `src/adapters/gc/GcEquipmentManager.js` | 성격·과거 성과·탐색 기반 장비 선택 |
| `src/data/storage/SqliteStore.js` | operation/profile별 장비 결과 영속화 |
| `src/adapters/gc/GcFeatureBuilder.js` | v8 feature 생성 |
| `src/data/GcTrainingDataConsumer.js` | cursor 기반 frame/result/session 수집 |
| `src/data/contracts/GcTrainingDataContract.js` | wire payload와 feature 계약 검증 |
| `src/training/TeacherPolicy.js` | 목표 선정과 BFS 교사 행동 |
| `TrainingExporter.js` | version/profile별 export |
| `train_gc_model.py` | profile별 라벨·가중치·metadata |
| `TrainingRunner.js` | 평가 후 조건부 업로드 pipeline |
| `docs/operations/PERSONALITY_CLI_GUIDE.md` | 관리자 사용 가이드 |

경로와 파일명은 구현 시작 시 현재 구조에 맞춰 확정하되, 설정·컴파일·검증 로직을 CLI 파일 안에 직접 넣지 않는다.

---

## 10. 단계별 개발 순서

### AA-0. 계약과 테스트 기반

- behavior profile schema v1 확정
- Easy preset 초안과 Expert 범위 확정
- v8 feature version 및 canonical fixture 확정
- 설정 저장 위치와 migration 정책 확정

### AA-1. CLI와 설정 계층

- list/show/set/reroll/reset 구현
- Expert init/validate/apply/set/export/diff 구현
- revision/history/rollback 구현
- doctor에 profile 유효성 검사 추가
- Easy 장비 성향과 Expert `equipment.*` 직접 제어 구현
- profile-scoped 장비 성과와 재시작 복원 구현

### AA-2. 수집과 교사 라벨

- GC training frame/result/session cursor consumer 연결
- authoritative vector/mask와 raw pre-state 저장
- 목표 선정기와 BFS teacher 구현
- profile별 라벨 차이 테스트
- v7/v8 데이터 격리

### AA-3. 학습과 평가

- profile별 모델 학습
- 미로 시나리오 평가기 및 teacher baseline 완료
- `evaluate maze` CLI와 machine-readable JSON report 완료
- `evaluate personality` canonical fixture 차별성 report 완료
- ONNX action provider 연결 pending
- 운영 전투 replay 지표 pending
- metadata와 evaluation report 생성

### AA-4. 조건부 업로드와 운영

- 품질 게이트 통과 모델만 업로드
- configured/effective/deployed 상태 표시
- 자동학습 pipeline 전환
- 운영 agent canary 배포

### AA-5. 관리자 가이드

- CLI 전체 가이드 작성
- Easy/Expert 실습 시나리오 검증
- 설치형 환경에서 npm 업데이트 후 설정 보존 검증
- 장애·rollback 절차 검증

---

## 11. 테스트와 완료 조건

- Easy 성격 5개가 같은 fixture에서 의도된 서로 다른 목표를 선택한다.
- 같은 preset과 seed는 byte-identical effective profile을 생성한다.
- seed 또는 reroll이 달라져도 preset 허용 범위를 벗어나지 않는다.
- Expert의 잘못된 경로·타입·범위는 저장 전에 거부된다.
- Easy 성격별 초기 장비 선택이 재현 가능하며 의도된 차이를 보인다.
- Expert 장비 가중치가 동일 카탈로그에서 실제 선택을 바꾼다.
- 장비 성과는 재시작 후 복원되고 다른 operation/profile과 섞이지 않는다.
- profile 변경 전 운영 모델은 유지된다.
- profile hash가 다른 데이터는 자동 혼합되지 않는다.
- navigator는 고정 미로 목표 도달률 95% 이상, loop rate 2% 이하를 만족한다.
- `personality --help`와 운영 가이드의 명령이 실제 CLI 테스트를 통과한다.
- npm 패키지 업데이트 및 PM2 재시작 후 설정과 revision 이력이 유지된다.
