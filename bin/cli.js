#!/usr/bin/env node

const fs = require('fs')
const path = require('path')

const CMD = process.argv[2]
const PKG_ROOT = path.resolve(__dirname, '..')
const CWD = process.cwd()
const PKG_VERSION = require(path.join(PKG_ROOT, 'package.json')).version

// ── version ──
if (CMD === 'version' || CMD === '--version' || CMD === '-v') {
  console.log(`appback-ai-agent v${PKG_VERSION}`)
  process.exit(0)
}

// ── personality: behavior profile configuration ──
if (CMD === 'personality') {
  const { runPersonalityCommand } = require('./commands/personality')
  const code = runPersonalityCommand({ args: process.argv.slice(3), cwd: CWD })
  process.exit(code)
}

// ── operation: data/model compatibility contract ──
if (CMD === 'operation') {
  const { runOperationCommand } = require('./commands/operation')
  const code = runOperationCommand({ args: process.argv.slice(3), cwd: CWD })
  process.exit(code)
}

// ── evaluate: deterministic offline quality gates ──
if (CMD === 'evaluate') {
  const { runEvaluateCommand } = require('./commands/evaluate')
  const code = runEvaluateCommand({ args: process.argv.slice(3), cwd: CWD })
  process.exit(code)
}

// ── link-owner: optional account association; never changes local identity ──
if (CMD === 'link-owner') {
  const { runLinkOwnerCommand } = require('./commands/link-owner')
  runLinkOwnerCommand({ args: process.argv.slice(3), cwd: CWD })
    .then(code => process.exit(code))
  return
}

