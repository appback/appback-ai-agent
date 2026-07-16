const crypto = require('crypto')
const { PRESETS, OBJECTIVE_KEYS, POLICY_KEYS, EQUIPMENT_KEYS } = require('./personalityPresets')
const { OBJECTIVE_RANGE, POLICY_RANGES, EQUIPMENT_RANGE, assertValidProfile } = require('./ProfileValidator')

function compileProfile(profile) {
  assertValidProfile(profile)

  const behavior = profile.mode === 'easy'
    ? compileEasy(profile)
    : compileExpert(profile)
  const hashPayload = canonicalJson({
    schema_version: behavior.schema_version,
    mode: behavior.mode,
    profile_id: behavior.profile_id,
    objective: behavior.objective,
    policy: behavior.policy,
    equipment: behavior.equipment,
  })

  return {
    ...behavior,
    profile_hash: `sha256:${crypto.createHash('sha256').update(hashPayload).digest('hex')}`,
  }
}

function compileEasy(profile) {
  const source = PRESETS[profile.preset]
  const variation = profile.variation_percent / 100
  const objective = {}
  const policy = {}
  const equipment = {}

  for (const key of OBJECTIVE_KEYS) {
    objective[key] = varyNumber(source.objective[key], variation, profile.seed, `objective.${key}`, OBJECTIVE_RANGE)
  }
  for (const key of POLICY_KEYS) {
    policy[key] = varyNumber(source.policy[key], variation, profile.seed, `policy.${key}`, POLICY_RANGES[key])
  }
  for (const key of EQUIPMENT_KEYS) {
    equipment[key] = varyNumber(source.equipment[key], variation, profile.seed, `equipment.${key}`, EQUIPMENT_RANGE)
  }

  return {
    schema_version: 1,
    mode: 'easy',
    profile_id: profile.preset,
    label: source.label,
    variation_percent: profile.variation_percent,
    seed: profile.seed,
    objective,
    policy,
    equipment,
  }
}

function compileExpert(profile) {
  return {
    schema_version: 1,
    mode: 'expert',
    profile_id: profile.name,
    label: profile.name,
    variation_percent: 0,
    seed: null,
    objective: clone(profile.objective),
    policy: clone(profile.policy),
    equipment: clone(profile.equipment || PRESETS.balanced.equipment),
  }
}

function varyNumber(value, variation, seed, field, range) {
  const random = deterministicRandom(seed, field)
  const varied = value * (1 + ((random * 2) - 1) * variation)
  const clamped = Math.max(range.min, Math.min(range.max, varied))
  if (range.integer) return Math.round(clamped)
  return Number(clamped.toFixed(6))
}

function deterministicRandom(seed, field) {
  const digest = crypto.createHash('sha256').update(`${seed}:${field}`).digest()
  return digest.readUInt32BE(0) / 0xffffffff
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value)
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

module.exports = { compileProfile, canonicalJson }
