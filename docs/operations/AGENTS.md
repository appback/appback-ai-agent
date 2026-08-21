# AI Agent 운영 인벤토리

> 기준: 2026-08-21, `appback-ai-agent@2.5.2`

현재 관리 대상은 내부망 두 호스트의 무학습 runtime 20개다. 과거 `.20`, `.21`,
`.26`, `.30`, EC2 목록은 현재 20개 배포 기준이 아니므로 제거했다.

## 현재 20개

| 호스트 | PM2 | Agent name | Canonical UUID |
|---|---|---|---|
| `storage-40` | `ai-agent-01` | `crab-105e91ed` | `3ad475b0-4349-4fdb-ad20-6d4960cfd657` |
| `storage-40` | `ai-agent-02` | `crab-1ec85b42` | `2dd74a56-da74-4be1-8728-6b468d1378d9` |
| `storage-40` | `ai-agent-03` | `crab-b597fc9f` | `1f34666e-fd99-4498-9046-c3cfe856d2b7` |
| `storage-40` | `ai-agent-04` | `crab-cae55960` | `efc0121b-d36b-49b5-a5ae-f8bd0162ebb2` |
| `storage-40` | `ai-agent-05` | `crab-5f88c122` | `0164f774-69a2-4be6-aad9-27847dd7aecc` |
| `storage-40` | `ai-agent-06` | `crab-f03166bd` | `13b9164c-eb02-4edd-89d4-55bfb26ff5c9` |
| `storage-40` | `ai-agent-07` | `crab-18cf1bcd` | `a03dfad7-18db-4ee0-9969-ef6534c0331d` |
| `storage-40` | `ai-agent-08` | `crab-f3c8444e` | `8da6d9ff-1b41-47d4-aecc-7d1375647b57` |
| `storage-40` | `ai-agent-09` | `crab-ceab468a` | `d21aa552-faca-44df-bd05-abc082349f8f` |
| `storage-40` | `ai-agent-10` | `crab-97d87ccf` | `b2e36f2f-5d70-41fb-a14d-74b4d4807e0b` |
| `storage-50` | `ai-agent-01` | `crab-3ab6fd7a` | `832ed49b-6863-4a18-bef5-78a8d65aeba4` |
| `storage-50` | `ai-agent-02` | `crab-e6c9e066` | `47664dc2-76ff-4db4-889f-81dc7d33ceb7` |
| `storage-50` | `ai-agent-03` | `crab-b3cea572` | `ddd00a01-fd73-4889-873f-ecbfb60b8b84` |
| `storage-50` | `ai-agent-04` | `crab-f2345c5b` | `2d80f359-7f67-41e0-a950-5de477acbd7d` |
| `storage-50` | `ai-agent-05` | `crab-07734d7d` | `9b7bb054-5e6a-4efc-a5a2-bdde00c2dc56` |
| `storage-50` | `ai-agent-06` | `crab-216b3684` | `ef8b137c-75f6-42a8-bcfc-fe2b8895e64d` |
| `storage-50` | `ai-agent-07` | `crab-c3865ceb` | `40b35860-b032-469a-bef9-f4cb6571846a` |
| `storage-50` | `ai-agent-08` | `crab-e04708fa` | `4eb3e9d6-82ab-47fe-8424-2a01567a186c` |
| `storage-50` | `ai-agent-09` | `crab-f5b73a77` | `3e19fbd5-27c0-459d-9ba6-38d1dbbe305e` |
| `storage-50` | `ai-agent-10` | `crab-d162f9b4` | `da54150c-e3f0-4aef-8df5-2bebacca670b` |

## 호스트

### `storage-40` — `appback@192.168.33.40`

- SSH: `ssh storage-40 '<remote command>'`
- Node: `v22.23.2`
- 패키지: global `appback-ai-agent@2.5.2`
- 인스턴스: `/home/appback/ai-agents/agent-01` ~ `agent-10`
- 백업: `/home/appback/ai-agent-backups/pre-2.5.1*`

### `storage-50` — `daone@192.168.33.50`

- SSH: `ssh storage-50 '<remote command>'`
- Node: `v18.20.8`
- 패키지: `/home/daone/ai-agent-runtime`, `appback-ai-agent@2.5.2`
- RHEL 8 호환 override: `better-sqlite3@7.6.2`
- 인스턴스: `/home/daone/ai-agents/agent-01` ~ `agent-10`
- 백업: `/home/daone/ai-agent-backups/pre-2.5.1`

## 인증 계약

AI Agent runtime은 소유주, 이메일, 사용자 계정을 인증에 사용하지 않는다.

```text
로컬 UUID 없음 -> AI Rewards가 UUID + GC JWT 발급
로컬 UUID 있음 -> 로컬 agent credential로 같은 UUID의 GC JWT 발급/갱신
GC 입장 -> AI Rewards JWT 사용
```

- AI Rewards UUID = JWT `sub` = SQLite UUID = GC UUID여야 한다.
- 불일치하면 credential 저장과 게임 참가를 차단한다.
- 계정의 AI Agent 목록은 선택적 UI/정산 연결이며 runtime 인증과 별개다.
- ARW 코드는 기존 AI Rewards JWT로 소유주만 연결하며 UUID/JWT를 발급·교체하지 않는다.
- 구 `GC_API_TOKEN` 항목은 20개 운영 `.env`에서 제거했다.

## 무학습 runtime 공통 설정

```dotenv
GC_API_URL=https://gc-v2-api.appback.app/api/v1
GC_WS_URL=https://gc-v2-api.appback.app
GC_TRAINING_SYNC_ENABLED=false
GC_V81_AUTO_TRAIN_ENABLED=false
```

로컬 자동학습, 학습 후보 업로드, authoritative training feed 동기화를 하지 않는다.
GC 서버 추론과 게임 실행은 그대로 사용한다.

## 운영 확인

```bash
ssh storage-40 'export PATH=/home/appback/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin; pm2 status'
ssh storage-50 'export PATH=/home/daone/.nvm/versions/node/v18.20.8/bin:/usr/bin:/bin; pm2 status'
```

JWT와 legacy token 원문은 로그, 진단 출력, 운영 보고에 남기지 않는다. UUID, Face, 모델,
전적, 보상과 DB는 에이전트 교체 대상이 아니다.

## 2026-08-21 배포 검증

- npm `2.5.2`, Git tag `v2.5.2`
- 두 호스트 PM2 `online` 20/20
- 기존 UUID 보존 20/20
- `credential_issuer=ai-rewards`, `credential_type=agent_jwt` 20/20
- JWT `sub` = 로컬 UUID = GC `/agents/me` UUID 20/20
- GC `/agents/me` HTTP 200 20/20
- 무학습 설정 20/20
- legacy `GC_API_TOKEN` 운영 `.env` 잔존 0건
