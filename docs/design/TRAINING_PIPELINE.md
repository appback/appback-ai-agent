# Training Pipeline

자동 학습 + 모델 업로드 파이프라인 설계.

---

## Overview

```
게임 진행 → 틱 데이터 수집 (SQLite)
         ↓
   50게임 도달 (AUTO_TRAIN_AFTER_GAMES)
         ↓
   game_ended 이벤트 → exporter.exportForTraining()
         ↓
   CSV/JSON 생성 (training/data/raw/)
         ↓
   Python 학습 (train_gc_model.py)
         ↓
   ONNX 모델 export (models/gc/gc_move_model.onnx)
         ↓
   서버 업로드 (POST /agents/me/model)
         ↓
   서버에서 LRU 캐시 무효화 → 다음 게임부터 적용
```

---

## Components

### 1. Data Collection — `src/core/DataCollector.js`

매 틱마다 캡처:
- `state` — 서버에서 받은 tick payload (agents 위치/HP/무기 등)
- `my_features` — 153차원 피처 벡터 (v7.0)
- `my_decision` — 모델/휴리스틱 결정 (action, source, logits, actionMask)

10틱 단위 버퍼링 후 SQLite `battle_ticks` 테이블에 batch insert.

### 2. Data Export — `src/data/exporters/TrainingExporter.js`

`game_ended` 이벤트 시 호출:
- `claw-clash_sessions.json` — 게임 결과 (rank, score, kills, ...)
- `claw-clash_ticks.csv` — 틱별 피처 + 라벨

**필터링:**
- `my_features`가 153차원인 틱만 (v7.0 데이터 격리)
- `my_decision.action`이 비어있지 않은 틱만 (sub_tick 노이즈 제거)
- 마지막 틱의 피처 차원 기준으로 일관성 유지

### 3. Training — `training/train_gc_model.py`

**라벨 보정 (`correct_label`):**
- `can_attack` ≥ 0.5 → 라벨을 `stay`로 보정 (자동공격 + 피해 20% 감소)
- `attack_after_move[d]` = 1 → 그 방향을 라벨로 보정 (사거리 진입)
- 파워업 1칸 이내 → 파워업 방향으로 보정

**틱 단위 보상 (`compute_tick_reward`):**
- 공격 가능 시 stay: +3.0
- 공격 가능 시 이동: ×0.3
- 적 근접 (≤0.15) + 사거리 진입 이동: +2.0
- 파워업 인접 + 이동: +1.5
- idle 임계점 회피: +0.5
- 축소존에서 stay: ×0.3
- 게임 결과 보정 (rank 1: ×2.0, top3: ×1.5, bottom: ×0.5)

**네트워크:**
- 153 → 128 → 64 → 32 → 5 (`GcMoveNet`)
- Dropout 0.2 / 0.15 / 0.1
- Adam + ReduceLROnPlateau
- 80 epochs, batch 128

### 4. Model Upload

학습 완료 후 `src/index.js`에서:
```js
const uploadResult = await gc.api.uploadModel(modelPath)
```

서버 응답에서 `VERSION_OUTDATED` 에러 코드가 오면 업데이트 안내 로그.

---

## Feature Vector v7.0 (153-dim)

| Range | 의미 |
|---|---|
| 0..21 | Self features (22) — HP/위치/무기 스펙/원핫 |
| 7 | Self weapon rangeType (adjacent=0.0, pierce=0.5, ranged=1.0) |
| 22..25 | Strategy (4) |
| 26..115 | Opponents 6 × 15 = 90 |
| 116..119 | Arena context (4) |
| 120..143 | 8-directional summary 8 × 3 = 24 |
| 144..147 | Move validity (4) |
| 148..151 | Attack possible after move (4) |
| 152 | Can attack from current position (1) |

8방향 요약 = 각 방향 (벽거리, 가장 가까운 적 거리, 파워업 거리).
맵 크기 독립적 (8×8 → 16×16 확장 시에도 동일 차원).

---

## Trigger Conditions

```javascript
// src/index.js
if (totalGames > 0 && totalGames % autoTrainAfter === 0 && !trainer.isRunning) {
  // export → train → upload
}
```

- 정확히 50, 100, 150, ...에서만 트리거
- 학습 중에는 중복 실행 안 함

---

## 알려진 한계

1. **지도학습 모방** — 휴리스틱 행동을 학습. 휴리스틱보다 잘하기 어려움.
2. **틱 단위 보상은 휴리스틱** — 진짜 강화학습 아님. 라벨 보정도 규칙 기반.
3. **무기 다양성** — `GcEquipmentManager`가 UCB1으로 탐색하지만 데이터 풀이 sword 위주로 편향될 수 있음.
4. **데이터 분포 편향** — 게임 결과 좋은/나쁜 행동을 명확히 구분 못함.

---

## 개선 방향 (참고)

- **진짜 강화학습** — 게임 결과 reward로 정책 업데이트 (PPO 등)
- **무기 타입별 분리 학습** — adjacent/pierce/ranged 별도 모델 (데이터 충분해진 후)
- **상대방 무기 인식 강화** — 모델 입력에 적의 사거리/타입 비중 늘림
