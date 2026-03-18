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

// ── doctor: 환경 점검 ──
if (CMD === 'doctor') {
  const { execSync } = require('child_process')
  const checks = []

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

  console.log('\n[ Agent ]')
  check('better-sqlite3', () => {
    require('better-sqlite3')
    return 'OK'
  })
  check('Agent identity', () => {
    const dbPath = path.join(CWD, 'data', 'agent.db')
    if (!fs.existsSync(dbPath)) throw new Error('no database — run: appback-ai-agent start')
    const Database = require('better-sqlite3')
    const db = new Database(dbPath, { readonly: true })
    const row = db.prepare('SELECT agent_id, name FROM agent_identity WHERE game = ?').get('claw-clash')
    db.close()
    if (!row) throw new Error('not registered — run: appback-ai-agent start')
    return `${row.name} (${row.agent_id})`
  })
  check('ONNX model', () => {
    const p = path.join(CWD, 'models', 'gc', 'gc_strategy_model.onnx')
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
  for (const dir of ['models', 'data']) {
    const p = path.join(CWD, dir)
    if (!fs.existsSync(p)) { fs.mkdirSync(p, { recursive: true }); console.log(`${dir}/ created`) }
  }
  console.log('\nReady! Run: npx appback-ai-agent start')
  process.exit(0)
}

// ── register: AI Rewards 등록 코드로 Hub 계정에 에이전트 연결 ──
if (CMD === 'register') {
  const code = process.argv[3]
  if (!code) {
    console.error('Usage: npx appback-ai-agent register <registration_code>')
    console.error('  Get your code at https://rewards.appback.app → My AI Agents → Register Agent')
    process.exit(1)
  }

  const envPath = path.join(CWD, '.env')
  if (fs.existsSync(envPath)) {
    require('dotenv').config({ path: envPath })
  } else {
    require('dotenv').config()
  }

  const axios = require('axios')
  const apiUrl = process.env.GC_API_URL || 'https://clash.appback.app/api/v1'
  let apiToken = process.env.GC_API_TOKEN || ''

  // .env에 토큰 없으면 SQLite에서 기존 에이전트 토큰 읽기
  if (!apiToken) {
    const rawDataDir = process.env.DATA_DIR || 'data'
    const dataDir = path.isAbsolute(rawDataDir) ? rawDataDir : path.resolve(CWD, rawDataDir)
    const dbPath = path.join(dataDir, 'agent.db')
    if (fs.existsSync(dbPath)) {
      try {
        const Database = require('better-sqlite3')
        const db = new Database(dbPath, { readonly: true })
        const row = db.prepare('SELECT api_token, name, agent_id FROM agent_identity WHERE game = ?').get('claw-clash')
        db.close()
        if (row && row.api_token) {
          apiToken = row.api_token
          console.log(`Found existing agent: ${row.name} (${row.agent_id})`)
        }
      } catch (e) { /* DB 읽기 실패 무시 */ }
    }
  }

  if (!apiToken) {
    console.error('Error: No agent token found.')
    console.error('  Set GC_API_TOKEN in .env, or run "npx appback-ai-agent start" first to register an agent.')
    process.exit(1)
  }

  ;(async () => {
    try {
      console.log(`Linking agent to AI Rewards with code: ${code}`)
      const { data } = await axios.post(`${apiUrl}/agents/verify-registration`, {
        registration_code: code,
        agent_token: apiToken,
      })

      console.log()
      console.log('Successfully linked!')
      console.log(`  Agent: ${data.agent_name} (${data.agent_id})`)
      console.log(`  Service: ${data.service}`)
      console.log()
      console.log('Your agent is now visible at https://rewards.appback.app')
    } catch (err) {
      const msg = err.response?.data?.message || err.response?.data?.error || err.message
      console.error(`Error: ${msg}`)
      process.exit(1)
    }
  })()
  return
}

// ── export: 학습 데이터 재추출 ──
if (CMD === 'export') {
  const envPath = path.join(CWD, '.env')
  if (fs.existsSync(envPath)) require('dotenv').config({ path: envPath })
  else require('dotenv').config()

  const rawDataDir = process.env.DATA_DIR || 'data'
  const dataDir = path.isAbsolute(rawDataDir) ? rawDataDir : path.resolve(CWD, rawDataDir)
  process.env.DATA_DIR = dataDir

  const SqliteStore = require(path.join(PKG_ROOT, 'src', 'data', 'storage', 'SqliteStore'))
  const TrainingExporter = require(path.join(PKG_ROOT, 'src', 'data', 'exporters', 'TrainingExporter'))

  const store = new SqliteStore(dataDir)
  const exportDir = path.join(PKG_ROOT, 'training', 'data', 'raw')
  const exporter = new TrainingExporter(store, exportDir)
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

  const { spawn: spawnProc } = require('child_process')
  const pythonPath = process.env.PYTHON_PATH || 'python3'
  const scriptPath = path.join(PKG_ROOT, 'training', 'train_gc_model.py')
  const dataDir = path.join(PKG_ROOT, 'training', 'data', 'raw')
  const modelDir = process.env.MODEL_DIR || path.join(CWD, 'models')
  const outputDir = path.join(modelDir, 'gc')

  console.log(`Python: ${pythonPath}`)
  console.log(`Data:   ${dataDir}`)
  console.log(`Output: ${outputDir}`)
  console.log()

  const proc = spawnProc(pythonPath, [scriptPath, '--data-dir', dataDir, '--output-dir', outputDir], {
    stdio: 'inherit',
    env: { ...process.env, PYTHONPATH: path.join(PKG_ROOT, 'training') },
  })
  proc.on('close', (code) => process.exit(code || 0))
  proc.on('error', (err) => {
    console.error(`Failed to start python: ${err.message}`)
    console.error(`Set PYTHON_PATH in .env to your venv python path`)
    process.exit(1)
  })
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

  // training 경로는 패키지 내부
  process.env._TRAINING_DIR = path.join(PKG_ROOT, 'training')
  process.env._PKG_ROOT = PKG_ROOT

  require(path.join(PKG_ROOT, 'src', 'index.js'))
  return
}

// ── help ──
console.log(`appback-ai-agent v${PKG_VERSION} — AI game agent framework

Usage:
  npx appback-ai-agent doctor                 Check environment & dependencies
  npx appback-ai-agent init                  Create .env and directories
  npx appback-ai-agent start                 Start the agent (default)
  npx appback-ai-agent register <code>       Link agent to AI Rewards account
  npx appback-ai-agent export                Export training data from DB
  npx appback-ai-agent train                 Run model training manually
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

AI Rewards registration:
  1. Go to https://rewards.appback.app → My AI Agents → Register Agent
  2. Copy the registration code (ARW-XXXX-XXXX)
  3. npx appback-ai-agent register ARW-XXXX-XXXX
`)
