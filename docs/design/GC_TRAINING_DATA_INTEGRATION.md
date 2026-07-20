# GC v8 학습 데이터 연동 계약

> **정식 서비스 상태:** 기존 `8.0 / 192차원 / 5방향`은 실험 계약으로 격리하고, 운영 계약은 `8.1 / 214차원 / 11전략`이다. canonical parity와 격리 E2E를 완료했으며 신규 설치 bootstrap, 50게임 자동학습, GC server-owned rollout을 기준 경로로 사용한다. 세부 전략 계약은 `GC_AI_STRATEGY_V8_PLAN.md`를 따른다.

GC Go 서버와 AI Agent가 합의한 v8 운영 학습 데이터의 책임, wire contract와 AI Agent 구현 경계를 정의한다.

## 확정 구조

운영 학습 데이터는 권장안 C를 사용한다.

- GC는 실제 추론 직전에 사용한 versioned vector와 mask를 제공한다. v8.0은 `192/5 action`, v8.1은 `214/11 strategy`다.
- GC는 같은 의사결정 시점의 authoritative raw pre-state와 NavigationHistory snapshot을 제공한다.
- AI Agent는 GC vector를 운영 모델의 입력으로 사용한다.
- AI Agent는 raw state와 관리자 behavior profile로 v8.0의 `teacher_action` 또는 v8.1의 `teacher_strategy`, 그리고 `sample_weight`를 계산한다.
- AI Agent의 FeatureBuilder는 canonical parity와 synthetic maze 생성에만 사용한다.
- shared viewer WebSocket/Socket.IO는 신뢰 가능한 학습 데이터 transport로 사용하지 않는다.

AI Agent는 직접 이동을 제출하지 않는다. GC가 업로드된 ONNX를 추론하고 실제 행동을 실행한다.

## Action 용어

| 필드 | 생성 주체 | 용도 |
|---|---|---|
| `raw_argmax_action` | GC | mask 적용 전 분석값 |
| `model_action` | GC | action mask 적용 후 모델 선택 |
| `executed_action` | GC | safety·충돌 판정 후 실제 위치 변화 기준 행동 |
| `override_reason` | GC | 모델 행동이 변경되거나 실행되지 않은 이유 |
| `observed_action` | AI Agent | 비교 분석용 로컬 정책 행동 |
| `teacher_action` | AI Agent | 기본 학습 label |
| `sample_weight` | AI Agent | profile과 결과 기반 loss 가중치 |

`executed_action`을 자동으로 teacher label로 사용하지 않는다.

v8.1은 `raw_argmax_strategy`, `model_strategy`, `executed_strategy`, `selected_target_slot`, `executed_target_slot`, `path_action`, `executed_action`을 분리한다. 전략 label과 한 칸 이동 action을 같은 필드에 저장하지 않는다.

## API 계약

서버 구현 예정 endpoint:

```http
GET /api/v1/agents/me/training-frames?after=<cursor>&limit=200
GET /api/v1/agents/me/training-results?after=<cursor>&limit=200
GET /api/v1/agents/me/training-sessions/{session_id}
```

- frame과 result cursor는 별도로 관리한다.
- 정렬은 서버 전역 단조 증가 sequence의 오름차순이다.
- 조회 조건은 cursor sequence보다 큰 record다.
- frame은 immutable이며 `(session_id, tick, decision_seq)`가 unique하다.
- AI Agent는 `frame_id` 기준으로 멱등 저장한다.
- 동일 ID/cursor/decision key의 재전송은 payload까지 같을 때만 replay로 인정한다. 내용이 다르면 immutable conflict로 batch 전체를 거부한다.
- v1은 ACK endpoint 없이 로컬 cursor checkpoint를 사용한다.
- 만료 cursor는 HTTP 410 `TRAINING_CURSOR_EXPIRED`로 처리하고 기존 로컬 cursor를 임의로 이동하지 않는다.

## Frame 검증

AI Agent는 cursor를 갱신하기 전에 feature contract별로 다음을 검사한다.

- v8.0은 `record_version=1`, v8.1은 `record_version=2`
- operation version 일치
- feature version, dimension, raw-byte schema hash 일치
- v8.0 vector는 192개, v8.1 vector는 214개의 유한한 숫자
- v8.0 action mask는 5개, v8.1 strategy mask는 11개의 boolean/0/1
- v8.1 strategy mask와 vector index `194..204` 완전 일치
- action·strategy·target·override enum 유효성
- behavior profile hash 형식
- session manifest의 session ID 일치

