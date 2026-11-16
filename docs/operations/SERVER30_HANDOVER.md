# Server 30 AI Agent 인수인계 / 서버 이전 실행서

기준일: 2026-11-16 UTC. 담당 범위: appback-ai-agent 개발·배포 및 관련 runtime 운영.
이 문서는 30 서버의 작업 환경을 다른 서버로 인계하기 위한 시작점이다.
이번 작업은 문서화와 Git 반영이며, 실제 이전·서비스 중지·데이터 삭제는 수행하지 않았다.

## 1. 후임자가 가장 먼저 할 일

```bash
git clone https://github.com/appback/appback-ai-agent.git
cd appback-ai-agent
cat docs/operations/SERVER30_HANDOVER.md
git fetch origin --tags
git show v2.5.5:package.json
```

주의: 기본 브랜치는 `master`이며 2026-11-16 확인 HEAD는
`500bf8b2c37d0e8d6834c7d0875c2071b4b645bc`, package.json 버전은 2.4.1이다.
실제 2.5.5 인증·FIFO·재인증 수정은 별도 브랜치에 있다.

- 배포 코드 브랜치: `docs/refresh-ai-agent-v81-20260820`
- 2.5.5 코드 커밋: `62d1176378006eee40fdb8749438ef3d4a6cb0c6`
- 재현 가능한 릴리스: `v2.5.5` (annotated tag를 peel한 커밋이 위 SHA)
- npm 공개 최신: `appback-ai-agent@2.5.5` (이번 인수인계 시 재조회)
- npm tarball SHA-1: `6e175a5c8f397bd74498d92b9e38aa3bb1c8a3e2`
- 기존 배포 tarball SHA-256: `5ef044bdd778239aaee52a7662344051fd954ba7bb4e34aff788d299c9285a47`

개발을 이어갈 때:
```bash
git switch --track origin/docs/refresh-ai-agent-v81-20260820
git rev-parse HEAD
node --version
npm ci
npm test
```

브랜치가 이미 로컬에 있으면 `git switch docs/refresh-ai-agent-v81-20260820` 사용.
Node는 호환되는 22 계열을 우선 사용한다. 아래 RHEL 8 기존 runtime의 Node 18 예외를 혼동하지 않는다.
기본 브랜치 2.4.1을 그대로 빌드하거나 npm latest를 구버전으로 덮어쓰지 않는다.
브랜치 통합·릴리스 재발행은 이번 문서 인계에서 수행하지 않았다.
이 문서는 기본 브랜치 README와 docs 인덱스에서도 찾아갈 수 있다.

## 2. 이번에 직접 확인한 상태

| 대상 | 2026-11-16 관측 | 해석 |
|---|---|---|
| 30 / au2223-server | 유선 192.168.33.30, Wi-Fi 192.168.0.30 | 작업·개발 호스트 |
| 30 / PM2 | `pm2 jlist` = 빈 배열 | 이 사용자 PM2에 AI Agent 없음 |
| 30 / 프로세스 | RemoteAgent 실행, appback-ai-agent 실행 프로세스 미검출 | 대화 담당 도구는 실행 중 |
| 30 / 기존 소스 | `/home/au2223/projects/appback-ai-agent` 없음 | 예전 경로에 의존하면 안 됨 |
| 30 / 이번 clone | `/home/au2223/workspaces/remoteagent/u1cqarvy/appback-ai-agent` | 문서 작성 checkout |
| storage-40 / appback | SSH 성공, ai-agents 폴더 없음, appback-ai-agent 프로세스 0 | 과거 10개 배포와 다름; 삭제 원인·백업은 미확인 |
| storage-50 / daone | SSH 성공, Node 18 PM2 ai-agent-01~10 모두 online | 10개 로컬 DB UUID도 확인 |
| storage-50 / 설치 | `/home/daone/ai-agent-runtime/node_modules/appback-ai-agent` 2.5.5 | 기존 로컬 설치 |
| 30 / 사용자 systemd | user bus 연결 실패 | user unit 실제 상태 확인 못함 |
| 30 / retired 설정 | `~/.config/retired-ai-agent` 존재, 읽기 권한 없음 | 내용 미확인; 삭제 금지 |

2026-10-14의 “20/20 정상”은 과거 검증이다. 현재 20개 유지·GC 게임 참여를 재검증한 결과로
인용하지 않는다. 이번에는 PM2·프로세스·DB identity·설치 버전을 확인했으며,
GC API 인증/게임 상태는 재검증하지 않았다. 40 서버의 10개 복원 여부는 별도 실행 작업이다.

30 서버의 cron에는 과거 openclaw 일일 게임 보고와 다른 Hub 지원 세션 작업이 남아 있다.
서비스 담당과 실행 여부를 확인한 뒤 해당 작업만 이관한다.
RemoteAgent·Hub·다른 세션·Docker를 일괄 중지하거나 PM2 all 삭제를 하지 않는다.

