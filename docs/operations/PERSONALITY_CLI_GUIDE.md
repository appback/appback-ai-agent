# Personality CLI 가이드

AI Agent의 행동 성격을 Easy 또는 Expert 모드로 설정하는 관리자 가이드다.

현재 구현 범위는 성격 설정, 검증, revision, backup, 런타임 식별과 성격 기반 장비 선택까지다. 장비 선호는 agent 재시작 후 다음 challenge부터 적용된다. 이동 모델은 즉시 변경하지 않으며 v8 학습에서 profile hash가 같은 새 모델을 생성해야 반영된다. GC가 `loadout_profile_context` capability를 제공하면 challenge에 성격 ID/hash/revision도 함께 기록되고, 미지원 서버에는 기존 장비 payload만 전송한다.

---

## 1. 현재 상태 확인

설치 프로젝트 디렉터리에서 실행한다.

```bash
cd /path/to/agent-project
npx appback-ai-agent personality show
```

출력 항목:

- `Personality`: 현재 성격 ID와 표시 이름
- `Mode`: Easy 또는 Expert
- `Revision`: 설정 변경 이력 번호
- `Variation/Seed`: Easy 모드의 개체차 설정
- `Profile hash`: 실제 행동 수치의 식별값
- `Deployed`: GC 모델 metadata 연동 상태

JSON 출력:

```bash
npx appback-ai-agent personality show --json
```

설정 파일이 없으면 variation 없는 `balanced` 기본값을 표시하며 파일을 만들지는 않는다.

---

## 2. Easy 모드

### 성격 목록

```bash
npx appback-ai-agent personality list
```

| 성격 | 행동 설명 | 장비 성향 |
|---|---|---|
| `balanced` | 승리·생존·공격 균형 | 전체 능력 균형 |
| `hunter` | 추격·피해·킬 우선 | 피해량·공격 스킬 |
| `survivor` | 도주·안전 지역·후반 생존 우선 | 방어·회피·사거리 |
| `collector` | 파워업과 유리한 장비 상태 우선 | 속도·회피 |
| `navigator` | 경로 효율·탐색·반복 이동 방지 우선 | 속도·사거리 |

### 기본 설정

```bash
npx appback-ai-agent personality set hunter
```

기본 variation `8%`와 새 seed가 한 번 생성된다. 이 값은 `reroll` 전까지 바뀌지 않는다.

### 개체차 조절

```bash
# 프리셋 그대로 사용
npx appback-ai-agent personality set navigator --variation 0

# 10% 범위에서 변형
npx appback-ai-agent personality set survivor --variation 10

# 동일 설정을 다른 서버에서도 재현
npx appback-ai-agent personality set collector --variation 8 --seed 20260716
```

variation 허용 범위는 `0~15`다. 무작위 이동을 매 틱 추가하는 값이 아니라 preset의 행동 및 장비 선호 수치를 설정 시 한 번 변형하는 비율이다.

### 변형값 다시 생성

```bash
npx appback-ai-agent personality reroll
```

현재 Easy preset과 variation은 유지하고 seed만 새로 만든다. 새 revision으로 저장된다.

### 기본값으로 복구

```bash
npx appback-ai-agent personality reset
```

`balanced`, variation `8%`의 새 설정을 저장한다.

---

## 3. Expert 모드

### 템플릿 생성

```bash
npx appback-ai-agent personality expert init ./personality.json --name my-agent
```

기존 파일을 덮어써야 할 때만 `--force`를 사용한다.

### 설정 파일 검증

```bash
npx appback-ai-agent personality expert validate ./personality.json
```

unknown field, 누락된 값, 숫자 범위 오류가 있으면 적용되지 않는다.

### 설정 적용

```bash
npx appback-ai-agent personality expert apply ./personality.json
```

### 단일 값 변경

```bash
npx appback-ai-agent personality expert set objective.kills 1.4
npx appback-ai-agent personality expert set policy.flee_hp_ratio 0.3
npx appback-ai-agent personality expert set equipment.damage 1.8
npx appback-ai-agent personality expert set equipment.defense 0.4
```

현재 설정이 Expert 모드가 아니면 단일 값 변경을 거부한다.

### Objective 범위

모든 objective 값 범위는 `0.0~2.0`이다.

- `win`, `top3`
- `kills`, `damage`, `survival`
- `powerup`
- `path_progress`, `exploration`, `anti_stuck`

### Policy 범위

| 필드 | 범위 |
|---|---:|
| `flee_hp_ratio` | 0.05~0.80 |
| `max_chase_path` | 1~32 정수 |
| `replan_ticks` | 1~10 정수 |
| `target_persistence` | 0.0~1.0 |
| `teacher_exploration_rate` | 0.0~0.15 |

### Equipment 범위

모든 equipment 값 범위는 `0.0~2.0`이다. `0`은 해당 요소를 선택 점수에서 제외하고, `2`는 강하게 선호한다.

| 필드 | 의미 |
|---|---|
| `damage` | 무기의 평균 피해량 |
| `range` | 무기의 공격 사거리 |
| `speed` | 무기 속도와 방어구 속도 보정의 합 |
| `defense` | 방어구 피해 감소 |
| `evasion` | 방어구 회피율 |
| `skill` | 스킬 발동 확률과 효과의 기대값 |
| `history` | 같은 성격에서 축적된 실전 평균 순위 반영도 |
| `exploration` | 사용 횟수가 적은 호환 조합을 시험하는 강도 |

예를 들어 공격력만 강하게 보고 탐색을 끄려면 다음과 같이 설정한다.

