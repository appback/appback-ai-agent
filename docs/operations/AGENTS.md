# Agent Inventory

운영 중인 ai-agent 인스턴스 목록.

---

## Active Agents

| 에이전트 이름 | Agent ID | 호스트 | 계정 | 설치 경로 | pm2 이름 |
|---|---|---|---|---|---|
| `crab-54347eb5` | 2f019f5e-fdcc-476b-96ce-76eb3046ac3d | 192.168.0.30 | au2223 | `~/` (글로벌) | `ai-agent` |
| `crab-11ede365` | 11ede365-92a6-4076-9259-2f8cac20a0df | 192.168.0.30 | au2223 | `~/projects/appback-ai-agent/` (소스) | `appback-ai-agent-dev` |
| `crab-d0cbca48` | b19f74ba-d7af-4824-b69d-dfb0b7468ba4 | 192.168.0.20 | au2222 | `~/` (글로벌) | `ai-agent` |
| `crab-95cf1514` | b13d0b0d-83f1-4f33-a52f-d4ed1d4433c6 | 192.168.0.26 | ospadmin | `~/ai-agent/` (로컬) | `ai-agent` |
| `crab-a80f0b1e` | b386357f-8340-4058-b891-d732d0f8c9d9 | DAONE-PC (WSL Ubuntu) | au212 | `~/` (글로벌) | `ai-agent` |

모든 에이전트는 GC(claw-clash) 서비스에 등록되어 있으며 AI Rewards 연동 완료 상태.

---

## Host Environments

### 192.168.0.30
- 역할: 개발 + 운영
- OS: Ubuntu
- Node: v22.22.0 (nvm)
- 설치 방식: 글로벌 + 소스 빌드 동시 운영
- 개발 소스 위치: `~/projects/appback-ai-agent/` (GitHub 연결)

### 192.168.0.20
- 역할: 운영
- OS: Ubuntu 24.04 (glibc 2.39)
- Node: v22.22.0 (nvm)
- 설치 방식: 글로벌
- SSH: `ssh au2222@192.168.0.20`

### 192.168.0.26 (SQream 서버)
- 역할: 운영
- OS: RHEL 8.9 (glibc 2.28)
- Node: v20.20.2 (nvm) — **22는 빌드 실패**
- 설치 방식: 로컬 디렉토리 + `better-sqlite3 9.6.0` override
- SSH: `ssh ospadmin@192.168.0.26`

### DAONE-PC (WSL Ubuntu)
- 역할: 운영
- OS: WSL Ubuntu (Windows 호스트)
- Node: v22.22.2
- 설치 방식: 글로벌
- 접근: 로컬 콘솔 (원격 SSH 미설정)

---

## Common Configuration

| 항목 | 값 |
|---|---|
| 서비스 | claw-clash (GC) |
| API | `https://clash.appback.app/api/v1` |
| 자동 학습 | 50게임마다 (`AUTO_TRAIN_AFTER_GAMES=50`) |
| 헬스 포트 | 9090 (충돌 시 9091, 9092... 자동 증가) |
| pm2 자동 시작 | `pm2 save` 완료 (서버 재부팅 시 자동 기동) |

---

## SSH Quick Access

```bash
# .20
ssh au2222@192.168.0.20

# .26
ssh ospadmin@192.168.0.26
```

`.20`은 nvm path 설정 필요:
```bash
export PATH='/home/au2222/.nvm/versions/node/v22.22.0/bin:/usr/bin:/bin:$PATH'
```

---

## Health Check

각 에이전트:
```bash
pm2 status
pm2 logs <pm2-name> --lines 20 --nostream
curl http://localhost:9090/health  # 헬스 포트 (충돌 시 +1)
```

서버에서 직접:
```bash
# 토큰 확인
sqlite3 ~/data/agent.db "SELECT name, agent_id, substr(api_token,1,15)||'...' FROM agent_identity"

# 게임 수
sqlite3 ~/data/agent.db "SELECT COUNT(*) FROM game_sessions WHERE result IS NOT NULL"

# 최근 성적
sqlite3 ~/data/agent.db "
SELECT json_extract(result,'\$.rank'), json_extract(result,'\$.kills'), json_extract(result,'\$.score')
FROM game_sessions WHERE result IS NOT NULL
ORDER BY id DESC LIMIT 10"
```
