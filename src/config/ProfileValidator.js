const { PRESETS, OBJECTIVE_KEYS, POLICY_KEYS, EQUIPMENT_KEYS } = require('./personalityPresets')

const OBJECTIVE_RANGE = Object.freeze({ min: 0, max: 2 })
const EQUIPMENT_RANGE = Object.freeze({ min: 0, max: 2 })
const POLICY_RANGES = Object.freeze({
  flee_hp_ratio: { min: 0.05, max: 0.8 },
  max_chase_path: { min: 1, max: 32, integer: true },
  replan_ticks: { min: 1, max: 10, integer: true },
  target_persistence: { min: 0, max: 1 },
  teacher_exploration_rate: { min: 0, max: 0.15 },
})

function validateProfile(profile) {
  const errors = []

  if (!isPlainObject(profile)) return ['Profile must be a JSON object']
  if (profile.schema_version !== 1) errors.push('schema_version must be 1')
  if (!['easy', 'expert'].includes(profile.mode)) errors.push('mode must be easy or expert')

  if (profile.mode === 'easy') validateEasy(profile, errors)
  if (profile.mode === 'expert') validateExpert(profile, errors)

  return errors
}

function assertValidProfile(profile) {
  const errors = validateProfile(profile)
  if (errors.length) {
    const err = new Error(`Invalid personality profile:\n- ${errors.join('\n- ')}`)
    err.validationErrors = errors
    throw err
  }
  return profile
}

function validateEasy(profile, errors) {
  rejectUnknown(profile, ['schema_version', 'mode', 'preset', 'variation_percent', 'seed', 'revision'], '', errors)

  if (!Object.prototype.hasOwnProperty.call(PRESETS, profile.preset)) {
    errors.push(`preset must be one of: ${Object.keys(PRESETS).join(', ')}`)
  }
  validateNumber(profile.variation_percent, 'variation_percent', { min: 0, max: 15 }, errors)
  validateNumber(profile.seed, 'seed', { min: 0, max: 0xffffffff, integer: true }, errors)
  if (profile.revision != null) validateNumber(profile.revision, 'revision', { min: 0, max: Number.MAX_SAFE_INTEGER, integer: true }, errors)
}

function validateExpert(profile, errors) {
  rejectUnknown(profile, ['schema_version', 'mode', 'name', 'objective', 'policy', 'equipment', 'revision'], '', errors)

  if (typeof profile.name !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,39}$/i.test(profile.name)) {
    errors.push('name must be 1-40 characters using letters, numbers, _ or -')
  }

  validateNumberMap(profile.objective, OBJECTIVE_KEYS, OBJECTIVE_RANGE, 'objective', errors)

  if (!isPlainObject(profile.policy)) {
    errors.push('policy must be an object')
  } else {
    rejectUnknown(profile.policy, POLICY_KEYS, 'policy', errors)
    for (const key of POLICY_KEYS) {
      validateNumber(profile.policy[key], `policy.${key}`, POLICY_RANGES[key], errors)
    }
  }

  // Existing Expert profiles compile with balanced equipment defaults.
  if (profile.equipment != null) {
    validateNumberMap(profile.equipment, EQUIPMENT_KEYS, EQUIPMENT_RANGE, 'equipment', errors)
  }

  if (profile.revision != null) validateNumber(profile.revision, 'revision', { min: 0, max: Number.MAX_SAFE_INTEGER, integer: true }, errors)
}

function validateNumberMap(value, keys, range, prefix, errors) {
  if (!isPlainObject(value)) {
    errors.push(`${prefix} must be an object`)
    return
  }
  rejectUnknown(value, keys, prefix, errors)
  for (const key of keys) validateNumber(value[key], `${prefix}.${key}`, range, errors)
}

function validateNumber(value, label, range, errors) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`${label} must be a finite number`)
    return
  }
  if (value < range.min || value > range.max) {
    errors.push(`${label} must be between ${range.min} and ${range.max}`)
  }
  if (range.integer && !Number.isInteger(value)) errors.push(`${label} must be an integer`)
}

function rejectUnknown(value, allowed, prefix, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(`Unknown field: ${prefix ? `${prefix}.` : ''}${key}`)
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

module.exports = {
  OBJECTIVE_RANGE,
  EQUIPMENT_RANGE,
  POLICY_RANGES,
  validateProfile,
  assertValidProfile,
}
