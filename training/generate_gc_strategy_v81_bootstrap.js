#!/usr/bin/env node
const path = require('path')
const { generateSyntheticBootstrap } = require('../src/training/GcStrategyV81SyntheticBootstrap')

const args = parseArgs(process.argv.slice(2))
const result = generateSyntheticBootstrap({
  outputRoot: args.output || path.join(__dirname, 'data', 'v8.1-round7'),
  sessionsPerProfile: numberArg(args.sessions, 256),
  samplesPerSession: numberArg(args.samples, 8),
  seed: numberArg(args.seed, 8107),
})

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)

function parseArgs(values) {
  const parsed = {}
  for (let index = 0; index < values.length; index++) {
    const key = values[index]
    if (!key.startsWith('--')) throw new Error(`unexpected argument: ${key}`)
    parsed[key.slice(2)] = values[++index]
  }
  return parsed
}

function numberArg(value, fallback) {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`expected a positive integer, received ${value}`)
  return parsed
}
