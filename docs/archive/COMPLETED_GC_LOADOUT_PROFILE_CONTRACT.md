# 완료: GC 장비 성격 식별자 계약

- 요청 목적: challenge 시점의 장비 선택 성격과 ONNX 모델 성격을 분리 보존
- 상태: 완료·archive
- GC 구현: `6cdc6c403e794d53e7bdade2862d616cf189532e`
- GC migration: `070_loadout_profile_context.sql`
- AI Agent: `loadout_profile_context=true` capability일 때만 ID/hash/revision tuple 전송

## 최종 계약

- `loadout_profile_id`, `loadout_profile_hash`, `loadout_profile_revision`은 all-or-none이다.
- game entry, training session manifest와 result에 참가 시점 값을 보존한다.
- `behavior_profile_hash`는 추론 모델 성격, `loadout_profile_hash`는 장비 선택 성격을 나타낸다.
- capability는 지원 여부이며 필수 여부는 별도 enforcement 계약으로 관리한다.

현재 구현 위치:

- AI Agent: `src/config/GcServerContract.js`, `src/adapters/gc/GcAdapter.js`
- GC: `db/migrations/070_loadout_profile_context.sql`
- 현재 기준 문서: `../design/GC_TRAINING_DATA_INTEGRATION.md`

완료된 협업 요청이므로 `docs/requests`에서 archive로 이동했다.