## 3. 30 서버에 남아 있는 데이터

| 파일 | 로컬 UUID / 이름 | game_sessions 행 수 |
|---|---|---:|
| `/home/au2223/data/agent.db` | `2f019f5e-fdcc-476b-96ce-76eb3046ac3d` / crab-54347eb5 | 0 |
| `/home/au2223/my-agent/data/agent.db` | `bf24a776-d4eb-4523-9457-40804aeb7082` / appback-ai-001 | 6 |

첫 DB는 약 540 MB지만 game_sessions는 0이다. 파일 크기만으로 학습 데이터 존재를 판단하지 않는다.
다른 테이블·모델·WAL·백업 존재와 유효성은 별도 점검한다.
첫 UUID는 과거 storage-40 agent-06과 같다. 두 위치를 동시에 켜면 안 된다.

후임자는 `~/data`, `~/models`, `~/config`, `~/training`, `~/my-agent`,
권한 제한된 retired 설정, 예전 소스/백업 경로를 선별 조사한다.
계정 홈 전체를 통째로 Git에 넣지 않는다. 이번 문서 작업에서는 원본 DB를 수정·삭제하지 않았다.

## 4. 20개 배포의 과거 UUID 매핑

40 서버 값은 2.5.5 배포 브랜치의 과거 인벤토리에서 가져온 복원 기준이며 현재 로컬 확인값이 아니다.
50 서버 값은 이번에 read-only SQLite 조회로 확인했다.

| 번호 | storage-40 과거 UUID | storage-50 현재 DB UUID |
|---|---|---|
| 01 | 3ad475b0-4349-4fdb-ad20-6d4960cfd657 | 832ed49b-6863-4a18-bef5-78a8d65aeba4 |
| 02 | 2dd74a56-da74-4be1-8728-6b468d1378d9 | 47664dc2-76ff-4db4-889f-81dc7d33ceb7 |
| 03 | 1f34666e-fd99-4498-9046-c3cfe856d2b7 | ddd00a01-fd73-4889-873f-ecbfb60b8b84 |
| 04 | efc0121b-d36b-49b5-a5ae-f8bd0162ebb2 | 2d80f359-7f67-41e0-a950-5de477acbd7d |
| 05 | 11ede365-92a6-4076-9259-2f8cac20a0df | 9b7bb054-5e6a-4efc-a5a2-bdde00c2dc56 |
| 06 | 2f019f5e-fdcc-476b-96ce-76eb3046ac3d | ef8b137c-75f6-42a8-bcfc-fe2b8895e64d |
| 07 | b19f74ba-d7af-4824-b69d-dfb0b7468ba4 | 40b35860-b032-469a-bef9-f4cb6571846a |
| 08 | 170023c2-b45e-4b5d-9bb2-52f387c77906 | 4eb3e9d6-82ab-47fe-8424-2a01567a186c |
| 09 | b13d0b0d-83f1-4f33-a52f-d4ed1d4433c6 | 3e19fbd5-27c0-459d-9ba6-38d1dbbe305e |
| 10 | b386357f-8340-4058-b891-d732d0f8c9d9 | da54150c-e3f0-4aef-8df5-2bebacca670b |

40의 과거 백업 후보:
`/home/appback/ai-agent-backups/pre-2.5.1*`、
`/home/appback/ai-agent-backups/pre-existing-six-restore.QjLxT7`。
50의 과거 백업 후보: `/home/daone/ai-agent-backups/pre-2.5.1`。
이번에 백업 내용·존재·복원 가능성은 확인하지 않았다.

## 5. 인증·대기열·학습의 확정 계약

1. 로컬 UUID 없으면 AI Rewards에서 UUID/JWT를 받는다.
2. 기존 UUID가 있으면 보존해서 AI Rewards에서 같은 UUID의 JWT를 받는다.
3. AI Rewards JWT로 GC에 접속한다.
4. 로컬 UUID = JWT sub = GC UUID여야 한다. 불일치 시 저장·참가 차단.
5. ARW 코드는 소유주 연결에만 쓴다. 이메일·계정·ARW를 UUID/JWT 발급 조건으로 붙이지 않는다.
6. Face·모델·전적·보상은 기존 UUID 연동을 유지한다. 새 UUID 생성으로 대체하지 않는다.
7. GC 대기열에 있으면 계속 기다린다. 30초 poll은 상태 조회다.
   2분 경과를 이유로 탈퇴/재신청해서 FIFO 순서를 잃게 하면 안 된다.
8. JWT 만료·거부 시 재발급한다. 일시 실패는 60초부터 최대 900초 backoff로 재시도하고
   PM2 초기화 실패 루프를 만들지 않는다.
