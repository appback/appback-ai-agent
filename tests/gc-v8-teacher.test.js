const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('node:test')
const { compileProfile } = require('../src/config/ProfileCompiler')
const { V8_OPERATION_CONTRACT, buildRuntimeContext } = require('../src/config/operationContract')
const { GcV8Teacher } = require('../src/training/GcV8Teacher')
const SqliteStore = require('../src/data/storage/SqliteStore')
const TrainingExporter = require('../src/data/exporters/TrainingExporter')

const HASH = V8_OPERATION_CONTRACT.feature_schema_hash

function profile(preset) {
  return compileProfile({ schema_version: 1, mode: 'easy', preset, variation_percent: 0, seed: 1 })
}

function session(suffix = '1') {
  return {
    session_id: `session-v8-${suffix}`,
    game_id: `game-v8-${suffix}`,
    manifest: {
      arena: {
        width: 5,
        height: 5,
        terrain: [
          [0, 0, 1, 0, 0],
          [0, 0, 1, 0, 0],
          [0, 0, 0, 0, 0],
          [0, 0, 0, 0, 0],
          [0, 0, 0, 0, 0],
        ],
      },
      max_ticks: 300,
    },
  }
}

function frame(suffix = '1', profileHash = profile('navigator').profile_hash) {
  return {
    record_version: 1,
    frame_id: `frame-v8-${suffix}`,
    cursor: `tf1:${String(suffix).padStart(11, 'A')}`,
    session_id: `session-v8-${suffix}`,
    game_id: `game-v8-${suffix}`,
    tick: 1,
    decision_seq: 0,
    agent: { slot: 0 },
    contract: {
      operation_version: 'gc-v8-r1', feature_version: '8.0', feature_dim: 192,
      feature_schema_hash: HASH, training_version: 'teacher-v8-r1',
    },
    behavior_profile: { id: 'navigator', revision: 1, hash: profileHash },
    input: { feature_vector: new Array(192).fill(0), action_mask: [1, 1, 1, 1, 0] },
    inference: { status: 'ok', model_action: 'up' },
    execution: { executed_action: 'up', execution_status: 'applied', override_reason: null },
    history_before: { visits: [{ x: 1, y: 1, count: 1 }] },
    state: {
      agents: [
        { slot: 0, x: 1, y: 1, hp: 100, max_hp: 100, alive: true, range: 1 },
        { slot: 1, x: 3, y: 1, hp: 100, max_hp: 100, alive: true, range: 1 },
      ],
      powerups: [],
    },
  }
}

function result(suffix = '1') {
  return {
    result_id: `result-v8-${suffix}`, cursor: `tr1:${String(suffix).padStart(11, 'A')}`,
    session_id: `session-v8-${suffix}`, game_id: `game-v8-${suffix}`,
    agent_slot: 0, rank: 2, score: 420, kills: 1, damage_dealt: 150, damage_taken: 80,
    survived_ticks: 200, completed: true, finish_reason: 'last_standing',
  }
}

test('BFS teacher chooses the first detour step instead of walking into a maze wall', () => {
  const decision = new GcV8Teacher(profile('navigator')).buildSample(frame(), session(), result())
  assert.equal(decision.teacher_action, 'down')
  assert.equal(decision.teacher_reason, 'path_to_enemy')
  assert.equal(decision.observed_action, 'up')
  assert.ok(decision.sample_weight > 1)
})

test('personality policy changes the teacher decision for the same state', () => {
  const lowHpFrame = frame()
  lowHpFrame.state.agents[0].hp = 20
  lowHpFrame.history_before.visits.push({ x: 1, y: 0, count: 1 })
  lowHpFrame.history_before.visits.push({ x: 1, y: 2, count: 1 })
  const hunter = new GcV8Teacher(profile('hunter')).buildSample(lowHpFrame, session(), result())
  const survivor = new GcV8Teacher(profile('survivor')).buildSample(lowHpFrame, session(), result())
  assert.equal(hunter.teacher_action, 'down')
  assert.equal(survivor.teacher_action, 'left')
  assert.equal(survivor.teacher_reason, 'low_hp_flee')
})

