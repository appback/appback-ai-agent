const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { GcStrategyV81FeatureBuilder } = require('../adapters/gc/GcStrategyV81FeatureBuilder')
const { compileProfile, canonicalJson } = require('../config/ProfileCompiler')
const { SCHEMA, SCHEMA_HASH, STRATEGY_LABELS } = require('../config/gcStrategyV81Contract')
const { GcStrategyV81Teacher } = require('./GcStrategyV81Teacher')

const PROFILE_NAMES = Object.freeze(['balanced', 'hunter', 'survivor', 'navigator'])
const OPERATION_VERSION = 'gc-v8-strategy-r1'
const TRAINING_VERSION = 'teacher-strategy-v8-r1'
const GENERATOR_VERSION = 'gc-v81-bootstrap-r1'

function generateSyntheticBootstrap(options = {}) {
  const outputRoot = path.resolve(options.outputRoot || 'training/data/v8.1-round7')
  const sessionsPerProfile = positiveInteger(options.sessionsPerProfile, 256)
  const samplesPerSession = positiveInteger(options.samplesPerSession, 8)
  const seed = Number.isInteger(options.seed) ? options.seed : 8107
  const scenarios = Array.from(
    { length: sessionsPerProfile * samplesPerSession },
    (_, index) => buildScenario(seed, index),
  )
  const summaries = PROFILE_NAMES.map(profileName => {
    const behavior = {
      ...compileProfile({
        schema_version: 1,
        mode: 'easy',
        preset: profileName,
        variation_percent: 0,
        seed,
      }),
      source_revision: 1,
    }
    return exportProfileDataset({
      outputDir: path.join(outputRoot, profileName),
      profileName,
      behavior,
      scenarios,
      sessionsPerProfile,
      samplesPerSession,
      seed,
    })
  })

  return { outputRoot, generatorVersion: GENERATOR_VERSION, seed, summaries }
}

