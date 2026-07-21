# Agent Inventory

운영 중인 ai-agent 인스턴스 전수. **이 문서가 단일 출처(single source of truth).**

---

## Active Agents (9개)

| # | Agent Name | Agent ID | 호스트 | IP / Host | 계정 | 설치 방식 | pm2 이름 |
|---|---|---|---|---|---|---|---|
| 1 | `crab-54347eb5` | 2f019f5e-fdcc-476b-96ce-76eb3046ac3d | 운영 .30 | 192.168.0.30 | au2223 | 글로벌 (`~/`) | `ai-agent` |
| 2 | `crab-11ede365` | 11ede365-92a6-4076-9259-2f8cac20a0df | 개발 .30 | 192.168.0.30 | au2223 | **소스 빌드** (`~/projects/appback-ai-agent/`) | `appback-ai-agent-dev` |
| 3 | `crab-d0cbca48` | b19f74ba-d7af-4824-b69d-dfb0b7468ba4 | 운영 .20 | 192.168.0.20 | au2222 | 글로벌 (`~/`) | `ai-agent` |
| 4 | `crab-a80f0b1e` | b386357f-8340-4058-b891-d732d0f8c9d9 | 운영 .21 | 192.168.0.21 (DAONE-PC WSL Ubuntu) | au212 | 글로벌 (`~/`) | `ai-agent` |
| 5 | `crab-95cf1514` | b13d0b0d-83f1-4f33-a52f-d4ed1d4433c6 | 운영 .26 | 192.168.0.26 (SQream 서버) | ospadmin | **로컬 설치** (`~/ai-agent/`) | `ai-agent` |
| 6 | `crab-5fdf70d6` | 5101bb05-cefb-4659-8f33-7d2e19ee3176 | 운영 EC2 | 43.202.206.43 | ec2-user | 글로벌 (`~/`) | `ai-agent` |
| 7 | `crab-fbcf1e21` | 24553dca-5e05-4b1b-b26b-7e198db3c124 | 운영 EC2 | 43.202.206.43 | Docker | runtime-only `2.4.0` | `appback-ai-agent-hunter` |
| 8 | `crab-15ff868a` | dbc7cf65-1d73-4bf3-8580-e432687769f5 | 운영 EC2 | 43.202.206.43 | Docker | runtime-only `2.4.0` | `appback-ai-agent-survivor` |
| 9 | `crab-ce9c5401` | 3297f076-fd50-48c9-a815-b32c368432cf | 운영 EC2 | 43.202.206.43 | Docker | runtime-only `2.4.0` | `appback-ai-agent-navigator` |

9개 모두 GC(claw-clash)에 등록됐다. #1~#6의 AI Rewards 연동은 기존 상태를 유지하며,
#7~#9는 별도 등록 코드를 적용하지 않은 신규 GC identity다.

### v8.1 운영 전환 상태

2026-07-18 기준 접근 가능한 #1, #2, #3, #5는 `appback-ai-agent@2.3.2`와
`gc-v8-strategy-r1`로 전환했다. GC는 agent별 `go` runtime과
`same_profile_only` active revision을 사용한다.

| Agent | Personality | Profile revision | Feature / output |
|---|---|---:|---|
| `crab-54347eb5` | `balanced` | 1 | `8.1 / 214 -> 11` |
| `crab-11ede365` | `navigator` | 1 | `8.1 / 214 -> 11` |
| `crab-d0cbca48` | `hunter` | 1 | `8.1 / 214 -> 11` |
| `crab-95cf1514` | `survivor` | 1 | `8.1 / 214 -> 11` |

전환 시 각 로컬 DB의 신원·토큰 1건은 유지하고 구 session/tick/training/loadout
row와 구 이동 ONNX를 제거했다. #4(.21)와 #6(EC2)는 소유자 지시에 따라 이번 전환
범위에서 제외했으며 현재 상태를 이 표의 네 인스턴스와 혼동하지 않는다.

2026-07-21에 #7~#9를 runtime-only Docker worker로 추가했다. 세 worker는 각각
`hunter`, `survivor`, `navigator` profile이며, 서로 다른 random seed와 최대 `15%`
Easy variation을 적용한 revision 2다. variation은 매 틱 무작위 행동이 아니라 공격·도주·
추격·탐색·장비 가중치를 최초 설정 시 한 번 변형한다. 대응하는 `8.1 / 214 -> 11`
synthetic bootstrap revision이 각각 canary다. `GC_V81_AUTO_TRAIN_ENABLED=false`로 로컬
학습과 학습 후보 업로드를 하지 않고, `GC_TRAINING_SYNC_ENABLED=false`로 authoritative
training feed도 내려받지 않는다. synthetic canary는 운영 active/known-good 승격
대상이 아니다.