9. 관리 대상 runtime은 무학습: 학습 feed와 자동학습을 둘 다 끈다.

2.5.5 배포 브랜치에서 확인할 코드:
`src/auth/AiRewardsAgentAuthClient.js`, `issueCanonicalAgent.js`, `agentJwt.js`,
`src/adapters/gc/GcAdapter.js`, `GcApiClient.js`, `src/data/storage/SqliteStore.js`。
Hub UUID 발급 구현은 별도 저장소 `https://github.com/appback/appback-platform.git`의
`appback-hub/apps/api/services/aiRewardsService.js`에 있다.
과거 운영 배포 커밋 `65fe4b991b30ee6a40d4a3cd15458ec70a4bd045`는 이력이며
현재 Hub 운영 버전이라고 단정하지 않는다.

권장 runtime 설정:
```dotenv
AI_REWARDS_API_URL=https://appback.app/api/v1
GC_API_URL=https://gc-v2-api.appback.app/api/v1
GC_WS_URL=https://gc-v2-api.appback.app
GC_TRAINING_SYNC_ENABLED=false
GC_V81_AUTO_TRAIN_ENABLED=false
GAME_DISCOVERY_INTERVAL_SEC=60
GC_QUEUE_POLL_INTERVAL_SEC=30
GC_AUTH_RETRY_BASE_SEC=60
GC_AUTH_RETRY_MAX_SEC=900
DATA_DIR=./data
MODEL_DIR=./models
```

배포 브랜치 .env.example은 학습 관련 기본값이 true이므로 무학습 설정을 명시적으로 덮어쓴다.
각 인스턴스의 config/data/models 및 health 포트를 독립시킨다.
저장 JWT가 있으면 환경변수로 옛 JWT를 덮어쓰지 않는다.

## 6. 새 담당 서버에서 필요한 접근

clone만으로 문서와 코드 작업은 이어갈 수 있다.
실제 운영 제어·기존 identity 이전에는 Git 외부의 비밀정보와 데이터가 필요하다.
비밀정보를 Git에 커밋해 clone만으로 접근되게 만들면 안 된다.

SSH 별칭 (새 계정의 ~/.ssh/config에 기존 항목을 보존하며 병합):
```sshconfig
Host storage-40
    HostName 192.168.33.40
    User appback
    IdentityFile ~/.ssh/dev_to_storage_ed25519
    IdentitiesOnly yes
    RequestTTY no

Host storage-50
    HostName 192.168.33.50
    User daone
    IdentityFile ~/.ssh/dev_to_storage_ed25519
    IdentitiesOnly yes
    RequestTTY no
```

전용 SSH 개인키는 보안 경로로 별도 제공하거나 새 키를 대상 authorized_keys에 등록한다.
Git에는 개인키·JWT·DB·.env·npm 토큰·RemoteAgent 세션 원문을 넣지 않는다.
권한은 ~/.ssh 700, config·개인키 600.
restrict 키이므로 원격 명령·SCP/SFTP를 사용하며 host key는 신뢰 가능한 지문과 대조한다.

```bash
ssh -T storage-40 'hostname; id -un'
ssh -T storage-50 'hostname; id -un'
ssh -T storage-50 'export PATH=/home/daone/.nvm/versions/node/v18.20.8/bin:/usr/bin:/bin; pm2 status'
```

50에는 Node 18/20/22가 공존한다. PM2와 better-sqlite3 7.6.2는 현재 Node 18 환경에서 확인했다.
Node 22로 nvm use만 하면 pm2를 못 찾을 수 있다. 기존 native module을 다른 ABI로 바로 실행하지 않는다.
새 OS에서는 지원되는 Node 및 native dependency 조합으로 새로 설치·검증한다.

npm 게시 계정은 appbackhub, 비밀 키 이름은 `NPM_TOKEN`.
RemoteAgent 환경에서는 `node "$REMOTEAGENT_SECRET_BIN" get NPM_TOKEN`으로 프로세스 내부에서 읽는다.
새 환경에는 같은 비밀관리 시스템에 재등록하고 임시 npm 설정으로 인증한다.
공개 패키지 설치에는 게시 토큰이 필요 없다.
만료된 ~/.npmrc 하드코딩 토큰에 의존하지 말고 토큰 값을 출력하거나 명령 인자로 노출하지 않는다.

과거 토큰 IP 제한 125.132.17.159/32와 작업 호스트의 Wi-Fi 출구 59.13.101.109가 달라
403이 발생했다. 새 서버의 실제 출구·라우팅을 먼저 확인하고 그 IP를 허용한다.
이 문서의 과거 IP를 새 서버의 현재 출구라고 가정하지 않는다.
30의 192.168.33.30은 유선 내부 주소이고 192.168.0.30은 Wi-Fi 주소다.