function exportProfileDataset(options) {
  const {
    outputDir, profileName, behavior, scenarios, sessionsPerProfile, samplesPerSession, seed,
  } = options
  const builder = new GcStrategyV81FeatureBuilder()
  const teacher = new GcStrategyV81Teacher(behavior)
  const sessions = []
  const rows = []
  const labelCounts = Object.fromEntries(STRATEGY_LABELS.map(label => [label, 0]))

  for (let sessionIndex = 0; sessionIndex < sessionsPerProfile; sessionIndex++) {
    const sessionID = deterministicUUID(`${seed}:${profileName}:session:${sessionIndex}`)
    const gameID = deterministicUUID(`${seed}:${profileName}:game:${sessionIndex}`)
    const session = {
      session_id: sessionID,
      game_id: gameID,
      agent_slot: 0,
      manifest: {
        synthetic: true,
        synthetic_generator: GENERATOR_VERSION,
        synthetic_seed: seed,
        strategy_candidates: [],
        capabilities: { powerups: false, shrink_safe_zone: false },
        behavior_profile: {
          id: behavior.profile_id,
          hash: behavior.profile_hash,
          revision: behavior.source_revision,
        },
      },
    }
    sessions.push(session)

    for (let offset = 0; offset < samplesPerSession; offset++) {
      const scenarioIndex = sessionIndex * samplesPerSession + offset
      const scenario = scenarios[scenarioIndex]
      const built = builder.build(scenario)
      session.manifest.strategy_candidates = built.candidates
      const frame = makeFrame({
        frameID: deterministicUUID(`${seed}:${profileName}:frame:${scenarioIndex}`),
        session,
        scenario,
        built,
        behavior,
      })
      const result = syntheticResult(scenario, session)
      const label = teacher.buildSample(frame, session, result)
      const labelIndex = STRATEGY_LABELS.indexOf(label.teacher_strategy)
      if (labelIndex < 0 || built.strategyMask[labelIndex] !== 1) {
        throw new Error(`teacher emitted invalid strategy ${label.teacher_strategy} for scenario ${scenarioIndex}`)
      }
      labelCounts[label.teacher_strategy]++
      rows.push({ frame, label, result, scenarioKind: scenario.synthetic_kind })
    }
  }

  const sessionIDs = sessions.map(session => session.session_id).sort()
  const descriptor = {
    generator_version: GENERATOR_VERSION,
    seed,
    profile: profileName,
    behavior_profile_hash: behavior.profile_hash,
    scenario_count: rows.length,
    session_ids: sessionIDs,
    frame_ids: rows.map(row => row.frame.frame_id).sort(),
    labels: rows.map(row => row.label.teacher_strategy),
  }
  const datasetManifestHash = sha256(canonicalJson(descriptor))
  const manifest = {
    operation_version: OPERATION_VERSION,
    feature_version: '8.1',
    feature_dim: 214,
    feature_schema_id: SCHEMA.schema_id,
    feature_schema_hash: SCHEMA_HASH,
    output_dim: 11,
    strategy_labels: [...STRATEGY_LABELS],
    training_version: TRAINING_VERSION,
    behavior_profile_id: behavior.profile_id,
    behavior_profile_hash: behavior.profile_hash,
    behavior_profile_revision: behavior.source_revision,
    dataset_manifest_hash: datasetManifestHash,
    dataset_session_count: sessions.length,
    dataset_session_from: sessionIDs[0],
    dataset_session_to: sessionIDs[sessionIDs.length - 1],
    sample_count: rows.length,
    observation_policy: 'synthetic_bootstrap',
    source_behavior_profile_hashes: [],
    generator_version: GENERATOR_VERSION,
    generator_seed: seed,
    scenario_kinds: [...new Set(scenarios.map(scenario => scenario.synthetic_kind))].sort(),
    label_counts: labelCounts,
  }

  fs.mkdirSync(outputDir, { recursive: true })
  writeJson(path.join(outputDir, 'operation-manifest.json'), manifest)
  writeJson(path.join(outputDir, 'claw-clash_sessions.json'), sessions)
  writeTicks(path.join(outputDir, 'claw-clash_ticks.csv'), rows)

  return {
    profile: profileName,
    outputDir,
    profileHash: behavior.profile_hash,
    datasetManifestHash,
    sessionCount: sessions.length,
    sampleCount: rows.length,
    labelCounts,
  }
}

function makeFrame({ frameID, session, scenario, built, behavior }) {
  return {
    record_version: 2,
    frame_id: frameID,
    session_id: session.session_id,
    game_id: session.game_id,
    tick: scenario.tick,
    decision_seq: 0,
    agent: { slot: scenario.agents[scenario.self_index].slot },
    contract: {
      operation_version: OPERATION_VERSION,
      feature_version: '8.1',
      feature_dim: 214,
      feature_schema_hash: SCHEMA_HASH,
      training_version: TRAINING_VERSION,
    },
    behavior_profile: {
      id: behavior.profile_id,
      hash: behavior.profile_hash,
      revision: behavior.source_revision,
    },
    input: { feature_vector: built.featureVector, strategy_mask: built.strategyMask },
    inference: { status: 'synthetic', raw_argmax_strategy: 'hold', model_strategy: 'hold' },
    execution: {
      executed_strategy: 'hold', selected_target_slot: -1, executed_target_slot: -1,
      path_action: 'stay', executed_action: 'stay',
      strategy_override_reason: null, movement_override_reason: null,
    },
    history_before: scenario.history,
    state: { agents: scenario.agents, powerups: [] },
  }
}

function syntheticResult(scenario, session) {
  const self = scenario.agents[scenario.self_index]
  return {
    session_id: session.session_id,
    game_id: session.game_id,
    agent_slot: self.slot,
    rank: scenario.synthetic_kind === 'danger' ? 3 : 2,
    score: self.score,
    kills: self.kills,
    damage_dealt: self.damage_dealt,
    damage_taken: self.damage_taken,
    survived_ticks: self.survived_ticks,
    completed: true,
    finish_reason: 'synthetic_fixture',
  }
}

