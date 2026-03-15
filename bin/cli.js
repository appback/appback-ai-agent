#!/usr/bin/env node

const fs = require('fs')
const path = require('path')

const CMD = process.argv[2]
const PKG_ROOT = path.resolve(__dirname, '..')
const CWD = process.cwd()

// ── init: 현재 디렉토리에 .env + 디렉토리 생성 ──
if (CMD === 'init') {
  const envDest = path.join(CWD, '.env')
  if (fs.existsSync(envDest)) {
    console.log('.env already exists, skipping')
  } else {
    fs.copyFileSync(path.join(PKG_ROOT, '.env.example'), envDest)
    console.log('.env created — edit AGENT_NAME to set your agent name')
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
    const dataDir = process.env.DATA_DIR || path.join(CWD, 'data')
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
console.log(`appback-ai-agent — AI game agent framework

Usage:
  npx appback-ai-agent init                  Create .env and directories
  npx appback-ai-agent start                 Start the agent (default)
  npx appback-ai-agent register <code>       Link agent to AI Rewards account
  npx appback-ai-agent help                  Show this help

Quick start:
  npx appback-ai-agent init
  # Edit .env → set AGENT_NAME
  npx appback-ai-agent start

AI Rewards registration:
  1. Go to https://rewards.appback.app → My AI Agents → Register Agent
  2. Copy the registration code (ARW-XXXX-XXXX)
  3. npx appback-ai-agent register ARW-XXXX-XXXX
`)
