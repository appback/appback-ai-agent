const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { runPersonalityCommand } = require('../bin/commands/personality')
const {
  BehaviorProfileStore,
  createEasyProfile,
  expertTemplate,
} = require('../src/config/BehaviorProfileStore')
const { compileProfile } = require('../src/config/ProfileCompiler')
const { validateProfile } = require('../src/config/ProfileValidator')

test('Easy profile compilation is deterministic for the same seed', () => {
  const source = createEasyProfile('hunter', 8, 20260715)
  const first = compileProfile(source)
  const second = compileProfile(source)

  assert.deepEqual(first, second)
  assert.match(first.profile_hash, /^sha256:[a-f0-9]{64}$/)
})

test('Seed does not change the behavior hash when variation is zero', () => {
  const first = compileProfile(createEasyProfile('balanced', 0, 1))
  const second = compileProfile(createEasyProfile('balanced', 0, 999))

  assert.equal(first.profile_hash, second.profile_hash)
  assert.deepEqual(first.objective, second.objective)
  assert.deepEqual(first.policy, second.policy)
  assert.deepEqual(first.equipment, second.equipment)
})

test('Easy variation changes behavior but stays within validated ranges', () => {
  const base = compileProfile(createEasyProfile('navigator', 0, 1))
  const varied = compileProfile(createEasyProfile('navigator', 15, 2))

  assert.notEqual(varied.profile_hash, base.profile_hash)
  assert.notDeepEqual(varied.objective, base.objective)
  assert.notDeepEqual(varied.equipment, base.equipment)
  for (const value of Object.values(varied.objective)) {
    assert.ok(value >= 0 && value <= 2)
  }
  assert.ok(varied.policy.flee_hp_ratio >= 0.05 && varied.policy.flee_hp_ratio <= 0.8)
  assert.ok(Number.isInteger(varied.policy.max_chase_path))
  assert.ok(Number.isInteger(varied.policy.replan_ticks))
  for (const value of Object.values(varied.equipment)) {
    assert.ok(value >= 0 && value <= 2)
  }
})

test('Expert validation rejects unknown and out-of-range fields', () => {
  const profile = expertTemplate('test-profile')
  profile.objective.kills = 3
  profile.policy.typo = 1
  profile.equipment.speed = -1

  const errors = validateProfile(profile)
  assert.ok(errors.some(message => message.includes('objective.kills')))
  assert.ok(errors.some(message => message.includes('policy.typo')))
  assert.ok(errors.some(message => message.includes('equipment.speed')))
})

test('Store saves revisions and rollback creates a new revision', t => {
  const cwd = makeTempDir(t)
  const store = new BehaviorProfileStore(path.join(cwd, 'config'))

  const first = store.save(createEasyProfile('hunter', 8, 10))
  const second = store.save(createEasyProfile('survivor', 4, 20))
  const rolledBack = store.rollback(1)

  assert.equal(first.configured.revision, 1)
  assert.equal(second.configured.revision, 2)
  assert.equal(rolledBack.configured.revision, 3)
  assert.equal(rolledBack.configured.preset, 'hunter')
  assert.equal(store.listHistory().length, 3)
  assert.equal(store.getCurrent().effective.profile_hash, first.effective.profile_hash)
})

test('CLI supports Easy set/show/history and Expert apply/set', t => {
  const cwd = makeTempDir(t)

  let result = runCli(cwd, ['set', 'hunter', '--variation', '8', '--seed', '42'])
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /Saved personality revision 1/)

  result = runCli(cwd, ['show', '--json'])
  assert.equal(result.code, 0, result.stderr)
  const shown = JSON.parse(result.stdout)
  assert.equal(shown.configured.preset, 'hunter')
  assert.equal(shown.effective.seed, 42)

  result = runCli(cwd, ['expert', 'init', 'expert.json', '--name', 'manual'])
  assert.equal(result.code, 0, result.stderr)
  result = runCli(cwd, ['expert', 'apply', 'expert.json'])
  assert.equal(result.code, 0, result.stderr)
  result = runCli(cwd, ['expert', 'set', 'objective.kills', '1.7'])
  assert.equal(result.code, 0, result.stderr)
  result = runCli(cwd, ['expert', 'set', 'equipment.speed', '1.9'])
  assert.equal(result.code, 0, result.stderr)

  const current = new BehaviorProfileStore(path.join(cwd, 'config')).getCurrent()
  assert.equal(current.configured.mode, 'expert')
  assert.equal(current.configured.objective.kills, 1.7)
  assert.equal(current.configured.equipment.speed, 1.9)
  assert.equal(current.configured.revision, 4)
})

test('CLI rejects invalid Easy values without replacing current profile', t => {
  const cwd = makeTempDir(t)
  assert.equal(runCli(cwd, ['set', 'balanced', '--seed', '1']).code, 0)
  const before = new BehaviorProfileStore(path.join(cwd, 'config')).getCurrent()

  const result = runCli(cwd, ['set', 'hunter', '--variation', '99', '--seed', '2'])
  assert.equal(result.code, 1)
  assert.match(result.stderr, /variation_percent/)

  const after = new BehaviorProfileStore(path.join(cwd, 'config')).getCurrent()
  assert.equal(after.configured.revision, before.configured.revision)
  assert.equal(after.effective.profile_hash, before.effective.profile_hash)
})

test('CLI rejects unsupported options instead of silently ignoring them', t => {
  const cwd = makeTempDir(t)
  const result = runCli(cwd, ['set', 'hunter', '--train'])

  assert.equal(result.code, 1)
  assert.match(result.stderr, /Unknown option: --train/)
  assert.equal(fs.existsSync(path.join(cwd, 'config', 'personality.json')), false)
})

function runCli(cwd, args) {
  let stdout = ''
  let stderr = ''
  const code = runPersonalityCommand({
    args,
    cwd,
    stdout: { write: value => { stdout += value } },
    stderr: { write: value => { stderr += value } },
  })
  return { code, stdout: stdout.trim(), stderr: stderr.trim() }
}

function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appback-personality-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
