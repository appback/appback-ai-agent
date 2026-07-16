const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { runEvaluateCommand } = require('../bin/commands/evaluate')
const { compileProfile } = require('../src/config/ProfileCompiler')
const { createEasyProfile } = require('../src/config/BehaviorProfileStore')
const { GcV8Teacher } = require('../src/training/GcV8Teacher')
const { GcMazeEvaluator, generateMazeScenario, distanceToCell } = require('../src/evaluation/GcMazeEvaluator')

function navigator() {
  return compileProfile(createEasyProfile('navigator', 0, 1))
}

test('generated maze is deterministic, solvable, and places a distant target', () => {
  const first = generateMazeScenario(42, 15, 15)
  const second = generateMazeScenario(42, 15, 15)
  assert.deepEqual(first, second)
  const distance = distanceToCell(first.start, first.target, first.terrain)
  assert.ok(Number.isFinite(distance))
  assert.ok(distance >= 10)
})

test('navigator BFS teacher passes 200 deterministic maze quality gates', () => {
  const profile = navigator()
  const teacher = new GcV8Teacher(profile)
  const report = new GcMazeEvaluator({
    profile,
    scenarioCount: 200,
    seed: 20260716,
    decide: (frame, session) => teacher.buildSample(frame, session),
  }).evaluate()
  assert.equal(report.passed, true)
  assert.equal(report.metrics.goal_reach_rate, 1)
  assert.equal(report.metrics.path_efficiency, 1)
  assert.equal(report.metrics.loop_rate, 0)
  assert.equal(report.metrics.invalid_action_rate, 0)
  assert.equal(report.failed_scenarios.length, 0)
})

test('maze evaluator detects invalid and stuck policies', () => {
  const report = new GcMazeEvaluator({
    profile: navigator(),
    scenarioCount: 5,
    seed: 7,
    decide: () => ({ teacher_action: 'invalid' }),
  }).evaluate()
  assert.equal(report.passed, false)
  assert.equal(report.metrics.goal_reach_rate, 0)
  assert.ok(report.metrics.invalid_action_rate > 0)
  assert.ok(report.metrics.no_progress_rate > 0)
})

test('evaluate maze CLI writes a machine-readable report', t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'appback-maze-eval-'))
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }))
  let stdout = ''
  let stderr = ''
  const code = runEvaluateCommand({
    args: ['maze', '--preset', 'navigator', '--scenarios', '20', '--seed', '10', '--json'],
    cwd,
    stdout: { write: value => { stdout += value } },
    stderr: { write: value => { stderr += value } },
  })
  assert.equal(code, 0, stderr)
  const output = JSON.parse(stdout)
  assert.equal(output.passed, true)
  assert.equal(output.configuration.scenario_count, 20)
  assert.equal(fs.existsSync(output.report_path), true)
  const saved = JSON.parse(fs.readFileSync(output.report_path, 'utf8'))
  assert.equal(saved.evaluator_version, 'gc-maze-v1')
})