// ── doctor: 환경 점검 ──
if (CMD === 'doctor') {
  const { execSync } = require('child_process')
  const checks = []
  const doctorEnvPath = path.join(CWD, '.env')
  if (fs.existsSync(doctorEnvPath)) require('dotenv').config({ path: doctorEnvPath })
  else require('dotenv').config()
  let doctorIdentity = null

  function check(name, fn) {
    try {
      const result = fn()
      checks.push({ name, ok: true, detail: result })
      console.log(`  ✓ ${name}: ${result}`)
    } catch (err) {
      checks.push({ name, ok: false, detail: err.message })
      console.log(`  ✗ ${name}: ${err.message}`)
    }
  }

  function run(cmd) { return execSync(cmd, { encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).trim() }

  console.log(`\nappback-ai-agent v${PKG_VERSION} — environment check\n`)
  console.log('[ System ]')
  check('Node.js', () => {
    const v = process.version
    const major = parseInt(v.slice(1))
    if (major < 18) throw new Error(`${v} (requires >= 18)`)
    return v
  })
  check('npm', () => run('npm -v'))
  check('OS', () => `${process.platform} ${process.arch}`)

  console.log('\n[ Project ]')
  check('Working dir', () => CWD)
  check('.env', () => {
    const p = path.join(CWD, '.env')
    if (!fs.existsSync(p)) throw new Error('not found — run: appback-ai-agent init')
    return p
  })
  check('data/', () => {
    const p = path.join(CWD, 'data')
    if (!fs.existsSync(p)) throw new Error('not found — run: appback-ai-agent init')
    return p
  })
  check('models/', () => {
    const p = path.join(CWD, 'models')
    if (!fs.existsSync(p)) throw new Error('not found — run: appback-ai-agent init')
    return p
  })
  check('Personality', () => {
    const { BehaviorProfileStore } = require(path.join(PKG_ROOT, 'src', 'config', 'BehaviorProfileStore'))
    const current = new BehaviorProfileStore(path.join(CWD, 'config')).getCurrent()
    const suffix = current.persisted ? `r${current.configured.revision}` : 'default'
    return `${current.effective.profile_id} (${suffix})`
  })
  check('Operation contract', () => {
    const { OperationVersionStore } = require(path.join(PKG_ROOT, 'src', 'config', 'OperationVersionStore'))
    const status = new OperationVersionStore(path.join(CWD, 'config')).getStatus()
    if (!status.initialized) throw new Error('not initialized — run: appback-ai-agent operation activate --yes')
    if (!status.compatible) {
      throw new Error(`active=${status.active.operation_version}, binary=${status.binary.operation_version}`)
    }
    return `${status.active.operation_version} (${status.active.feature_dim} dimensions)`
  })

  console.log('\n[ Agent ]')
  check('better-sqlite3', () => {
    require('better-sqlite3')
    return 'OK'
  })
  check('Agent identity', () => {
    const rawDataDir = process.env.DATA_DIR || 'data'
    const dataDir = path.isAbsolute(rawDataDir) ? rawDataDir : path.resolve(CWD, rawDataDir)
    const dbPath = path.join(dataDir, 'agent.db')
    if (!fs.existsSync(dbPath)) throw new Error('no database — run: appback-ai-agent start')
    const SqliteStore = require(path.join(PKG_ROOT, 'src', 'data', 'storage', 'SqliteStore'))
    const store = new SqliteStore(dataDir)
    doctorIdentity = store.getIdentity('claw-clash')
    store.close()
    if (!doctorIdentity) throw new Error('identity not allocated — run: appback-ai-agent start')
    return `${doctorIdentity.name} (${doctorIdentity.agent_id})`
  })
  check('Agent credential', () => {
    if (!doctorIdentity) throw new Error('identity unavailable')
    const { validateAgentJwt } = require(path.join(PKG_ROOT, 'src', 'auth', 'agentJwt'))
    const jwt = validateAgentJwt(doctorIdentity.api_token, { expectedAgentId: doctorIdentity.agent_id })
    if (doctorIdentity.credential_issuer !== 'ai-rewards' || doctorIdentity.credential_type !== 'agent_jwt') {
      throw new Error('credential metadata is not canonical; start the agent to reissue it')
    }
    return `AI Rewards JWT, expires ${jwt.expiresAt}`
  })
  check('GC endpoint', () => {
    const config = require(path.join(PKG_ROOT, 'src', 'adapters', 'gc', 'config'))
    const url = new URL(config.apiUrl)
    if (url.protocol !== 'https:') throw new Error('HTTPS is required')
    return url.toString()
  })
  check('ONNX model', () => {
    const { OperationVersionStore } = require(path.join(PKG_ROOT, 'src', 'config', 'OperationVersionStore'))
    const { BehaviorProfileStore } = require(path.join(PKG_ROOT, 'src', 'config', 'BehaviorProfileStore'))
    const { buildRuntimeContext } = require(path.join(PKG_ROOT, 'src', 'config', 'operationContract'))
    const operation = new OperationVersionStore(path.join(CWD, 'config')).ensureActive({ initialize: false })
    const behavior = new BehaviorProfileStore(path.join(CWD, 'config')).getCurrent()
    process.env._PKG_ROOT = PKG_ROOT
    process.env._AGENT_CWD = CWD
    const paths = require(path.join(PKG_ROOT, 'src', 'paths'))
    const modelName = operation.feature_version === '8.1'
      ? 'gc_strategy_model.onnx'
      : 'gc_move_model.onnx'
    const p = path.join(paths.modelGenerationDir(buildRuntimeContext(operation, behavior)), modelName)
    if (!fs.existsSync(p)) throw new Error('not found (will use rule-based)')
    const size = (fs.statSync(p).size / 1024).toFixed(1)
    return `${size} KB`
  })

  console.log('\n[ Training (optional) — requires: RAM ≥ 2GB, Disk ≥ 3GB, Python 3.8+, PyTorch ]')
  check('RAM', () => {
    const os = require('os')
    const totalGB = (os.totalmem() / 1024 / 1024 / 1024).toFixed(1)
    const freeGB = (os.freemem() / 1024 / 1024 / 1024).toFixed(1)
    const total = parseFloat(totalGB)
    if (total < 2) throw new Error(`${totalGB} GB total (requires ≥ 2 GB)`)
    return `${freeGB} GB free / ${totalGB} GB total`
  })
  check('Disk', () => {
    try {
      const df = run(`df -BG "${CWD}" | tail -1`)
      const parts = df.split(/\s+/)
      const avail = parts[3] || '?'
      if (parseInt(avail) < 3) throw new Error(`${avail} available (requires ≥ 3 GB)`)
      return `${avail} available`
    } catch (e) {
      if (e.message.includes('available')) throw e
      return 'unknown'
    }
  })
  // .env의 PYTHON_PATH 또는 시스템 python
  const envPath = path.join(CWD, '.env')
  let pyCmd = 'python3'
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8')
    const m = envContent.match(/^PYTHON_PATH=(.+)$/m)
    if (m) {
      const p = m[1].trim()
      pyCmd = path.isAbsolute(p) ? p : path.resolve(CWD, p)
    }
  }
  check('Python', () => {
    try { return run(`"${pyCmd}" --version`) } catch {
      try { return run('python3 --version') } catch {
        try { return run('python --version') } catch { throw new Error('not found — requires Python 3.8+') }
      }
    }
  })
  check('PyTorch', () => {
    try { return run(`"${pyCmd}" -c "import torch; print(torch.__version__)"`) } catch {
      try { return run('python3 -c "import torch; print(torch.__version__)"') } catch {
        try { return run('python -c "import torch; print(torch.__version__)"') } catch {
          throw new Error('not installed')
        }
      }
    }
  })

  const failed = checks.filter(c => !c.ok && !c.name.startsWith('ONNX') && !['Python', 'PyTorch', 'RAM', 'Disk'].includes(c.name))
  const trainOk = checks.filter(c => ['Python', 'PyTorch'].includes(c.name)).every(c => c.ok)
  console.log()
  if (failed.length === 0) {
    if (trainOk) {
      console.log('All checks passed! Ready to run: appback-ai-agent start\n')
    } else {
      console.log('Agent ready! Training dependencies missing — agent will play with rule-based AI.')
      console.log('To enable auto-training:\n')
      console.log('  python3 -m venv .venv && source .venv/bin/activate')
      console.log('  pip install torch')
      console.log('  echo \'PYTHON_PATH=.venv/bin/python3\' >> .env\n')
    }
  } else {
    console.log(`${failed.length} issue(s) found. Fix them and re-run: appback-ai-agent doctor\n`)
  }
  process.exit(failed.length > 0 ? 1 : 0)
}