function writeTicks(filePath, rows) {
  const header = ['session_id', 'frame_id', 'tick']
  for (let index = 0; index < 214; index++) header.push(`f${index}`)
  header.push('strategy', 'sample_weight', 'observed_strategy', 'executed_strategy', 'teacher_reason', 'rank', 'score', 'scenario_kind')
  const lines = [header.join(',')]
  for (const row of rows) {
    const values = [row.frame.session_id, row.frame.frame_id, row.frame.tick, ...row.frame.input.feature_vector]
    values.push(
      row.label.teacher_strategy,
      row.label.sample_weight,
      row.label.observed_strategy,
      row.label.executed_strategy,
      row.label.teacher_reason,
      row.result.rank,
      row.result.score,
      row.scenarioKind,
    )
    lines.push(values.join(','))
  }
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`)
}

function buildScenario(seed, index) {
  const random = mulberry32((seed + index * 0x9e3779b1) >>> 0)
  const kinds = ['combat', 'choice', 'danger', 'stuck', 'maze', 'open']
  const kind = kinds[index % kinds.length]
  const width = 9
  const height = 9
  const terrain = Array.from({ length: height }, () => new Array(width).fill(0))
  if (kind === 'maze') {
    const gap = 1 + (index % 7)
    for (let y = 0; y < height; y++) if (y !== gap) terrain[y][4] = 1
  } else if (kind === 'stuck') {
    terrain[3][3] = 1
    terrain[3][5] = 1
    terrain[2][4] = 1
  }

  const selfPosition = kind === 'maze' ? { x: 2, y: 4 } : { x: 4, y: 4 }
  const positions = candidatePositions(kind, index)
  const selfHpRatio = kind === 'danger' ? 0.12 + random() * 0.22 : 0.48 + random() * 0.5
  const self = agent({
    slot: 0, ...selfPosition, hpRatio: selfHpRatio,
    weapon: ['sword', 'bow', 'spear'][index % 3],
    damage: 7 + random() * 8, range: index % 3 === 1 ? 3 : 1,
    rangeType: index % 3 === 1 ? 'ranged' : (index % 3 === 2 ? 'pierce' : 'adjacent'),
    armor: 1 + random() * 5, actionAcc: 35 + random() * 65,
    score: Math.floor(random() * 500), kills: Math.floor(random() * 3),
    damageDealt: Math.floor(random() * 350), damageTaken: Math.floor(random() * 250), tick: index % 300,
  })
  const enemies = positions.map((position, candidate) => {
    let hpRatio = 0.2 + random() * 0.75
    let damage = 5 + random() * 13
    let range = 1 + Math.floor(random() * 3)
    let rangeType = range > 1 ? 'ranged' : 'adjacent'
    if (kind === 'choice') {
      hpRatio = candidate === index % positions.length ? 0.08 + random() * 0.14 : 0.65 + random() * 0.3
      damage = candidate === 0 ? 16 : 7 + candidate
    }
    if (kind === 'danger' && candidate < 2) {
      damage = 15 + random() * 5
      range = 3
      rangeType = 'ranged'
    }
    return agent({
      slot: candidate + 1, ...position, hpRatio, weapon: ['axe', 'bow', 'spear', 'sword'][candidate % 4],
      damage, range, rangeType, armor: random() * 7, actionAcc: random() * 100,
      score: Math.floor(random() * 700), kills: Math.floor(random() * 4),
      damageDealt: Math.floor(random() * 500), damageTaken: Math.floor(random() * 350), tick: index % 300,
    })
  })
  const visits = kind === 'stuck'
    ? [{ x: self.x, y: self.y, count: 8 }, { x: self.x, y: self.y + 1, count: 6 }]
    : [{ x: self.x, y: self.y, count: Math.floor(random() * 3) }]
  return {
    synthetic_kind: kind,
    game: { width, height, terrain, max_ticks: 300 },
    agents: [self, ...enemies],
    self_index: 0,
    tick: index % 300,
    capabilities: { powerups: false, shrink_safe_zone: false },
    history: {
      previous_hp: Math.min(self.max_hp, self.hp + random() * 8),
      previous_score: Math.max(0, self.score - Math.floor(random() * 30)),
      previous_damage_dealt: Math.max(0, self.damage_dealt - Math.floor(random() * 20)),
      previous_damage_taken: Math.max(0, self.damage_taken - Math.floor(random() * 20)),
      previous_strategy: kind === 'stuck' ? 'explore' : STRATEGY_LABELS[index % STRATEGY_LABELS.length],
      same_position_streak: kind === 'stuck' ? 5 + Math.floor(random() * 4) : Math.floor(random() * 2),
      no_progress_actions: kind === 'stuck' ? 10 + Math.floor(random() * 7) : Math.floor(random() * 3),
      two_cycle_count: kind === 'stuck' ? 3 : 0,
      three_cycle_count: kind === 'stuck' ? 2 : 0,
      selected_target_streak: Math.floor(random() * 5),
      visits,
    },
  }
}

function candidatePositions(kind, index) {
  if (kind === 'maze') {
    return [
      { x: 7, y: 4 }, { x: 2, y: 1 }, { x: 7, y: 7 }, { x: 1, y: 7 },
      { x: 6, y: 1 }, { x: 2, y: 7 }, { x: 7, y: 2 },
    ]
  }
  if (kind === 'danger') {
    return [
      { x: 4, y: 2 }, { x: 6, y: 4 }, { x: 1, y: 7 }, { x: 7, y: 7 },
      { x: 1, y: 1 }, { x: 7, y: 1 }, { x: 4, y: 7 },
    ]
  }
  if (kind === 'stuck') {
    return [
      { x: 7, y: 4 }, { x: 1, y: 1 }, { x: 7, y: 7 }, { x: 1, y: 7 },
      { x: 6, y: 1 }, { x: 2, y: 7 }, { x: 7, y: 2 },
    ]
  }
  const variants = [
    [
      { x: 4, y: 1 }, { x: 7, y: 4 }, { x: 1, y: 7 }, { x: 7, y: 7 },
      { x: 1, y: 1 }, { x: 7, y: 1 }, { x: 4, y: 7 },
    ],
    [
      { x: 2, y: 4 }, { x: 4, y: 7 }, { x: 7, y: 2 }, { x: 1, y: 1 },
      { x: 7, y: 7 }, { x: 1, y: 7 }, { x: 4, y: 1 },
    ],
    [
      { x: 4, y: 6 }, { x: 1, y: 4 }, { x: 7, y: 7 }, { x: 7, y: 1 },
      { x: 1, y: 1 }, { x: 1, y: 7 }, { x: 6, y: 4 },
    ],
  ]
  return variants[index % variants.length]
}

function agent(options) {
  const maxHp = 100
  return {
    slot: options.slot, x: options.x, y: options.y,
    hp: Number((options.hpRatio * maxHp).toFixed(6)), max_hp: maxHp, alive: true,
    weapon: options.weapon, range_type: options.rangeType,
    damage_min: Number(Math.max(1, options.damage - 2).toFixed(6)),
    damage_max: Number((options.damage + 2).toFixed(6)),
    range: options.range, armor_reduction: Number(options.armor.toFixed(6)), bonus_defense: 0,
    evasion: 0.05, speed: 100, action_acc: Number(options.actionAcc.toFixed(6)),
    score: options.score, kills: options.kills, damage_dealt: options.damageDealt,
    damage_taken: options.damageTaken, survived_ticks: options.tick,
  }
}

function deterministicUUID(value) {
  const bytes = Buffer.from(crypto.createHash('sha256').update(value).digest().subarray(0, 16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function mulberry32(seed) {
  return function random() {
    seed |= 0
    seed = seed + 0x6d2b79f5 | 0
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed)
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value
    return ((value ^ value >>> 14) >>> 0) / 4294967296
  }
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback
}

module.exports = {
  GENERATOR_VERSION,
  PROFILE_NAMES,
  generateSyntheticBootstrap,
}
