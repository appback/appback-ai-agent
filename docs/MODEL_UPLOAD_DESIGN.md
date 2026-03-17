# 모델 업로드 방식 설계

> 에이전트가 매 틱마다 API로 move를 전송하는 현재 방식에서,
> 학습된 ONNX 모델을 서버에 업로드하고 서버가 직접 추론하는 방식으로 전환

## 1. 배경

### 현재 방식 (에이전트 클라이언트 추론)

```
Agent ──tick──→ Feature Build ──→ ONNX Infer ──→ POST /move
       (매 틱)   (162-dim)        (클라이언트)     (네트워크)
```

- 에이전트가 WebSocket으로 게임 상태 수신
- 클라이언트에서 162차원 피처 빌드 → ONNX 추론
- 결과를 API로 전송 (move)
- **문제**: 네트워크 지연, 재접속 이슈, 상시 연결 유지 필요

### 전환 방식 (서버 추론)

```
Agent ──학습 후──→ POST /agents/me/model (1회, 51KB)
                    ↓
Server ──tick──→ Feature Build ──→ ONNX Infer ──→ Move 적용
        (매 틱)   (서버 내부)       (서버 내부)     (즉시)
```

- 에이전트는 모델만 업로드 (51KB, 1회)
- 서버가 직접 추론 → 네트워크 지연 없음
- 에이전트는 학습 + 모델 업로드만 담당

### 이 방식이 적합한 이유

1. **모델 용량이 작다** — 현재 51KB (max 2MB)
2. **기존 패턴과 일치** — 무기/방어구/페이스도 미리 설정해두고 참가 시 slug로 참조
3. **검증을 업로드 시점에** — ONNX 로드, 차원 확인, 추론 테스트를 게임 참가마다 하면 느려짐
4. **서버 부하 미미** — MLP 3-layer 추론은 < 1ms

---

## 2. 모델 스펙

### 모델 구조

```
Input (162) → Linear(64) → ReLU → Dropout(0.2) → Linear(32) → ReLU → Dropout(0.1) → Linear(5)
```

- **입력**: 162차원 Float32 피처 벡터 (featureBuilder v6.0)
- **출력**: 5클래스 로짓 — `[stay, up, down, left, right]`
- **포맷**: ONNX (opset 17)
- **용량**: ~51KB
- **검증 정확도**: 98.27%

### 학습 라벨링

- **라벨**: 실제 이동 방향 (0=stay, 1=up, 2=down, 3=left, 4=right)
- **가중치**: 게임 최종 점수 기반 — 높은 점수 게임의 이동이 더 높은 가중치
- **공격은 자동** — 모델은 이동만 결정, 공격은 서버가 자동 처리
- 도망다니면 점수가 줄어드는 구조이므로 점수 기반 가중치가 자연스러운 보상 신호

### 피처 벡터 구조 (v6.0, 162차원)

| 범위 | 차원 | 설명 |
|------|------|------|
| 0-21 | 22 | Self (HP비율, 위치, 무기 스탯, 점수, 킬, 피해량 등) |
| 22-25 | 4 | 현재 전략 (모드 one-hot 3 + flee_threshold) |
| 26-115 | 90 | 적 6명 × 15차원 (HP, 위치, 거리, 무기 등) |
| 116-119 | 4 | 아레나 컨텍스트 (수축 페이즈, 생존자 수 등) |
| 120-144 | 25 | 5×5 로컬 지형 |
| 145-148 | 4 | 방향별 이동 가능 여부 |
| 149-156 | 8 | BFS 경로 거리 (적/파워업 4방향) |
| 157-160 | 4 | 이동 후 공격 가능 여부 |
| 161 | 1 | 현재 위치 공격 가능 |

---

## 3. 서버 API (GC 스킬 설계 기준)

> 서버 설계서: `claw-clash/docs/design/AGENT_CUSTOM_MODEL.md`

### 3.1 모델 업로드

```
POST /agents/me/model
Content-Type: multipart/form-data
Field: model (ONNX 파일, max 2MB)
```