| Agent | Profile | Variation / seed | Profile hash | Canary revision |
|---|---|---|---|---|
| `crab-fbcf1e21` | `hunter` r2 | `15% / 3064748555` | `sha256:3f65801fc39f1b10a5528c071661abca5b7d9ffd6ac8a24fd889c7149ecf92f4` | `213af56b-27bf-4284-82ad-82cd454b8fff` |
| `crab-15ff868a` | `survivor` r2 | `15% / 3237892811` | `sha256:36e6f03cdb7afb4de32ae012866bbb977ef3a38bc3edb6eef8b26134e4b7826c` | `01e41fbb-8356-4f2c-8c85-be3999457f1c` |
| `crab-ce9c5401` | `navigator` r2 | `15% / 2543031196` | `sha256:d8ab4e8a03fbaf7f115b25491c75b97776e45c382c5926a61a311cfb63bd95b9` | `5d157128-3325-4a71-a64c-d1a391329fe7` |

최초 variation 0의 r1 synthetic canary는 r2 전환 시 `rolled_back` 처리했고,
`agent_model_revision_audit`에 system canary 전환 사유를 기록했다.

2026-07-18 재점검에서 #1, #2, #3, #5의 활성 경로에 남아 있던
`gc-v7-path-aware-r1` operation history, `153 -> 5` `gc_move_net` metadata,
generation ONNX와 #3의 `gc_move_model_single.onnx`를 추가 제거했다. 삭제 전 파일과
과거 PM2 로그는 각 호스트의 `~/backups/ai-agent-v7-cleanup-*` 및
`~/backups/ai-agent-v7-log-cleanup-*`에 체크섬과 함께 격리했다. 현재
`operation.json`, v8.1 training feed DB, GC 서버의 v8.1 active revision은 제거 대상이
아니다.

---

## Host별 상세