RemoteAgent 담당 세션 이관도 필요하면 새 서버에서 봇/세션/Secret 접근을 별도 설정한다.
기존 S080 대화 복원 없이 이 문서로 개발·운영 맥락을 이어갈 수 있게 작성했다.
도구 설치·API 인증은 환경 의존이며 이 Git 저장소가 제공하지 않는다.

## 7. 실제 데이터 이전 순서

새 목적지 주소·계정은 아직 지정되지 않았다. 후임자가 확인하고 아래 순서로 진행한다.

1. 작업 호스트만 이전하는지, 게임 runtime까지 이전하는지 확정한다.
   작업 호스트만 이전하면 storage-50 프로세스는 그대로 두고 clone·접근 설정만 옮긴다.
2. 원본별 UUID/경로/소유자/설정/모델 파일/스케줄을 기록하고 목적지 디스크·native dependency를 준비한다.
3. 단일 인스턴스별로 소스를 정지하거나 SQLite online backup API로 일관된 백업을 만든다.
   실행 중 agent.db 하나만 cp하면 WAL에 남은 변경을 잃을 수 있다.
4. .env와 config/models/data를 제한된 권한으로 별도 전송한다.
   SQLite를 쓸 수 있는 호스트의 예:
   `umask 077; sqlite3 /정확한/원본/agent.db ".backup '/정확한/백업/agent.db'"`
   백업의 `PRAGMA integrity_check;` 및 SHA-256을 확인한다.
   CLI가 없으면 해당 Node ABI의 better-sqlite3 backup API를 사용한다.
5. 목적지에서 백업 DB의 game/agent_id/name만 read-only 조회해 원본과 일치하는지 확인한다.
   비밀 토큰 컬럼은 출력하지 않는다.
6. 목적지 계정 전용 runtime root에 appback-ai-agent@2.5.5를 설치한다.
   원본 node_modules/native binary는 복사하지 않는다.
7. 원본의 해당 UUID 프로세스와 자동기동을 중지한 뒤 목적지에서 해당 인스턴스만 시작한다.
   학습 비활성 설정·고유 health 포트·올바른 cwd를 확인한다.
8. GC 인증·JWT sub·대기열 상태·실제 게임 배정·재시작 수를 확인한다.
   먼저 1개로 검증한 뒤 나머지를 순차 전환한다.
9. 목적지 PM2 save와 새 경로의 부팅 자동시작 설정을 검증한다.
   이전 사용자의 PM2 dump를 그대로 복사하면 절대경로·Node interpreter가 틀릴 수 있다.
10. 합격 후에만 30의 프로젝트·불필요 자동실행·데이터를 정확한 목록으로 정리한다.
    백업 위치와 보관기간을 기록하고 복원 가능한 사본을 남긴다.

현재 30의 /home/au2223/data/agent.db는 과거 40 agent-06과 같은 UUID다.
40 백업이나 다른 호스트에 같은 UUID가 살아 있지 않은지 먼저 확인한다.
기존 UUID를 잃은 경우 새 UUID를 발급해 복원 완료라고 보고하지 않는다.

롤백: 목적지의 해당 프로세스를 먼저 중지하고, 원본의 원래 cwd·설정·identity 백업으로
해당 UUID 하나만 재개한다. 서버 쪽 신규 게임·모델 기록은 로컬 파일 복원만으로 되돌아가지 않는다.

## 8. 인계 수락 체크와 남은 작업

- clone한 기본 README에서 이 문서로 진입 가능.
- 올바른 배포 브랜치/태그에서 버전 확인 및 npm test 수행.
- 원격 별칭 접속과 목적지 Secret Store 설정 완료.
- 원본·목적지 UUID 대응표, DB integrity/checksum 일치.
- 각 JWT의 sub/만료/issuer를 값 노출 없이 검증하고 GC /agents/me 응답 UUID와 대조.
- 각 JWT로 /queue/status HTTP 200, queued 또는 실제 게임 배정 확인.
  queue 상태만 idle이면 게임 참여 여부를 추가 조회해 정상으로 단정하지 않는다.
- PM2 online 개수만으로 완료 판단하지 말고, 재시작 수 증가·401 루프·모델 연결을 점검.
- 40의 10개 복원 범위/백업 확보 여부를 별도 확정. 현재 확인된 runtime은 50의 10개.
- 30의 잔존 DB 및 권한 제한된 retired 설정을 보존할지 확정.
- 이전 대상·실행일·커밋·검증 결과·삭제/보관 목록을 이 문서에 추가.

과거 배포 브랜치 docs/operations/AGENTS.md에 20개 상세 이력이 있다.
master의 기존 AGENTS/INSTALL/DEPLOYMENT 문서에는 7월 당시 호스트·인증 정보가 있어,
현재 운영 기준으로 무비판적으로 실행하지 말고 본 문서 및 배포 브랜치 코드와 대조한다.
