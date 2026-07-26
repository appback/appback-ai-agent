const { SCHEMA_HASH: V81_SCHEMA_HASH, STRATEGY_LABELS } = require('./gcStrategyV81Contract')

const V8_OPERATION_CONTRACT = Object.freeze({
  schema_version: 1,
  operation_version: 'gc-v8-r1',
  feature_version: '8.0',
  feature_dim: 192,
  feature_schema_id: 'gc-feature-v8-192',
  feature_schema_hash: 'sha256:c375d624fed00997eab3c307947d352dc9d5ad6e742444503fc1f23c8b8478d1',
  training_version: 'teacher-v8-r1',
  output_dim: 5,
})

const V81_R1_OPERATION_CONTRACT = Object.freeze({
  schema_version: 1,
  operation_version: 'gc-v8-strategy-r1',
  feature_version: '8.1',
  feature_dim: 214,
  feature_schema_id: 'gc-strategy-v8-214-r1',
  feature_schema_hash: V81_SCHEMA_HASH,
  training_version: 'teacher-strategy-v8-r1',
  output_dim: 11,
  strategy_labels: STRATEGY_LABELS,
})

const V81_OPERATION_CONTRACT = Object.freeze({
  ...V81_R1_OPERATION_CONTRACT,
  operation_version: 'gc-v8-strategy-r2',
  training_version: 'teacher-strategy-v8-r2',
})

const OPERATION_CONTRACTS = Object.freeze({
  v8: V8_OPERATION_CONTRACT,
  v81: V81_OPERATION_CONTRACT,
  v81r1: V81_R1_OPERATION_CONTRACT,
})
const CURRENT_OPERATION_CONTRACT = V81_OPERATION_CONTRACT

function contractsEqual(left, right) {
  if (!left || !right) return false
  return Object.keys(right)
    .every(key => contractValueEqual(left[key], right[key]))
}

function contractValueEqual(left, right) {
  if (left === right) return true
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => contractValueEqual(value, right[index]))
  }
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    const leftKeys = Object.keys(left).sort()
    const rightKeys = Object.keys(right).sort()
    return contractValueEqual(leftKeys, rightKeys) && leftKeys.every(key => contractValueEqual(left[key], right[key]))
  }
  return false
}

function getOperationContract(nameOrVersion) {
  const requested = String(nameOrVersion || '').trim().toLowerCase()
  if (OPERATION_CONTRACTS[requested]) return OPERATION_CONTRACTS[requested]
  return Object.values(OPERATION_CONTRACTS)
    .find(contract => contract.operation_version.toLowerCase() === requested || contract.feature_version === requested) || null
}

function safeSegment(value) {
  const normalized = String(value || 'unknown').toLowerCase().replace(/[^a-z0-9._-]+/g, '-')
  return normalized.replace(/^-+|-+$/g, '') || 'unknown'
}

function profileSegment(profileHash) {
  return safeSegment(String(profileHash || 'unknown').replace(/^sha256:/, ''))
}

function buildRuntimeContext(contract, behaviorProfile) {
  const effective = behaviorProfile?.effective || behaviorProfile || {}
  return Object.freeze({
    ...contract,
    behavior_profile_id: effective.profile_id || 'unknown',
    behavior_profile_hash: effective.profile_hash || 'unknown',
    behavior_profile_revision: effective.source_revision || 0,
  })
}

module.exports = {
  CURRENT_OPERATION_CONTRACT,
  OPERATION_CONTRACTS,
  V8_OPERATION_CONTRACT,
  V81_OPERATION_CONTRACT,
  V81_R1_OPERATION_CONTRACT,
  buildRuntimeContext,
  contractsEqual,
  getOperationContract,
  profileSegment,
  safeSegment,
}