한 batch의 frame과 session manifest가 모두 검증·저장된 뒤에만 frame cursor를 갱신한다. result도 같은 방식으로 별도 transaction에서 저장한다.

frame의 `behavior_profile`은 당시 서버에 배포된 모델 profile이다. AI Agent의 현재 teacher profile과 다를 수 있으므로 수집 단계에서 현재 profile hash와 같다고 강제하지 않는다. teacher 생성·export 단계에서 사용한 profile ID/hash/revision을 별도로 기록한다.

## 장비 성격과 서버 계약

상태: **GC 구현·격리 테스트 서버 선배포 완료, AI Agent capability 기반 전송 활성**

AI Agent의 effective `behavior_profile_hash`에는 이동 목표·정책뿐 아니라 장비 선호 가중치도 포함한다. GC 서버는 이 가중치를 해석하거나 장비를 선택하지 않는다.

- AI Agent가 `/equipment` 카탈로그를 읽고 challenge 직전에 호환 loadout을 선택한다.
- GC는 challenge에서 선택된 weapon/armor를 적용하고 장비 성격 식별자 세 개를 함께 snapshot한다.
- 장비 결과와 적응 통계는 AI Agent가 `operation_version + behavior_profile_hash`로 격리 저장한다.
- GC의 training frame profile hash는 해당 게임에 적용된 서버 모델 revision의 hash다.
- 성격을 바꿨지만 새 모델이 아직 canary/active가 아니라면 `behavior_profile_hash`는 이전 모델 hash로 남고 `loadout_profile_id/hash/revision`은 새 장비 성격을 나타낸다.
- 이 전환 구간 frame은 기본 current-profile export에서 제외한다. 명시적인 observation 재사용 절차에서만 재라벨링한다.

### 필수 challenge 보강

```json
{
  "weapon": "hammer",
  "armor": "cloth_cape",
  "tier": "basic",
  "loadout_profile_id": "hunter",
  "loadout_profile_hash": "sha256:...",
  "loadout_profile_revision": 3
}
```

- `loadout_profile_id`: AI Agent effective profile ID. 정규식 `[A-Za-z0-9][A-Za-z0-9_-]{0,39}` 적용
- `loadout_profile_hash`: AI Agent가 장비 선택에 사용한 effective profile hash
- `loadout_profile_revision`: 해당 로컬 profile revision
- GC는 세 필드를 all-or-none으로 검증하되 장비 가중치를 해석하지 않는다.
- 대기열에서 게임 참가 정보로 세 필드를 그대로 전달한다.
- `game_entries`에 참가 시점 immutable snapshot으로 저장한다.
- battle 시작 시 training session manifest에 세 값을 snapshot한다.
- training result에도 세 값을 기록한다.
- frame은 immutable session manifest를 참조하므로 매 틱 중복 저장하지 않는다.
- `behavior_profile_hash`는 서버 ONNX 모델 성격, `loadout_profile_hash`는 challenge 장비 선택 성격으로 의미를 분리한다.
- 서버가 필드를 지원하기 전 AI Agent가 임의로 전송하지 않는다. GC 배포 후 agent-contract capability를 확인하고 활성화한다.
- `capabilities.loadout_profile_context=true`는 서버의 수신·저장 지원만 뜻하며 현재 요청에서 필수라는 의미가 아니다.
- v7 호환 기간에는 세 필드를 선택사항으로 허용한다. 향후 v8 필수화는 별도 enforcement 계약과 최소 AI Agent 버전을 확정한 뒤 진행한다.
- contract preflight 실패, capability 누락 또는 `false`이면 기존 weapon/armor/tier만 전송한다.
- capability가 `true`이면 AI Agent는 effective profile에서 완전한 세 필드를 생성하고 로컬 형식 검증 후 전송한다. 부분 tuple은 client 경계에서 차단한다.

이 계약은 v8 canary의 장비 성격별 데이터 감사를 위한 필수 보강이다. 구현 순서는 GC migration/API/queue 전달/training manifest·result/capability 선배포, AI Agent 전송 활성화, 통합 테스트 순으로 한다.

## 로컬 저장

SQLite table:

- `gc_training_sync_state`: operation별 frame/result cursor
- `gc_training_sessions`: terrain과 고정 session manifest
- `gc_training_frames`: immutable decision frame
- `gc_training_results`: session 결과

v7의 기존 `game_sessions`, `battle_ticks`와 섞지 않는다. v8 teacher/export가 구현되기 전까지 신규 feed table은 학습 입력으로 자동 사용하지 않는다.

## 초기 운영 정책