### .30 — 개발 + 운영 호스트 (192.168.0.30)
- 같은 호스트에 **2개 에이전트 동시 운영**
- 접근: 로컬 (au2223 계정으로 직접)
- OS: Ubuntu
- Node: v22.22.0 (nvm)
- 운영 에이전트(#1): 글로벌 npm 설치, pm2 이름 `ai-agent`
- 개발 에이전트(#2): GitHub 소스 빌드, pm2 이름 `appback-ai-agent-dev`
  - 코드 위치: `~/projects/appback-ai-agent/` (GitHub origin 연결)
  - 코드 수정 후 git pull + pm2 restart로 즉시 반영
- 데이터 위치 (운영): `~/data/agent.db`, `~/models/gc/`
- 데이터 위치 (개발): `~/projects/appback-ai-agent/data/agent.db`, `~/projects/appback-ai-agent/models/gc/`

### .20 — 운영 호스트 (192.168.0.20)
- 접속: `ssh au2222@192.168.0.20`
- OS: Ubuntu 24.04 (glibc 2.39)
- Node: v22.22.0 (nvm) — path 수동 설정 필요
  - `export PATH='/home/au2222/.nvm/versions/node/v22.22.0/bin:/usr/bin:/bin:$PATH'`
- 설치: 글로벌 npm

### .21 — 운영 호스트 (192.168.0.21, DAONE-PC)
- 환경: Windows 호스트 + WSL Ubuntu (mirrored networking mode)
- **원격 SSH 접근 불가** — Windows 방화벽 정책상 외부 인바운드 차단 (정책상 변경 안 함)
- WSL 내부에서 SSH 서비스는 실행 중이고 공개키도 등록됨, 그러나 호스트 방화벽이 22번 차단
- 운영 작업은 **DAONE-PC 로컬 콘솔 직접 접근** 필요:
  - PowerShell에서 `wsl` 입력 → WSL Ubuntu 셸 진입
  - WSL 셸 내부에서 작업 (PowerShell에서 sudo/apt 등 Linux 명령 실행 안 됨)
- 계정: au212 (WSL 내부)
- Node: v22.22.2 (nvm)
- 설치: 글로벌 npm

### .26 — 운영 호스트 (192.168.0.26, SQream 서버)
- 접속: `ssh ospadmin@192.168.0.26`
- OS: RHEL 8.9 (glibc **2.28**) — 특수 환경
- Node: **v20.20.2** (nvm, 22는 빌드 실패)
- 설치: **로컬 디렉토리 (`~/ai-agent/`)** + `better-sqlite3` 9.6.0 override
- 이유: glibc 2.28에서 better-sqlite3 11.x prebuilt 호환 안 됨

### EC2 — 운영 호스트 (43.202.206.43)
- 접속: `ssh ec2-user@43.202.206.43` (dadp-prod.pem)
- OS: Amazon Linux 2023 (glibc 2.34)
- Node: v22.22.0 (nvm)
- 설치: 글로벌 npm (`appback-ai-agent@2.2.1`)
- PM2: `ai-agent`, systemd `pm2-ec2-user.service` enabled/active
- 데이터 위치: `~/data/agent.db`, `~/models/gc/`
- 자동학습 Python: `~/.venv/bin/python3` (`torch 2.8.0+cpu`)
- runtime-only Docker worker:
  - source commit: `21f5f3e75e2f00b351de4cd1c3c881c7c2cddab3`
  - image: `appback-ai-agent:2.4.0-runtime`
  - image ID: `sha256:50ead1e2ff31ebbd8ab2f20bd57ca322da42119b36c8a2602ea9659f7ce4b0ed`
  - Compose project: `appback-ai-agent-workers`
  - 각 worker는 config/data/models/training 전용 named volume 사용
  - 기존 PM2 `ai-agent`와 데이터·프로세스·재시작 정책을 공유하지 않음

---

## Common Configuration

모든 에이전트 공통:

| 항목 | 값 |
|---|---|
| 서비스 | claw-clash (GC) |
| API | `https://clash.appback.app/api/v1` |
| v8.1 자동 학습 | 성격별 완료 50게임마다 학습·평가·후보 업로드 (`AUTO_TRAIN_AFTER_GAMES=50`) |
| 헬스 포트 | 9090 (충돌 시 +1 자동 증가) |
| pm2 자동 재시작 | `pm2 save` 적용 (재부팅 시 자동 기동) |

---

## Quick Operations

### 토큰 / 게임 수 확인 (각 서버에서 실행)

```bash
sqlite3 ~/data/agent.db "SELECT name, agent_id FROM agent_identity"
sqlite3 ~/data/agent.db "SELECT COUNT(*) FROM game_sessions WHERE result IS NOT NULL"
```

`.26`은 `~/ai-agent/data/agent.db`, `.30 dev`는 `~/projects/appback-ai-agent/data/agent.db`

### 모델 버전 확인 (서버 측)

```bash
TOKEN=$(sqlite3 ~/data/agent.db "SELECT api_token FROM agent_identity WHERE game='claw-clash'")
curl -s https://clash.appback.app/api/v1/agents/me -H "Authorization: Bearer $TOKEN" | jq '.name, .model_version, .model_uploaded_at'
```

### pm2 상태

```bash
pm2 status
pm2 logs ai-agent --lines 20 --nostream
```

### 업데이트 (각 환경별)

상세는 [DEPLOYMENT.md](DEPLOYMENT.md) 참조.

---

## 검증 이력

| 일자 | 결과 | 비고 |
|---|---|---|
| 2026-07-21 | EC2에 runtime-only Docker worker 3개 추가 | `hunter/survivor/navigator` 모두 v2.4.0, random seed와 15% variation r2 적용, GC 등록·challenge·queue·8.1 synthetic canary 성공. 자동학습과 feed sync 모두 false, 기존 수집 session/frame/result와 cursor 제거, container healthy/restart 0, ERROR/FATAL 0. 기존 PM2 `ai-agent` online/restart 0 유지 |
| 2026-07-18 | npm `2.3.3` 게시, #1·#2·#3·#5에 v8.1 자동학습 배포 | 성격별 완료 50게임마다 `same_profile_only` export→214/11 학습→offline gate→immutable 후보 업로드를 수행하고 자동 active는 하지 않는다. 네 호스트 doctor 통과, 실제 navigator 10게임·376 frame 학습 accuracy 0.855263·invalid 0·gate 7/7, 전체 테스트 68/68 통과. 배포 후 30초 간격 7회 PID 고정·restart/unstable/exit 0·health ok. 안정성 로그 SHA-256 `144807bb3c50a1c8a7b5bfc8421f818f8de1795c27d2b8f31d9bee98ca73ea88`. #4·#6 제외 |
| 2026-07-18 | npm `2.3.2` 게시, #1·#2·#3·#5를 성격별 v8.1로 전환 | GC live game에서 record v2·214/11·inference ok 확인. 활성 경로의 v7 history·metadata·generation ONNX와 과거 오류 로그를 체크섬 백업 후 제거했다. 네 인스턴스를 30초 간격 7회 재측정해 PID 고정·PM2 restart/unstable/exit 0·health ok·신규 ERROR/FATAL 0을 확인했다. 안정성 로그 SHA-256 `4887a2e762227dfab93a82f9ec3026fe9b92b387088759946fa0059f6c9e2b9c`. #4·#6 제외 |
| 2026-07-17 | npm `2.3.0` 게시, #1·#2·#3·#5 패치 후 online/health 정상 | v7 operation `153/5` 유지, GC v8.1 capability 확인. #4는 방화벽으로 로컬 콘솔 작업 대기, #6은 PEM 재전달 대기 |
| 2026-06-09 | EC2 신규 추가, `crab-5fdf70d6` online, doctor 통과 | appback-ai-agent v2.2.1, PyTorch 2.8.0+cpu |
| 2026-05-11 | 5개 모두 online, GC API 응답 정상 | model_version=0 (weapon 수정 후 재학습 미진행), .21만 v1 |

후임자는 이 표에 검증 일자/결과 추가할 것.
