# Deployment

npm 배포 + 운영 에이전트 업데이트 절차.

---

## npm Publish

```bash
cd ~/projects/appback-ai-agent

# 버전 업
# (semver: patch 2.2.x = fix, minor 2.x.0 = feature, major x.0.0 = breaking)
vim package.json   # version 수정

# 변경 사항 커밋
git add -A
git commit -m "..."
git push origin master

# npm 배포 (appbackhub 계정)
npm publish
```

npm 인증 정보는 `~/.npmrc`에 토큰으로 저장됨. 401/403 시 토큰 갱신 필요.

---

## Update All Agents

### Standard (Ubuntu 글로벌 설치)

```bash
# 로컬 머신 (.30)
npm cache clean --force
npm install -g appback-ai-agent@latest
pm2 restart ai-agent

# .20
ssh au2222@192.168.0.20 "
  export PATH='/home/au2222/.nvm/versions/node/v22.22.0/bin:/usr/bin:/bin:\$PATH'
  npm cache clean --force
  npm install -g appback-ai-agent@latest
  pm2 restart ai-agent
"

# DAONE-PC (직접 콘솔에서)
npm cache clean --force
npm install -g appback-ai-agent@latest
pm2 restart ai-agent
```

### RHEL 8 / 로컬 디렉토리 (.26)

```bash
ssh ospadmin@192.168.0.26 '
  export NVM_DIR="$HOME/.nvm"
  . "$NVM_DIR/nvm.sh"
  cd ~/ai-agent
  npm install appback-ai-agent@latest
  pm2 restart ai-agent
'
```

### Dev 빌드 (.30 소스 실행)

소스에서 직접 실행 중이므로 git pull + 재시작만:
```bash
cd ~/projects/appback-ai-agent
git pull
pm2 restart appback-ai-agent-dev
```

### Runtime-only Docker workers

학습과 training feed 수집을 실행하지 않는 `hunter`, `survivor`, `navigator` worker
3개를 독립적으로 실행한다.

```bash
git clone https://github.com/appback/appback-ai-agent.git
cd appback-ai-agent
docker compose -f docker-compose.runtime.yml up --build -d
docker compose -f docker-compose.runtime.yml ps
```

- `GC_V81_AUTO_TRAIN_ENABLED=false`: 로컬 자동학습·후보 업로드 중지
- `GC_TRAINING_SYNC_ENABLED=false`: GC authoritative frame/result를 로컬에 수집하지 않음
- `APPBACK_AGENT_VARIATION=15`: 최초 생성 시 profile별 행동·장비 가중치를 random seed로 변형
- 각 service는 config/data/models/training 전용 named volume 사용
- identity와 token은 각 SQLite volume에 개별 저장되며 로그에 출력하거나 공유하지 않음
- 기존 PM2 또는 다른 Compose project의 container/volume은 변경하지 않음

검증:

```bash
docker compose -f docker-compose.runtime.yml ps
docker compose -f docker-compose.runtime.yml logs --tail=100
docker inspect appback-ai-agent-hunter --format '{{.State.Health.Status}} {{.RestartCount}}'
```

---

## Rollback

특정 버전으로 되돌리기:
```bash
npm install -g appback-ai-agent@2.1.3
pm2 restart ai-agent
```

---

## Model Hot-Swap

학습된 모델을 서버에 즉시 적용:

```bash
TOKEN=$(sqlite3 ~/data/agent.db "SELECT api_token FROM agent_identity WHERE game='claw-clash'")
curl -X POST https://clash.appback.app/api/v1/agents/me/model \
  -H "Authorization: Bearer $TOKEN" \
  -F "model=@$HOME/models/gc/gc_move_model.onnx"
```

성공 응답:
```json
{"success":true,"model_version":N,"input_dim":153,"output_dim":5}
```

서버 측에서 LRU 캐시 무효화 후 다음 게임부터 새 모델 사용.

---

## Verification Checklist

업데이트 후 확인 항목:

1. **버전 확인**
   ```bash
   appback-ai-agent version
   ```

2. **기동 로그**
   ```bash
   pm2 logs ai-agent --lines 20 --nostream | grep "starting\|Registered\|WebSocket"
   ```

3. **게임 참가**
   ```bash
   pm2 logs ai-agent --lines 50 --nostream | grep "Challenge result"
   ```

4. **헬스체크**
   ```bash
   curl http://localhost:9090/health
   ```

---

## Common Operations

### 모든 에이전트 한번에 재시작
각 호스트의 pm2:
```bash
pm2 restart all
```

### 모델 버전 확인 (서버)
```bash
TOKEN=$(sqlite3 ~/data/agent.db "SELECT api_token FROM agent_identity WHERE game='claw-clash'")
curl -s https://clash.appback.app/api/v1/agents/me -H "Authorization: Bearer $TOKEN" | jq '.model_version, .model_uploaded_at'
```

### 잘못된 모델 삭제
```bash
TOKEN=$(sqlite3 ~/data/agent.db "SELECT api_token FROM agent_identity WHERE game='claw-clash'")
curl -X DELETE https://clash.appback.app/api/v1/agents/me/model \
  -H "Authorization: Bearer $TOKEN"
```
삭제 후에는 서버가 폴백 휴리스틱으로 동작.
