const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { runEvaluateCommand } = require('../bin/commands/evaluate')
const { GcPersonalityEvaluator } = require('../src/evaluation/GcPersonalityEvaluator')

test('canonical personalities produce distinct strategic decisions', () => {
  const report = new GcPersonalityEvaluator().evaluate()
  assert.equal(report.passed, true)
  assert.ok(report.metrics.unique_signature_count >= 3)
  assert.equal(report.gates.hunter_pursues_when_survivor_flees, true)
  assert.equal(report.gates.collector_prefers_powerup_over_hunter, true)
  const hunterSurvivor = report.pairwise.find(item => item.profiles.join(':') === 'hunter:survivor')
  assert.ok(hunterSurvivor.action_difference_rate > 0)
})

test('personality evaluation CLI writes its report', t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'appback-personality-eval-'))
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }))
  let stdout = ''
  let stderr = ''
  const code = runEvaluateCommand({
    args: ['personality', '--json'],
    cwd,
    stdout: { write: value => { stdout += value } },
    stderr: { write: value => { stderr += value } },
  })
  assert.equal(code, 0, stderr)
  const output = JSON.parse(stdout)
  assert.equal(output.evaluator_version, 'gc-personality-v1')
  assert.equal(fs.existsSync(output.report_path), true)
})
