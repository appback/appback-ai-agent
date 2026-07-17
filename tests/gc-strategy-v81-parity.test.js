const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('node:test')
const { GcStrategyV81FeatureBuilder } = require('../src/adapters/gc/GcStrategyV81FeatureBuilder')
const { compileProfile } = require('../src/config/ProfileCompiler')
const {
  SCHEMA,
  SCHEMA_HASH,
  STRATEGY_LABELS,
  assertCanonicalStrategyV81Schema,
} = require('../src/config/gcStrategyV81Contract')
const { V81_OPERATION_CONTRACT, buildRuntimeContext, getOperationContract } = require('../src/config/operationContract')
const { assertTrainingFrame } = require('../src/data/contracts/GcTrainingDataContract')
const TrainingExporter = require('../src/data/exporters/TrainingExporter')
const SqliteStore = require('../src/data/storage/SqliteStore')
const { GcStrategyV81Teacher } = require('../src/training/GcStrategyV81Teacher')

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'gc-v8.1')
const FEATURE_FIXTURE = readJson('strategy_v8_1_fixture.json')
const EXECUTION_FIXTURE = readJson('strategy_v8_1_execution_fixture.json')

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'))
}

function profile(preset) {
  return compileProfile({ schema_version: 1, mode: 'easy', preset, variation_percent: 0, seed: 1 })
}

function session(behavior, suffix = '1') {
  return {
    session_id: `session-v81-${suffix}`,
    game_id: `game-v81-${suffix}`,
    agent_slot: FEATURE_FIXTURE.agents[FEATURE_FIXTURE.self_index].slot,
    manifest: {
      strategy_candidates: FEATURE_FIXTURE.expected.candidate_slots.map((slot, candidate) => ({ candidate, slot })),
      arena: FEATURE_FIXTURE.game,
      behavior_profile_hash: behavior.profile_hash,
    },
  }
}

function frame(behavior, suffix = '1') {
  const mask = [...FEATURE_FIXTURE.expected.strategy_mask]
  return {
    record_version: 2,
    frame_id: `frame-v81-${suffix}`,
    cursor: `tf1:${String(suffix).padStart(11, 'A')}`,
    session_id: `session-v81-${suffix}`,
    game_id: `game-v81-${suffix}`,
    tick: FEATURE_FIXTURE.tick,
    decision_seq: 0,
    agent: { slot: FEATURE_FIXTURE.agents[FEATURE_FIXTURE.self_index].slot },
    contract: {
      operation_version: V81_OPERATION_CONTRACT.operation_version,
      feature_version: '8.1',
      feature_dim: 214,
      feature_schema_hash: SCHEMA_HASH,
      training_version: V81_OPERATION_CONTRACT.training_version,
    },
    behavior_profile: { id: behavior.profile_id, revision: 1, hash: behavior.profile_hash },
    input: { feature_vector: [...FEATURE_FIXTURE.expected.feature_vector], strategy_mask: mask },
    inference: { status: 'ok', raw_argmax_strategy: 'attack_candidate_0', model_strategy: 'explore' },
    execution: {
      executed_strategy: 'explore', selected_target_slot: -1, executed_target_slot: -1,
      path_action: 'down', executed_action: 'down',
      strategy_override_reason: null, movement_override_reason: null,
    },
    history_before: FEATURE_FIXTURE.history,
    state: { agents: FEATURE_FIXTURE.agents, powerups: [] },
  }
}

function result(suffix = '1') {
  return {
    result_id: `result-v81-${suffix}`, cursor: `tr1:${String(suffix).padStart(11, 'A')}`,
    session_id: `session-v81-${suffix}`, game_id: `game-v81-${suffix}`,
    agent_slot: 3, rank: 2, score: 420, kills: 1, damage_dealt: 150, damage_taken: 80,
    survived_ticks: 120, completed: true, finish_reason: 'last_standing',
  }
}

test('canonical schema raw bytes, shape, indices, and strategy order match GC Round 4', () => {
  assert.equal(assertCanonicalStrategyV81Schema(), true)
  assert.equal(SCHEMA_HASH, FEATURE_FIXTURE.schema_hash)
  assert.equal(SCHEMA.feature_dim, 214)
  assert.equal(SCHEMA.output_dim, 11)
  assert.deepEqual(STRATEGY_LABELS, [
    'hold', 'flee', 'seek_powerup', 'explore',
    'attack_candidate_0', 'attack_candidate_1', 'attack_candidate_2',
    'attack_candidate_3', 'attack_candidate_4', 'attack_candidate_5', 'attack_candidate_6',
  ])
  assert.equal(getOperationContract('8.1'), V81_OPERATION_CONTRACT)
})

test('independent JS builder exactly matches the GC 214 vector, mask, and candidate map', () => {
  const actual = new GcStrategyV81FeatureBuilder().build(FEATURE_FIXTURE)
  assert.deepEqual(actual.candidateSlots, FEATURE_FIXTURE.expected.candidate_slots)
  assert.deepEqual(actual.strategyMask, FEATURE_FIXTURE.expected.strategy_mask)
  assert.equal(actual.featureVector.length, 214)
  actual.featureVector.forEach((value, index) => {
    assert.ok(Math.abs(value - FEATURE_FIXTURE.expected.feature_vector[index]) <= 1e-12,
      `feature ${index}: actual=${value}, expected=${FEATURE_FIXTURE.expected.feature_vector[index]}`)
  })
  assert.deepEqual(actual.featureVector.slice(194, 205), actual.strategyMask)
})

