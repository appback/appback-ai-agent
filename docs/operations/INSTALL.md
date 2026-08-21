# Installation

신규 서버에 appback-ai-agent를 설치하고 AI Rewards canonical identity로 GC에 참가시킨다.

---

## Prerequisites

- Linux 서버 (또는 WSL Ubuntu)
- 인터넷 접근 (`registry.npmjs.org`, `appback.app`, `gc-v2-api.appback.app`)
- glibc 2.29+ 권장 (RHEL 8/glibc 2.28은 [예외 절차](#rhel-8--glibc-228) 참조)

---

## Standard Installation

```bash
# 1. Node.js 22 (nvm)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
nvm install 22
nvm alias default 22

# 2. ai-agent + pm2
npm install -g appback-ai-agent pm2

# 3. 작업 디렉토리 초기화
cd ~
appback-ai-agent init

# 4. PyTorch + 학습 의존성 (자동 학습용)
python3 -m venv ~/.venv-aiagent
source ~/.venv-aiagent/bin/activate
pip install torch numpy pandas scikit-learn onnx onnxscript
deactivate
echo "PYTHON_PATH=$HOME/.venv-aiagent/bin/python3" >> ~/.env

# 5. 환경 점검
appback-ai-agent doctor

# 6. 실행 — UUID/JWT 발급과 GC 등록은 자동
pm2 start "appback-ai-agent start" --name ai-agent --cwd $HOME
pm2 save

# 7. (선택) 부팅 시 자동 시작
pm2 startup
# 출력된 명령어 sudo로 실행
```

---

## Verification

```bash
pm2 logs ai-agent --lines 25 --nostream
```

정상 로그:
```
[main] appback-ai-agent v2.5.1 starting...
[main] Operation contract: gc-v8-strategy-r2 / feature v8.1 (214 dims)
[gc-adapter] GC contract: protocol=1, enforcement=observe, feature=8.1, ...
[gc-adapter] Canonical agent active: agent-name (uuid)
[gc-equip] Catalog: 6 weapons, 4 armors
[gc-adapter] GC server-owned inference active; legacy viewer WebSocket disabled
[main] GC v8 training feed enabled, interval=30s
[gc-adapter] Challenge result: queued
```

AI Rewards, 로컬 SQLite와 GC의 UUID가 같은 경우에만 매칭 큐에 진입한다.

---

## AI Rewards identity

AI Agent는 이메일·소유주·계정 credential을 사용하지 않는다. 첫 `start`에서 로컬 UUID가
없으면 AI Rewards가 UUID와 GC용 JWT를 발급한다. 기존 UUID가 있으면 같은 UUID로 JWT를
발급하므로 Face·모델·전적을 유지한다.

```bash
appback-ai-agent start
```

JWT 만료 시에도 로컬 UUID와 현재 에이전트 credential로 자동 재발급한다. credential이 폐기되었거나
검증되지 않으면 fail-closed한다. AI Rewards·SQLite·GC UUID가 다르면
저장과 게임 참가를 중단하며 UUID를 임의 교체하지 않는다.

---

## RHEL 8 / glibc 2.28

`ldd --version`이 **2.28 이하**이면 `better-sqlite3` 11.x prebuilt 호환 안 됨.

```bash
# RHEL 8.10 실측 호환 조합: Node 18 + better-sqlite3 7.6.2
nvm install 18
nvm alias default 18
npm install -g pm2

# 로컬 디렉토리 + glibc 2.28 호환 override
mkdir -p ~/ai-agent && cd ~/ai-agent
npm init -y
npm pkg set dependencies.appback-ai-agent=latest
npm pkg set overrides.better-sqlite3=7.6.2
npm install

npx appback-ai-agent init
pm2 start "npx appback-ai-agent start" --name ai-agent --cwd $HOME/ai-agent
pm2 save
```

---

## WSL Ubuntu

PowerShell에서 WSL 디렉토리를 보는 것과 WSL 안에서 실행하는 것은 다르다.
**반드시 WSL 셸에 진입한 후 설치한다:**

```powershell
wsl
```

WSL 셸 진입 후 Standard Installation 절차 그대로 진행.

---

## Update

```bash
# Standard 설치
npm cache clean --force
npm install -g appback-ai-agent@latest
pm2 restart ai-agent

# RHEL 8 / 로컬 설치
cd ~/ai-agent
npm install appback-ai-agent@latest
pm2 restart ai-agent
```
