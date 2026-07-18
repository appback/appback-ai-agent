# Agent Inventory

운영 중인 ai-agent 인스턴스 전수. **이 문서가 단일 출처(single source of truth).**

---

## Active Agents (6개)

| # | Agent Name | Agent ID | 호스트 | IP / Host | 계정 | 설치 방식 | pm2 이름 |
|---|---|---|---|---|---|---|---|
| 1 | `crab-54347eb5` | 2f019f5e-fdcc-476b-96ce-76eb3046ac3d | 운영 .30 | 192.168.0.30 | au2223 | 글로벌 (`~/`) | `ai-agent` |
| 2 | `crab-11ede365` | 11ede365-92a6-4076-9259-2f8cac20a0df | 개발 .30 | 192.168.0.30 | au2223 | **소스 빌드** (`~/projects/appback-ai-agent/`) | `appback-ai-agent-dev` |
| 3 | `crab-d0cbca48` | b19f74ba-d7af-4824-b69d-dfb0b7468ba4 | 운영 .20 | 192.168.0.20 | au2222 | 글로벌 (`~/`) | `ai-agent` |
| 4 | `crab-a80f0b1e` | b386357f-8340-4058-b891-d732d0f8c9d9 | 운영 .21 | 192.168.0.21 (DAONE-PC WSL Ubuntu) | au212 | 글로벌 (`~/`) | `ai-agent` |
| 5 | `crab-95cf1514` | b13d0b0d-83f1-4f33-a52f-d4ed1d4433c6 | 운영 .26 | 192.168.0.26 (SQream 서버) | ospadmin | **로컬 설치** (`~/ai-agent/`) | `ai-agent` |
| 6 | `crab-5fdf70d6` | 5101bb05-cefb-4659-8f33-7d2e19ee3176 | 운영 EC2 | 43.202.206.43 | ec2-user | 글로벌 (`~/`) | `ai-agent` |

전부 GC(claw-clash) 등록 + AI Rewards 연동 완료.

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

---

## Common Configuration

모든 에이전트 공통:

| 항목 | 값 |
|---|---|
| 서비스 | claw-clash (GC) |
| API | `https://clash.appback.app/api/v1` |
| 자동 학습 임계점 | 50게임 (`AUTO_TRAIN_AFTER_GAMES=50`) |
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
| 2026-07-18 | npm `2.3.2` 게시, #1·#2·#3·#5를 성격별 v8.1로 전환 | 4개 모두 PM2 online/health 정상. GC live game에서 record v2·214/11·inference ok 확인, v8.x legacy viewer WebSocket 비활성화, 구 로컬 데이터와 대상 v7 ONNX 제거. `.30` 누적 PM2 restart `10/15`를 reset한 뒤 3분간 7회 측정에서 PID 고정·restart/unstable/exit 0·ERROR/FATAL 0 확인. 로그 백업 `~/backups/ai-agent-pm2-log-reset-20260718T042106Z`. #4·#6 제외 |
| 2026-07-17 | npm `2.3.0` 게시, #1·#2·#3·#5 패치 후 online/health 정상 | v7 operation `153/5` 유지, GC v8.1 capability 확인. #4는 방화벽으로 로컬 콘솔 작업 대기, #6은 PEM 재전달 대기 |
| 2026-06-09 | EC2 신규 추가, `crab-5fdf70d6` online, doctor 통과 | appback-ai-agent v2.2.1, PyTorch 2.8.0+cpu |
| 2026-05-11 | 5개 모두 online, GC API 응답 정상 | model_version=0 (weapon 수정 후 재학습 미진행), .21만 v1 |

후임자는 이 표에 검증 일자/결과 추가할 것.