// ── init: 현재 디렉토리에 .env + 디렉토리 생성 ──
if (CMD === 'init') {
  const envDest = path.join(CWD, '.env')
  if (fs.existsSync(envDest)) {
    console.log('.env already exists, skipping')
  } else {
    fs.copyFileSync(path.join(PKG_ROOT, '.env.example'), envDest)
    console.log('.env created')
  }
  for (const dir of ['models', 'data', 'config']) {
    const p = path.join(CWD, dir)
    if (!fs.existsSync(p)) { fs.mkdirSync(p, { recursive: true }); console.log(`${dir}/ created`) }
  }
  const { OperationVersionStore } = require(path.join(PKG_ROOT, 'src', 'config', 'OperationVersionStore'))
  const operation = new OperationVersionStore(path.join(CWD, 'config')).ensureActive()
  console.log(`Operation contract initialized: ${operation.operation_version}`)
  console.log('\nReady! Run: npx appback-ai-agent start')
  process.exit(0)
}

// ── export: 학습 데이터 재추출 ──
if (CMD === 'export') {
  const exportArgs = process.argv.slice(3)
  const unknownExportArgs = exportArgs.filter(arg => arg !== '--reuse-observations')
  if (unknownExportArgs.length > 0) {
    console.error(`Unknown export option: ${unknownExportArgs[0]}`)
    console.error('Usage: npx appback-ai-agent export [--reuse-observations]')
    process.exit(1)
  }
  const reuseObservations = exportArgs.includes('--reuse-observations')
  const envPath = path.join(CWD, '.env')
  if (fs.existsSync(envPath)) require('dotenv').config({ path: envPath })
  else require('dotenv').config()

  process.env._PKG_ROOT = PKG_ROOT
  process.env._AGENT_CWD = CWD
  const paths = require(path.join(PKG_ROOT, 'src', 'paths'))
  const SqliteStore = require(path.join(PKG_ROOT, 'src', 'data', 'storage', 'SqliteStore'))
  const TrainingExporter = require(path.join(PKG_ROOT, 'src', 'data', 'exporters', 'TrainingExporter'))
  const { OperationVersionStore } = require(path.join(PKG_ROOT, 'src', 'config', 'OperationVersionStore'))
  const { BehaviorProfileStore } = require(path.join(PKG_ROOT, 'src', 'config', 'BehaviorProfileStore'))
  const { buildRuntimeContext } = require(path.join(PKG_ROOT, 'src', 'config', 'operationContract'))

  const dataDir = paths.dataDir()
  const operation = new OperationVersionStore(paths.configDir()).ensureActive()
  const behavior = new BehaviorProfileStore(paths.configDir()).getCurrent()
  const runtimeContext = buildRuntimeContext(operation, behavior)
  const exportDir = paths.trainingDataDir(runtimeContext)
  const store = new SqliteStore(dataDir, runtimeContext)
  const exporter = new TrainingExporter(store, exportDir, runtimeContext, behavior.effective, {
    reuseObservations,
  })
  if (reuseObservations) {
    console.log('Observation policy: reuse prior-profile raw frames and relabel all samples with the current personality')
  }
  const result = exporter.exportForTraining('claw-clash', 1)
  store.close()

  if (result && result.tickCount) {
    console.log(`Exported ${result.sessionCount} sessions, ${result.tickCount} ticks → ${exportDir}`)
  } else {
    console.log('No data to export (need at least 1 completed game)')
  }
  process.exit(0)
}