test('teacher attack range matches GC ranged minimum-distance behavior', () => {
  const rangedFrame = frame()
  rangedFrame.state.agents[0] = {
    ...rangedFrame.state.agents[0],
    x: 1,
    y: 1,
    range: 3,
    range_type: 'ranged',
  }
  rangedFrame.state.agents[1] = { ...rangedFrame.state.agents[1], x: 1, y: 2 }
  rangedFrame.input.action_mask = [1, 1, 0, 1, 1]
  const decision = new GcV8Teacher(profile('hunter')).buildSample(rangedFrame, session(), result())
  assert.notEqual(decision.teacher_action, 'stay')
  assert.equal(decision.teacher_reason, 'path_to_enemy')
})

test('v8 exporter writes authoritative 192-dim vectors with teacher labels', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-v8-export-'))
  const dataDir = path.join(root, 'data')
  const exportDir = path.join(root, 'export')
  fs.mkdirSync(dataDir)
  const behavior = profile('navigator')
  const runtime = buildRuntimeContext(V8_OPERATION_CONTRACT, behavior)
  const store = new SqliteStore(dataDir, runtime)
  store.saveTrainingFrameBatch([frame()], [session()], 'tf1:AAAAAAAAAAE')
  store.saveTrainingResultBatch([result()], 'tr1:AAAAAAAAAAE')

  const exported = new TrainingExporter(store, exportDir, runtime, behavior).exportForTraining('claw-clash', 1)
  assert.equal(exported.sessionCount, 1)
  assert.equal(exported.tickCount, 1)
  const manifest = JSON.parse(fs.readFileSync(exported.manifestPath, 'utf8'))
  assert.equal(manifest.feature_dim, 192)
  assert.equal(manifest.label_source, 'bfs_teacher')
  assert.equal(manifest.observation_policy, 'same_profile_only')
  assert.deepEqual(manifest.source_behavior_profile_hashes, [behavior.profile_hash])
  assert.match(manifest.dataset_manifest_hash, /^sha256:[0-9a-f]{64}$/)
  const lines = fs.readFileSync(exported.ticksPath, 'utf8').trim().split('\n')
  const header = lines[0].split(',')
  const values = lines[1].split(',')
  assert.equal(header.filter(column => /^f\d+$/.test(column)).length, 192)
  assert.equal(values[header.indexOf('action')], 'down')
  assert.equal(values[header.indexOf('observed_action')], 'up')
  store.close()
})

test('v8 export isolates profiles by default and only reuses raw observations explicitly', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-v8-profile-isolation-'))
  const dataDir = path.join(root, 'data')
  fs.mkdirSync(dataDir)
  const behavior = profile('navigator')
  const otherBehavior = profile('hunter')
  const runtime = buildRuntimeContext(V8_OPERATION_CONTRACT, behavior)
  const store = new SqliteStore(dataDir, runtime)
  store.saveTrainingFrameBatch(
    [frame('1', behavior.profile_hash), frame('2', otherBehavior.profile_hash)],
    [session('1'), session('2')],
    'tf1:AAAAAAAAAAI'
  )
  store.saveTrainingResultBatch([result('1'), result('2')], 'tr1:AAAAAAAAAAI')

  const strictDir = path.join(root, 'strict')
  const strict = new TrainingExporter(store, strictDir, runtime, behavior)
    .exportForTraining('claw-clash', 1)
  assert.equal(strict.sessionCount, 1)
  assert.equal(strict.tickCount, 1)
  const strictManifest = JSON.parse(fs.readFileSync(strict.manifestPath, 'utf8'))
  assert.equal(strictManifest.observation_policy, 'same_profile_only')
  assert.deepEqual(strictManifest.source_behavior_profile_hashes, [behavior.profile_hash])

  const reuseDir = path.join(root, 'reuse')
  const reused = new TrainingExporter(store, reuseDir, runtime, behavior, { reuseObservations: true })
    .exportForTraining('claw-clash', 1)
  assert.equal(reused.sessionCount, 2)
  assert.equal(reused.tickCount, 2)
  const reuseManifest = JSON.parse(fs.readFileSync(reused.manifestPath, 'utf8'))
  assert.equal(reuseManifest.observation_policy, 'reuse_and_relabel')
  assert.deepEqual(reuseManifest.source_behavior_profile_hashes.sort(), [
    behavior.profile_hash,
    otherBehavior.profile_hash,
  ].sort())
  store.close()
})
