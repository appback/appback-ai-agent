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

# 4. AI Rewards 등록 코드 교환 및 canonical GC 등록
# rewards.appback.app → My AI Agents에서 신규 코드 발급
appback-ai-agent register ARW-XXXX-XXXX

# 5. PyTorch + 학습 의존성 (자동 학습용)
python3 -m venv ~/.venv-aiagent
source ~/.venv-aiagent/bin/activate
pip install torch numpy pandas scikit-learn onnx onnxscript
deactivate
echo "PYTHON_PATH=$HOME/.venv-aiagent/bin/python3" >> ~/.env

# 6. 환경 점검
appback-ai-agent doctor

# 7. 실행
pm2 start "appback-ai-agent start" --name ai-agent --cwd $HOME
pm2 save

# 8. (선택) 부팅 시 자동 시작
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
[main] appback-ai-agent v2.5.0 starting...
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

## AI Rewards 등록 및 재인증 (필수)

신규 에이전트는 `Register Agent` 코드, 기존 Face·모델·전적을 유지할 에이전트는 해당
기존 등록의 `Auth Code`를 발급한다.

```bash
appback-ai-agent register ARW-XXXX-XXXX
```

CLI는 코드를 AI Rewards canonical UUID/JWT로 교환하고 JWT로 GC를 등록한다. 기존 로컬
UUID가 있으면 교환·GC UUID와 모두 같아야 JWT를 저장한다. 코드와 JWT는 출력하지 않는다.

JWT 만료·폐기 시 새 에이전트를 만들지 말고 기존 등록에서 Auth Code를 다시 발급한다.

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
npx appback-ai-agent register ARW-XXXX-XXXX
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