// ── train: 수동 학습 실행 ──
if (CMD === 'train') {
  const envPath = path.join(CWD, '.env')
  if (fs.existsSync(envPath)) require('dotenv').config({ path: envPath })
  else require('dotenv').config()

  process.env._PKG_ROOT = PKG_ROOT
  process.env._AGENT_CWD = CWD
  const paths = require(path.join(PKG_ROOT, 'src', 'paths'))
  const { OperationVersionStore } = require(path.join(PKG_ROOT, 'src', 'config', 'OperationVersionStore'))
  const { BehaviorProfileStore } = require(path.join(PKG_ROOT, 'src', 'config', 'BehaviorProfileStore'))
  const { buildRuntimeContext } = require(path.join(PKG_ROOT, 'src', 'config', 'operationContract'))
  const TrainingRunner = require(path.join(PKG_ROOT, 'src', 'core', 'TrainingRunner'))
  const operation = new OperationVersionStore(paths.configDir()).ensureActive()
  const behavior = new BehaviorProfileStore(paths.configDir()).getCurrent()
  const runtimeContext = buildRuntimeContext(operation, behavior)
  const dataDir = paths.trainingDataDir(runtimeContext)
  const outputDir = paths.modelGenerationDir(runtimeContext)
  const pythonPath = process.env.PYTHON_PATH || 'python3'

  console.log(`Python: ${pythonPath}`)
  console.log(`Data:   ${dataDir}`)
  console.log(`Output: ${outputDir}`)
  console.log()

  const trainer = new TrainingRunner({ dataDir, outputDir, pythonPath, runtimeContext })
  trainer.run('claw-clash').then(success => process.exit(success ? 0 : 1))
  return
}

// ── start: 에이전트 실행 ──
if (CMD === 'start' || !CMD) {
  // .env가 CWD에 있으면 로드
  const envPath = path.join(CWD, '.env')
  if (fs.existsSync(envPath)) {
    require('dotenv').config({ path: envPath })
  } else {
    require('dotenv').config()
  }

  // CWD 기준 경로를 절대경로로 변환
  if (process.env.MODEL_DIR && !path.isAbsolute(process.env.MODEL_DIR)) {
    process.env.MODEL_DIR = path.resolve(CWD, process.env.MODEL_DIR)
  }
  if (process.env.DATA_DIR && !path.isAbsolute(process.env.DATA_DIR)) {
    process.env.DATA_DIR = path.resolve(CWD, process.env.DATA_DIR)
  }

  // 기본값도 CWD 기준
  if (!process.env.MODEL_DIR) process.env.MODEL_DIR = path.join(CWD, 'models')
  if (!process.env.DATA_DIR) process.env.DATA_DIR = path.join(CWD, 'data')

  // 디렉토리 자동 생성
  for (const dir of [process.env.MODEL_DIR, process.env.DATA_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  }

  // 경로 설정 (src/paths.js에서 참조)
  process.env._PKG_ROOT = PKG_ROOT
  process.env._AGENT_CWD = CWD

  require(path.join(PKG_ROOT, 'src', 'index.js'))
  return
}

// ── help ──
console.log(`appback-ai-agent v${PKG_VERSION} — AI game agent framework

Usage:
  npx appback-ai-agent doctor                 Check environment & dependencies
  npx appback-ai-agent init                  Create .env and directories
  npx appback-ai-agent start                 Start the agent (default)
  npx appback-ai-agent export [--reuse-observations]
                                             Export profile-isolated training data
  npx appback-ai-agent train                 Run model training manually
  npx appback-ai-agent evaluate              Run maze/personality quality gates
  npx appback-ai-agent personality           Configure AI behavior personality
  npx appback-ai-agent operation             Manage data/model operation contract
  npx appback-ai-agent link-owner ARW-XXXX-XXXX
                                             Optionally link this UUID to a code owner
  npx appback-ai-agent version               Show version
  npx appback-ai-agent help                  Show this help

Quick start:
  npx appback-ai-agent init
  npx appback-ai-agent start

Training (requires Python):
  pip install -r node_modules/appback-ai-agent/training/requirements.txt
  npx appback-ai-agent export                # Export data from SQLite
  npx appback-ai-agent train                 # Train model

  # Ubuntu 24.04 (PEP 668):
  python3 -m venv .venv && source .venv/bin/activate
  pip install -r node_modules/appback-ai-agent/training/requirements.txt
  echo 'PYTHON_PATH=.venv/bin/python3' >> .env

Evaluation:
  npx appback-ai-agent evaluate maze --preset navigator --scenarios 200
  npx appback-ai-agent evaluate personality

Personality:
  npx appback-ai-agent personality list
  npx appback-ai-agent personality set hunter --variation 8
  npx appback-ai-agent personality show
  npx appback-ai-agent personality expert help

Operation versioning:
  npx appback-ai-agent operation show
  npx appback-ai-agent operation verify
  npx appback-ai-agent operation activate v8 --yes
  npx appback-ai-agent operation activate v81 --yes  # v8.1 test agents only

AI Rewards identity:
  - start requests a UUID from AI Rewards when none exists
  - an existing local UUID is reused when AI Rewards issues or renews its JWT
  - no email, owner, or account credential is used by the AI Agent runtime
  - ARW codes are optional owner links and never issue or replace UUID/JWT credentials
`)