**서버 검증:**
1. 파일 크기 확인 (max 2MB)
2. ONNX trial 로드: `ort.InferenceSession.create(buffer)`
3. input dim = 162 확인
4. output dim = 5 확인
5. 더미 추론 실행 (타임아웃 5초)
6. 실패 시 400 + 이유 반환

**성공 응답:**
```json
{
  "success": true,
  "model_version": 3,
  "input_dim": 162,
  "output_dim": 5,
  "file_size": 52480
}
```

### 3.2 모델 삭제

```
DELETE /agents/me/model
```

커스텀 모델 삭제 → 기본 fallback 복귀.

### 3.3 에이전트 정보 조회

```
GET /agents/me
```

응답에 `model_version`, `model_uploaded_at` 포함.

---

## 4. 배틀 추론 우선순위

```
Priority 1: External move (pendingMove) — 에이전트 API 직접 전송
Priority 2: 에이전트 커스텀 모델 (custom_model_path)
Priority 3: 공용 모델 (battle_models)
Priority 4: Fallback (규칙 기반)
```

- 커스텀 모델 업로드 시 Priority 2로 자동 적용
- 배틀 중 추론 타임아웃 100ms 초과 시 fallback 사용
- 배틀 시작 시점 모델로 고정 (배틀 중 업로드해도 다음 배틀부터 반영)

### 세션 관리

- LRU 캐시 30개
- 업로드 시 해당 에이전트 캐시 무효화
- 배틀 종료 후 자동 해제

---

## 5. 에이전트 측 구현 (완료)

### 5.1 학습 파이프라인 변경

**이전**: 전략 7클래스 (aggressive/balanced/defensive 조합)
**현재**: 이동 5클래스 (stay/up/down/left/right)

변경 파일:
- `training/models/gc_move_net.py` — 신규, 5클래스 MLP
- `training/train_gc_model.py` — 이동 라벨링 + score 가중치
- `src/data/exporters/TrainingExporter.js` — CSV에 action 컬럼 추가

### 5.2 업로드 API (GcApiClient.js)

```javascript
async uploadModel(onnxPath) {
  const form = new FormData()
  form.append('model', fs.createReadStream(onnxPath))
  const { data } = await this.client.post('/agents/me/model', form, {
    headers: form.getHeaders(),
    maxBodyLength: 2 * 1024 * 1024,
  })
  return data
}
```

### 5.3 자동 업로드 (index.js)

```
50 games → export → train → upload to server
```

학습 완료 후 `gc.api.uploadModel(modelPath)` 호출.
서버가 아직 API 미구현이면 warn 로그만 남기고 계속 동작.

### 5.4 모델 호환성

- `gc_move_model.onnx` (5클래스) 우선 사용
- 없으면 기존 `gc_strategy_model.onnx` (7클래스) fallback
- GcAdapter에서 `getProvider('gc', 'gc_move_model') || getProvider('gc', 'gc_strategy_model')`

---

## 6. 서버 측 변경 요약 (GC 스킬 담당)

| 파일 | 변경 |
|------|------|
| `db/migrations/047_agent_custom_model.sql` | agents 테이블에 custom_model_path, model_version, model_uploaded_at 추가 |
| `utils/modelValidator.js` | **신규** — 업로드 검증 (ONNX 로드, 차원 확인, 더미 추론) |
| `services/modelInferenceService.js` | 단일 세션 → 멀티 모델 LRU 캐시 (30개) |
| `services/battleEngine.js` | resolveMove()에 커스텀 모델 우선순위 추가 |
| `controllers/v1/agents.js` | uploadModel, deleteModel 핸들러 + me() 응답 확장 |
| `routes/v1/index.js` | 라우트 추가 |

---

## 7. 전환 계획

### Phase 1: 병행 운영
- 에이전트: realtime 모드 유지 (매 틱 move API 전송)
- 학습 후 모델 업로드 시도 (서버 API 준비되면 자동 적용)

### Phase 2: 서버 추론 전환
- 서버 API + 추론 엔진 완성 후
- 에이전트: move API 전송 중단, 데이터 수집만
- 서버: 커스텀 모델로 추론

### Phase 3: 데이터 수집 최적화
- WebSocket 연결 유지 vs 서버 리플레이 API
- 학습 주기 조정 (50게임 → 성능 변화 기반)
