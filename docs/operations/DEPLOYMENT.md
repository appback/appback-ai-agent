# Deployment

npm 배포 + 운영 에이전트 업데이트 절차.

---

## npm Publish

```bash
cd ~/projects/appback-ai-agent

# 버전 업
# (semver: patch = fix, minor = feature, major = breaking)
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

JWT 전환 배포 전 각 인스턴스에서 `data/agent.db`, `models/`, `training/`, `.env`를
백업하고 현재 `agent_identity.agent_id`를 기록한다. AI Rewards는 이 로컬 UUID 그대로
JWT를 발급하며 AI Agent 인증에는 이메일·소유주·등록 코드를 사용하지 않는다.

각 인스턴스의 안전한 순서는 다음과 같다.

```bash
pm2 stop ai-agent
pm2 restart ai-agent
appback-ai-agent doctor
```

기동 시 AI Rewards·SQLite·GC UUID가 다르면 DB·모델을 복원하거나 지우지 말고 중단한다.
정상 전환은 JWT만 교체하며 기존 UUID와 자산을 유지한다.

### Standard (Ubuntu 글로벌 설치)

```bash
# 로컬 머신 (.30)
npm cache clean --force
npm install -g appback-ai-agent@latest
pm2 restart ai-agent
appback-ai-agent doctor

# .20
ssh au2222@192.168.0.20 "
  export PATH='/home/au2222/.nvm/versions/node/v22.22.0/bin:/usr/bin:/bin:\$PATH'
  npm cache clean --force
  npm install -g appback-ai-agent@latest
  pm2 restart ai-agent
  appback-ai-agent doctor
"

# DAONE-PC (직접 콘솔에서)
npm cache clean --force
npm install -g appback-ai-agent@latest
pm2 restart ai-agent
appback-ai-agent doctor
```

### RHEL 8 / 로컬 디렉토리 (.26)

```bash
ssh ospadmin@192.168.0.26 '
  export NVM_DIR="$HOME/.nvm"
  . "$NVM_DIR/nvm.sh"
  cd ~/ai-agent
  npm install appback-ai-agent@latest
  pm2 restart ai-agent
  npx appback-ai-agent doctor
'
```

### Dev 빌드 (.30 소스 실행)

소스에서 직접 실행 중이므로 git pull + 재시작만:
```bash
cd ~/projects/appback-ai-agent
git pull
pm2 restart appback-ai-agent-dev
appback-ai-agent doctor
```

### Runtime-only Docker workers

학습과 training feed 수집을 실행하지 않는 `hunter`, `survivor`, `navigator` worker
3개를 독립적으로 실행한다.

```bash
git clone https://github.com/appback/appback-ai-agent.git
cd appback-ai-agent
docker compose -f docker-compose.runtime.yml build
```

각 worker는 독립 volume의 UUID로 AI Rewards JWT를 자동 발급·갱신한다.

```bash
docker compose -f docker-compose.runtime.yml up -d
```

- `GC_V81_AUTO_TRAIN_ENABLED=false`: 로컬 자동학습·후보 업로드 중지
- `GC_TRAINING_SYNC_ENABLED=false`: GC authoritative frame/result를 로컬에 수집하지 않음
- `APPBACK_AGENT_VARIATION=15`: 최초 생성 시 profile별 행동·장비 가중치를 random seed로 변형
- 각 service는 config/data/models/training 전용 named volume 사용
- identity와 token은 각 SQLite volume에 개별 저장되며 로그에 출력하거나 공유하지 않음
- AI Rewards/SQLite/GC UUID 불일치 시 worker가 fail-closed하며 volume을 초기화하지 않음
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
npm install -g appback-ai-agent@<approved-version>
pm2 restart ai-agent
```

package rollback은 binary만 바꾸며 operation/data/model contract를 자동으로 되돌리지 않는다.
`operation verify`가 실패하면 기존 `operation.json`과 세대가 맞는 승인 버전을 사용해야 한다.
canonical JWT 전환 후에는 익명 GC 등록이나 구형 `cr_agent_` 인증을 사용하는 버전으로
rollback할 수 없다. 같은 UUID의 AI Rewards JWT를 지원하는 승인 버전만 사용한다.

---

## v8.1 Model Rollout

v8.1 모델을 legacy `POST /agents/me/model`로 직접 hot-swap하지 않는다. AI Agent가
authoritative session을 export·학습·평가한 뒤 metadata와 함께
`POST /agents/me/models/v8`에 immutable 후보 revision을 업로드한다.

```bash
npx appback-ai-agent operation verify
npx appback-ai-agent export
npx appback-ai-agent train
```

GC가 `model_auto_rollout=true`를 광고하면 canary와 30게임 runtime gate를 수행하고 통과한
revision만 active로 전환한다. 수동 active/rollback은 GC 관리자 절차와 audit를 사용한다.

---

## Verification Checklist

업데이트 후 확인 항목:

1. **버전 확인**
   ```bash
   appback-ai-agent version
   ```

2. **기동 로그**
   ```bash
   pm2 logs ai-agent --lines 30 --nostream | grep "starting\|Operation contract\|GC contract\|Canonical agent active\|server-owned"
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
curl -s https://gc-v2-api.appback.app/api/v1/agents/me/models/v8 \
  -H "Authorization: Bearer $TOKEN" | jq
```

잘못된 v8 후보를 legacy delete API로 제거하지 않는다. rejected/rollback 상태와 active pointer는
GC revision audit를 보존하는 관리자 절차로 변경한다.
