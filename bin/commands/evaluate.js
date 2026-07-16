const fs = require('fs')
const path = require('path')
const { BehaviorProfileStore, createEasyProfile } = require('../../src/config/BehaviorProfileStore')
const { compileProfile } = require('../../src/config/ProfileCompiler')
const { PRESETS } = require('../../src/config/personalityPresets')
const { GcV8Teacher } = require('../../src/training/GcV8Teacher')
const { GcMazeEvaluator } = require('../../src/evaluation/GcMazeEvaluator')

function runEvaluateCommand(options = {}) {
  const args = options.args || []
  const cwd = options.cwd || process.cwd()
  const stdout = options.stdout || process.stdout
  const stderr = options.stderr || process.stderr
  const out = line => stdout.write(`${line}\n`)
  try {
    const command = args[0]
    if (!command || command === 'help' || command === '--help' || command === '-h') {
      out(helpText())
      return 0
    }
    if (command !== 'maze') throw new Error(`Unknown evaluation: ${command}`)
    return evaluateMaze(args.slice(1), cwd, out)
  } catch (err) {
    stderr.write(`Error: ${err.message}\n`)
    return 1
  }
}

function evaluateMaze(args, cwd, out) {
  assertOptions(args, ['--preset', '--scenarios', '--seed', '--output', '--json'])
  const preset = stringOption(args, '--preset', null)
  if (preset && !Object.prototype.hasOwnProperty.call(PRESETS, preset)) {
    throw new Error(`Unknown preset: ${preset}. Use one of: ${Object.keys(PRESETS).join(', ')}`)
  }
  const profile = preset
    ? compileProfile(createEasyProfile(preset, 0, 1))
    : new BehaviorProfileStore(path.join(cwd, 'config')).getCurrent().effective
  const scenarios = integerOption(args, '--scenarios', 200, 1, 10000)
  const seed = integerOption(args, '--seed', 20260716, 0, 0xffffffff)
  const teacher = new GcV8Teacher(profile)
  const report = new GcMazeEvaluator({
    profile,
    scenarioCount: scenarios,
    seed,
    decide: (frame, session) => teacher.buildSample(frame, session),
  }).evaluate()
  const outputArg = stringOption(args, '--output', null)
  const outputPath = path.resolve(cwd, outputArg || path.join('reports', 'evaluation', `maze-${profile.profile_id}.json`))
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`)

  if (args.includes('--json')) out(JSON.stringify({ ...report, report_path: outputPath }, null, 2))
  else {
    out(`Maze evaluation: ${report.profile.id}`)
    out(`Scenarios:        ${report.configuration.scenario_count}`)
    out(`Goal reach rate:  ${(report.metrics.goal_reach_rate * 100).toFixed(1)}%`)
    out(`Path efficiency:  ${report.metrics.path_efficiency.toFixed(3)}`)
    out(`Loop rate:        ${(report.metrics.loop_rate * 100).toFixed(1)}%`)
    out(`Invalid actions:  ${(report.metrics.invalid_action_rate * 100).toFixed(1)}%`)
    out(`No progress rate: ${(report.metrics.no_progress_rate * 100).toFixed(1)}%`)
    out(`Result:           ${report.passed ? 'PASS' : 'FAIL'}`)
    out(`Report:           ${outputPath}`)
  }
  return report.passed ? 0 : 2
}

function assertOptions(args, allowed) {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`)
    if (!allowed.includes(arg)) throw new Error(`Unknown option: ${arg}`)
    if (arg !== '--json') {
      if (args[index + 1] == null || args[index + 1].startsWith('--')) throw new Error(`Missing value for ${arg}`)
      index++
    }
  }
}

function stringOption(args, name, fallback) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : fallback
}

function integerOption(args, name, fallback, min, max) {
  const raw = stringOption(args, name, null)
  if (raw == null) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`)
  }
  return value
}

function helpText() {
  return `Evaluation commands:
  evaluate maze [--preset name] [--scenarios 1-10000] [--seed number]
                [--output file] [--json]

Example:
  npx appback-ai-agent evaluate maze --preset navigator --scenarios 200`
}

module.exports = { runEvaluateCommand }