```bash
npx appback-ai-agent personality expert set equipment.damage 2
npx appback-ai-agent personality expert set equipment.range 0
npx appback-ai-agent personality expert set equipment.speed 0
npx appback-ai-agent personality expert set equipment.defense 0
npx appback-ai-agent personality expert set equipment.evasion 0
npx appback-ai-agent personality expert set equipment.skill 0
npx appback-ai-agent personality expert set equipment.history 0
npx appback-ai-agent personality expert set equipment.exploration 0
```

장비는 고정 slug가 아니라 GC가 제공한 활성 카탈로그와 호환 방어구 범위에서 결정된다. 같은 설정과 같은 카탈로그·성과 기록이면 결과는 결정적이다.

---

## 4. 검증과 비교

현재 설정 검사:

```bash
npx appback-ai-agent personality validate
npx appback-ai-agent doctor
```

다른 설정 파일과 실제 행동 수치 비교:

```bash
npx appback-ai-agent personality diff ./personality.json
```

Easy 모드는 seed와 variation을 컴파일한 effective 수치를 기준으로 비교한다.

---

## 5. Backup과 Rollback

현재 원본 설정 내보내기:

```bash
npx appback-ai-agent personality export ./personality-backup.json
```

기존 파일 덮어쓰기:

```bash
npx appback-ai-agent personality export ./personality-backup.json --force
```

revision 목록:

```bash
npx appback-ai-agent personality history
```

이전 revision 복구:

```bash
npx appback-ai-agent personality rollback 2
```

rollback은 revision 번호를 과거 값으로 되돌리지 않는다. 과거 설정을 가져와 새로운 revision으로 저장해 변경 이력을 유지한다.

---

## 6. 저장 위치와 운영 주의사항

설정은 설치 프로젝트 아래에 저장된다.

```text
config/personality.json
config/personality.effective.json
config/personality.history/
```

- npm 패키지 내부가 아니므로 npm update 후에도 유지된다.
- PM2 재시작 시 같은 작업 디렉터리를 사용해야 한다.
- 설정 파일에는 API token 같은 비밀값을 넣지 않는다.
- `personality.json`을 직접 수정한 경우 반드시 `personality validate`를 실행한다.
- 직접 수정하면 effective 파일이 자동 갱신되지 않으므로 `expert apply` 또는 CLI set 명령을 사용한다.

PM2 작업 디렉터리 확인 예시:

```bash
pm2 describe ai-agent
```

설정 적용 확인:

```bash
npx appback-ai-agent personality show
pm2 restart ai-agent
pm2 logs ai-agent --lines 30
```

시작 로그의 `Behavior personality`와 CLI의 profile hash가 같은지 확인한다.

### 장비 선택 적용과 기록

- 설정 변경은 실행 중 게임의 장비를 바꾸지 않는다.
- 재시작 후 다음 challenge부터 새 성격으로 장비를 선택한다.
- 초기 선택은 성격 선호를 우선하며, 이후 같은 성격에서 쌓인 평균 순위와 탐색 점수가 반영된다.
- 장비 결과는 `operation_version + profile hash`별로 저장되므로 v7/v8 또는 다른 성격의 기록과 섞이지 않는다.
- `personality show`의 `Equipment preferences`에서 실제 적용 가중치를 확인한다.

```bash
npx appback-ai-agent personality show
pm2 restart ai-agent
pm2 logs ai-agent --lines 50
```

로그의 `Selected loadout`에는 최종 점수와 personality preference, history, exploration 구성값이 출력된다.

### 학습 중 성격 변경

성격 변경 명령은 진행 중인 게임, 학습 프로세스, 배포 모델을 즉시 변경하지 않는다. 실행 중인 작업은 시작 당시 profile snapshot으로 완료되고 새 성격은 agent 재시작 후 별도 teacher/export generation으로 시작한다.

```bash
pm2 restart ai-agent
npx appback-ai-agent export
```

기본 export는 현재 profile hash의 frame만 사용한다. 전문가가 과거 성격에서 수집된 raw observation을 현재 성격의 teacher로 전부 다시 라벨링하려는 경우에만 다음 옵션을 사용한다.

```bash
npx appback-ai-agent export --reuse-observations
```

이 옵션은 기존 label을 혼합하지 않는다. 생성된 manifest에 재사용 정책과 원본 profile hash가 기록되므로 일반 profile-isolated dataset과 구분된다.

GC가 제공하는 frame의 profile hash는 실제 추론에 사용한 모델 revision 기준이다. 따라서 새 성격과 같은 hash의 전용 frame은 새 모델을 업로드하고 GC canary 또는 active로 지정한 뒤부터 수집된다. 새 성격의 최초 모델은 명시적 observation 재사용 또는 검증된 bootstrap 절차로 준비해야 한다.

---

## 7. 현재 제한사항

- 성격 설정은 v7 이동 모델의 ONNX 행동을 변경하지 않지만 장비 선택에는 적용된다.
- 실행 중인 agent는 설정 파일을 hot reload하지 않으므로 성격 변경 후 재시작해야 한다.
- CLI의 `Deployed` 표시는 아직 서버 active revision 조회와 연결되지 않았다.
- v8.1은 현재 성격의 완료 게임 50건마다 자동학습·offline gate·후보 업로드를 수행한다.
- 후보의 canary·active·known-good 전환은 관리자 승인 전까지 자동화하지 않는다.

따라서 현재 단계에서 `personality set`은 운영 중인 ONNX 모델을 교체하지 않는다. 다만 agent를 재시작하면 다음 challenge부터 새 profile hash의 장비 선호와 별도 성과 기록을 사용한다.
