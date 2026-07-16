const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const SCHEMA_PATH = path.join(__dirname, '..', '..', 'config', 'gc-v8.1', 'feature_schema_v8_1.json')
const SCHEMA_BYTES = fs.readFileSync(SCHEMA_PATH)
const SCHEMA = Object.freeze(JSON.parse(SCHEMA_BYTES.toString('utf8')))
const SCHEMA_HASH = `sha256:${crypto.createHash('sha256').update(SCHEMA_BYTES).digest('hex')}`

function assertCanonicalStrategyV81Schema() {
  if (SCHEMA.schema_id !== 'gc-strategy-v8-214-r1') throw new Error(`unexpected v8.1 schema_id: ${SCHEMA.schema_id}`)
  if (SCHEMA.feature_version !== '8.1') throw new Error(`unexpected v8.1 feature_version: ${SCHEMA.feature_version}`)
  if (SCHEMA.feature_dim !== 214 || SCHEMA.output_dim !== 11) {
    throw new Error(`unexpected v8.1 shape: ${SCHEMA.feature_dim}x${SCHEMA.output_dim}`)
  }
  if (!Array.isArray(SCHEMA.features) || SCHEMA.features.length !== SCHEMA.feature_dim) {
    throw new Error('v8.1 schema must define exactly 214 features')
  }
  SCHEMA.features.forEach((feature, index) => {
    if (feature.index !== index) throw new Error(`v8.1 schema index ${index} is not contiguous`)
  })
  const labels = [
    'hold', 'flee', 'seek_powerup', 'explore',
    'attack_candidate_0', 'attack_candidate_1', 'attack_candidate_2',
    'attack_candidate_3', 'attack_candidate_4', 'attack_candidate_5', 'attack_candidate_6',
  ]
  if (JSON.stringify(SCHEMA.strategy_labels) !== JSON.stringify(labels)) {
    throw new Error('v8.1 strategy label order mismatch')
  }
  return true
}

assertCanonicalStrategyV81Schema()

module.exports = {
  SCHEMA,
  SCHEMA_BYTES,
  SCHEMA_HASH,
  SCHEMA_PATH,
  STRATEGY_LABELS: Object.freeze([...SCHEMA.strategy_labels]),
  WEAPON_ORDER: Object.freeze([...SCHEMA.weapon_order]),
  assertCanonicalStrategyV81Schema,
}
