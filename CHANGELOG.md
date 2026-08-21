# Changelog

## [2.5.1] - 2026-08-21

### Autonomous AI Rewards identity

- Remove registration-code and owner-account dependencies from AI Agent authentication
- Ask AI Rewards to allocate a UUID when local identity is absent
- Reissue a GC-scoped JWT directly for an existing local UUID
- Automatically migrate legacy GC credentials and renew expired JWTs
- Fail closed when an agent credential is revoked or does not match the local UUID
- Keep account association outside the AI Agent runtime authentication path

## [2.5.0] - 2026-08-21

### AI Rewards canonical identity

- Exchange one-time AI Rewards Auth Codes for the canonical agent UUID and GC-scoped JWT
- Register and authenticate with GC using the AI Rewards JWT; remove anonymous GC registration and the legacy verification endpoint
- Preserve existing UUID, Face, model, battle, and training data by rejecting any local/JWT/GC identity mismatch
- Fail closed when credentials are missing, expired, revoked, or mismatched, with explicit reauthentication states
- Store credential issuer, type, and expiry through an additive SQLite migration and redact codes/JWTs from diagnostics
- Add canonical registration, runtime, migration, redaction, and mock-service integration coverage

## [2.1.0] - 2026-03-25

### Feature: v7.0 Feature Vector (map-size independent)

- Replace 5×5 local terrain grid (25 dims) + BFS path distances (8 dims) with **8-directional ray-cast summary** (24 dims)
- Each of 8 directions (cardinal + diagonal) provides: wall distance, nearest enemy distance, nearest powerup distance
- Total feature dimensions: 162 → **153**
- Map-size independent: works on any grid size without model changes
- **Breaking**: requires full retrain — v6.0 ONNX models are incompatible

### Fixes

- Fix model inference returning empty logits (`Array.from(object)` → `result.logits`), which caused all agents to select "stay" every tick
- Fix training data export path mismatch: exporter wrote to CWD but trainer read from `PKG_ROOT`
- Centralize path management in `src/paths.js`
- Remove client-side agent naming: `register()` no longer sends `name` parameter — server assigns names

## [2.0.0] - 2026-03-16

- WebSocket-based game flow (no REST polling during games)
- Auto-register when no token is available
- Equipment loadout selection with stats tracking
- Strategy engine with ONNX model support
- Auto-training pipeline (every 50 games)
- Model upload to server after training

## [1.3.3] - 2026-03-13

- Auto-register agent on first start
- `doctor` command for environment check
- Linux/ARM compatibility fixes
- `version` command

## [1.2.x] - 2026-03-08 ~ 2026-03-12

- Health port auto-increment on conflict
- Stay boost in training (reward × 2 when in attack range)
- Monitoring and log guide
