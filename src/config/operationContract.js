const crypto = require('crypto')

const V7_OPERATION_CONTRACT = Object.freeze({
  schema_version: 1,
  operation_version: 'gc-v7-path-aware-r1',
  feature_version: '7.0',
  feature_dim: 153,
  feature_schema_id: 'gc-move-v7-path-aware-153-r1',
  feature_schema_hash: schemaHash('gc-move-v7-path-aware-153-r1'),
  training_version: 'v2_tick_reward',
  output_dim: 5,
})

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

const OPERATION_CONTRACTS = Object.freeze({
  v7: V7_OPERATION_CONTRACT,
  v8: V8_OPERATION_CONTRACT,
})
const CURRENT_OPERATION_CONTRACT = V7_OPERATION_CONTRACT

function schemaHash(schemaId) {
  return `sha256:${crypto.createHash('sha256').update(schemaId).digest('hex')}`
}

function contractsEqual(left, right) {
  if (!left || !right) return false
  return Object.keys(right)
    .every(key => left[key] === right[key])
}

function getOperationContract(nameOrVersion) {
  const requested = String(nameOrVersion || '').trim().toLowerCase()
  if (OPERATION_CONTRACTS[requested]) return OPERATION_CONTRACTS[requested]
  return Object.values(OPERATION_CONTRACTS)
    .find(contract => contract.operation_version.toLowerCase() === requested) || null
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
  V7_OPERATION_CONTRACT,
  V8_OPERATION_CONTRACT,
  buildRuntimeContext,
  contractsEqual,
  getOperationContract,
  profileSegment,
  safeSegment,
  schemaHash,
}