test('execution fixture covers the frozen server semantics without changing label meanings', () => {
  assert.equal(EXECUTION_FIXTURE.schema_id, SCHEMA.schema_id)
  const cases = new Map(EXECUTION_FIXTURE.cases.map(item => [item.name, item]))
  assert.equal(cases.get('hold_has_no_move_or_attack').expected.path_action, 'stay')
  assert.equal(cases.get('hold_has_no_move_or_attack').expected.executed_target_slot, -1)
  assert.equal(cases.get('maze_attack_uses_udlr_bfs').expected.path_action, 'down')
  assert.equal(cases.get('dead_target_falls_back_by_candidate_index').expected.executed_strategy, 'attack_candidate_1')
  assert.equal(cases.get('unreachable_target_becomes_hold').expected.executed_strategy, 'hold')
  assert.equal(cases.get('dynamic_collision_cancels_only_movement').expected.movement_override_reason, 'dynamic_collision')
  assert.equal(cases.get('blocked_final_step_records_target_not_in_range').expected.strategy_override_reason,
    'target_not_in_range_after_move')
  assert.equal(cases.get('flee_prefers_lower_threat_then_distance').expected.path_action, 'down')
})

test('record_version 2 validator enforces strategy mask parity with feature indices 194..204', () => {
  const behavior = profile('hunter')
  const valid = frame(behavior)
  assert.equal(assertTrainingFrame(valid, buildRuntimeContext(V81_OPERATION_CONTRACT, behavior)), valid)
  const invalid = structuredClone(valid)
  invalid.input.strategy_mask[0] = 0
  assert.throws(() => assertTrainingFrame(invalid), /differs from feature_vector/)
})

test('personality changes strategy and primary target on the same canonical state', () => {
  const behaviors = Object.fromEntries(['hunter', 'survivor', 'navigator'].map(name => [name, profile(name)]))
  const decisions = Object.fromEntries(Object.entries(behaviors).map(([name, behavior]) => [
    name,
    new GcStrategyV81Teacher(behavior).buildSample(frame(behavior), session(behavior)),
  ]))
  assert.equal(decisions.hunter.teacher_strategy, 'attack_candidate_0')
  assert.equal(decisions.hunter.teacher_target_slot, 0)
  assert.equal(decisions.survivor.teacher_strategy, 'explore')
  assert.equal(decisions.navigator.teacher_strategy, 'explore')
  assert.notEqual(decisions.hunter.teacher_strategy, decisions.survivor.teacher_strategy)
})

test('strategy teacher rotates resolvers instead of reinforcing an observed movement loop', () => {
  const behavior = profile('hunter')
  const loopFrame = frame(behavior)
  loopFrame.input.feature_vector[191] = 0.5
  const sample = new GcStrategyV81Teacher(behavior).buildSample(loopFrame, session(behavior))
  assert.equal(loopFrame.input.strategy_mask[3], 1)
  assert.equal(loopFrame.history_before.previous_strategy, 'explore')
  assert.equal(sample.teacher_strategy, 'flee')
  assert.equal(sample.teacher_target_slot, null)
  assert.equal(sample.teacher_reason, 'profile_break_loop_flee')

  const fleeLoopFrame = structuredClone(loopFrame)
  fleeLoopFrame.history_before.previous_strategy = 'flee'
  const attackSample = new GcStrategyV81Teacher(behavior).buildSample(fleeLoopFrame, session(behavior))
  assert.equal(attackSample.teacher_strategy, 'attack_candidate_0')
  assert.equal(attackSample.teacher_target_slot, 0)
  assert.equal(attackSample.teacher_reason, 'profile_break_loop_attack')

  const attackLoopFrame = structuredClone(loopFrame)
  attackLoopFrame.history_before.previous_strategy = 'attack_candidate_0'
  const exploreSample = new GcStrategyV81Teacher(behavior).buildSample(attackLoopFrame, session(behavior))
  assert.equal(exploreSample.teacher_strategy, 'explore')
  assert.equal(exploreSample.teacher_target_slot, null)
  assert.equal(exploreSample.teacher_reason, 'profile_break_loop_explore')
})

test('v8.1 exporter writes 214 features and immutable strategy labels', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-v81-export-'))
  const dataDir = path.join(root, 'data')
  const exportDir = path.join(root, 'export')
  fs.mkdirSync(dataDir)
  const behavior = profile('hunter')
  const runtime = buildRuntimeContext(V81_OPERATION_CONTRACT, behavior)
  const store = new SqliteStore(dataDir, runtime)
  store.saveTrainingFrameBatch([frame(behavior)], [session(behavior)], 'tf1:AAAAAAAAAAE')
  store.saveTrainingResultBatch([result()], 'tr1:AAAAAAAAAAE')

  const exported = new TrainingExporter(store, exportDir, runtime, behavior).exportForTraining('claw-clash', 1)
  const manifest = JSON.parse(fs.readFileSync(exported.manifestPath, 'utf8'))
  assert.equal(manifest.feature_dim, 214)
  assert.equal(manifest.output_dim, 11)
  assert.equal(manifest.feature_schema_hash, SCHEMA_HASH)
  assert.deepEqual(manifest.strategy_labels, STRATEGY_LABELS)
  assert.equal(manifest.label_source, 'strategy_teacher_v8_1')
  const lines = fs.readFileSync(exported.ticksPath, 'utf8').trim().split('\n').map(line => line.split(','))
  assert.equal(lines[0].filter(column => /^f\d+$/.test(column)).length, 214)
  assert.equal(lines[1][lines[0].indexOf('strategy')], 'attack_candidate_0')
  store.close()
})
