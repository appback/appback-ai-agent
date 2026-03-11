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
  npx appback-ai-agent init     Create .env and directories in current folder
  npx appback-ai-agent start    Start the agent (default)
  npx appback-ai-agent help     Show this help

Quick start:
  npx appback-ai-agent init
  # Edit .env → set AGENT_NAME
  npx appback-ai-agent start
`)