- 수집 대상: canary/enrolled agent만
- 활성화: 서버 소유 자동 rollout, agent별 비활성화 가능
- raw logits: 미보존
- canary frame 보존: 30일 권장
- 일반 v8 frame 보존: 14일 권장
- session/result 보존: 90일 권장
- 상대 식별: 가능한 경우 session-local slot만 제공

보존 기간은 서버 관리자 정책 확정 후 변경할 수 있다.

## 모델 lifecycle

```text
upload(model + metadata)
  -> strict validation
  -> uploaded revision
  -> canary
  -> active
  -> known-good v8 rollback
```

AI Agent는 upload만 수행한다. canary, activate, rollback은 관리자 또는 서버 quality gate가 수행한다. strict 이후 v7 모델로 rollback하지 않는다.

정식 v8.1 경로에서는 신규 agent가 네 Easy 프리셋 중 하나의 synthetic bootstrap을 자동 업로드하고,
GC가 canary pointer를 설정한다. 현재 성격 50게임마다 AI Agent가 `same_profile_only` 후보를 학습·업로드하면
GC는 synthetic canary를 교체한다. 30게임 runtime gate를 통과한 후보만 active가 되며, 더 적은 session의
오래된 upload는 이후 canary로 되돌아갈 수 없다.

## 현재 구현 상태

AI Agent 준비 완료:

- HTTP training frame/result/session client
- frame/result/session contract validator
- SQLite session/frame/result/cursor 저장
- duplicate replay 멱등 처리
- immutable record 충돌 시 transaction rollback과 cursor 보존
- schema 불일치 시 cursor 미갱신
- HTTP 410 cursor 만료를 domain error로 변환하고 checkpoint 보존
- GC `0f2c33b4`의 frame에 누락된 `agent.slot`은 session `agent_slot`으로 보강한 뒤 검증·저장
- 신규 설치의 기본 operation은 v8.1이며 기존 v7/v8.0 설정은 명시적으로 유지되는 동안만 호환
- `operation activate v8 --yes`인 agent에서만 cursor consumer scheduler 활성화
- v8에서는 legacy viewer snapshot 수집을 차단하고 v8.1 authoritative feed 자동학습을 사용
- 현재 성격의 완료 세션 50건마다 `same_profile_only` export, 214→11 학습, offline gate, 후보 업로드 수행
- 관리자 profile 기반 BFS teacher, sample weight와 192차원 CSV/manifest export
- Python trainer의 v7 보정 경로와 v8 teacher-label 경로 분리
- GC capability 정규화와 `loadout_profile_id/hash/revision` 로컬 검증
- capability 지원 서버에만 complete loadout profile tuple 전송
- 미지원·preflight 실패 서버에는 legacy challenge payload 유지
- GC canonical v8.1 schema raw-byte hash `sha256:330be3849f095e9ffca2c46bb4a13b2c9cbbc0c55aade67aa163e0307a1e1a82` 동기화
- 독립 JS builder와 GC fixture의 214 vector 전체, 11 mask, candidate map parity 통과
- v8.1 `record_version=2` parser와 mask/vector 중복 계약 검증
- 성격별 11-class strategy teacher와 primary target label 생성
- 214차원 exporter와 `gc_strategy_net` 214→11 trainer·metadata 구현

GC 서버 코드 및 격리 테스트 서버 완료, 운영 배포 필요:

- training session/frame/result 저장소와 cursor API 구현
- v8 canary/active Engine.Run, NavigationHistory, NavigationSafety 연결
- model canary/activate/rollback과 canonical fixture 구현
- v8 engine/training 기준 commit: `0f2c33b4ecdc020b582a5f22e46f35d5ff47e951`
- loadout profile 계약 기준 commit: `6cdc6c403e794d53e7bdade2862d616cf189532e`
- 격리 테스트 서버는 `loadout_profile_context=true`, observe 모드로 검증

저장된 raw state와 관리자 profile을 결합하는 BFS `teacher_action`/`sample_weight`와 v8 export·학습 입력 분리는 구현됐다. 격리 테스트 서버에서 loadout profile challenge HTTP 201/queued와 queue cleanup까지 확인했다. 남은 E2E는 v8 canary 지정, 실제 게임 생성, session/result의 loadout profile snapshot 확인, cursor 수집과 모델 upload다.

GC 후속 수정 필요: 합의된 frame wire contract대로 `agent: {"slot": n}`을 frame payload에 직접 포함해야 한다. 현재 AI Agent의 session 기반 보강은 `0f2c33b4` 호환을 위한 임시 방어다.
