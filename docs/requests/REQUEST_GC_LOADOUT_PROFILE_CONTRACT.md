# GC 요청: 장비 성격 식별자 계약 보강

## 목적

AI Agent는 behavior profile에 따라 무기·방어구를 선택한다. 서버 ONNX 모델 성격과 challenge 시점의 장비 선택 성격이 다를 수 있으므로 두 식별자를 분리 기록해야 한다.

상태: **GC 구현 및 격리 테스트 서버 선배포 완료, AI Agent capability 기반 전송 구현 완료**

구현 기준:

- GC 구현: `6cdc6c403e794d53e7bdade2862d616cf189532e`
- GC 배포 기록: `b7aa0bf9566be301a00dafc8e166f03bd66cf904`
- GC migration: `070_loadout_profile_context.sql`
- AI Agent: `/agent-contract` capability가 정확히 `true`일 때만 세 필드를 전송

## 요청 범위

### Challenge 입력

기존 weapon/armor/tier에 다음 필드를 추가한다.

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

검증:

- 세 필드는 all-or-none으로 입력
- ID는 AI Agent의 effective profile ID이며 `[A-Za-z0-9][A-Za-z0-9_-]{0,39}`로 검증
- hash는 `sha256:`과 lowercase 64자리 hex 형식
- revision은 0 이상의 정수
- 서버는 profile 가중치를 해석하거나 장비를 재선택하지 않음
- 필드가 없는 기존 v7 요청은 observe/호환 정책에 따라 계속 처리
- 현재 v7과 v8 모두 세 필드 생략을 허용하며, 필수화는 별도 enforcement 전환으로 처리

### Training session/frame

- queue 참가 정보에서 세 필드를 game 생성까지 손실 없이 전달
- `game_entries`에 참가 시점 세 필드를 immutable snapshot
- battle 시작 시 세 필드를 training session manifest에 snapshot
- training result에도 세 필드를 기록
- frame이 session manifest를 통해 세 값을 추적할 수 있도록 보장하고 매 frame 중복 저장하지 않음
- 기존 `behavior_profile_hash`는 ONNX 모델 성격 의미를 유지
- `loadout_profile_hash`를 모델 hash로 대체하거나 덮어쓰지 않음

### Agent contract capability

AI Agent가 서버 지원 여부를 확인할 수 있도록 `/api/v1/agent-contract`에 capability를 추가한다.

```json
{
  "capabilities": {
    "loadout_profile_context": true
  }
}
```

AI Agent는 capability가 확인된 서버에만 신규 필드를 전송한다.

이 capability는 지원 여부만 나타낸다. 필드 필수 여부는 나타내지 않으며 별도 enforcement 계약 없이는 optional이다.

## 통합 검증

1. 기존 필드 없는 challenge가 observe 모드에서 정상 처리된다.
2. 세 필드 일부만 보낸 요청은 명확한 4xx 오류를 반환한다.
3. 신규 필드를 보낸 challenge의 game entry, session manifest와 result에 동일 값이 저장된다.
4. 성격 변경 후 이전 모델이 활성인 게임에서 model profile과 loadout profile이 서로 다르게 보존된다.
5. 잘못된 ID/hash/revision 요청은 명확한 4xx 오류를 반환한다.
6. training frame cursor, dedupe와 immutable 계약은 변경되지 않는다.

## 배포 순서

1. GC schema/API/capability 선배포
2. GC 통합 테스트와 observe 검증
3. AI Agent capability 기반 전송 활성화
4. 격리 테스트 서버 실게임 검증
5. v8 canary 반영

현재 1~3단계와 4단계의 challenge/queue smoke는 완료했다. 격리 테스트 서버에서 capability 확인, 완전한 tuple challenge HTTP 201/queued, queue DB snapshot, 임시 agent 정리를 검증했다. 4단계의 실제 게임 session/result 전달 검증과 5단계 v8 canary 반영은 남아 있다.

관련 기준 문서: `docs/design/GC_TRAINING_DATA_INTEGRATION.md`
