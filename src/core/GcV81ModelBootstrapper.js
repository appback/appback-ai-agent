const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { MODEL_AUTO_ROLLOUT_CAPABILITY } = require('../config/GcServerContract')

const SUPPORTED_PROFILES = new Set(['balanced', 'hunter', 'survivor', 'navigator'])
const SCHEMA_HASH = 'sha256:330be3849f095e9ffca2c46bb4a13b2c9cbbc0c55aade67aa163e0307a1e1a82'

class GcV81ModelBootstrapper {
  constructor({ api, runtimeContext, assetsRoot }) {
    this.api = api
    this.runtimeContext = runtimeContext
    this.assetsRoot = assetsRoot
    this.inFlight = null
  }

  ensure(capabilities = {}) {
    if (this.inFlight) return this.inFlight
    this.inFlight = this._ensure(capabilities).finally(() => { this.inFlight = null })
    return this.inFlight
  }

  async _ensure(capabilities) {
    if (this.runtimeContext.feature_version !== '8.1') return { status: 'disabled' }
    if (capabilities[MODEL_AUTO_ROLLOUT_CAPABILITY] !== true) return { status: 'server_unsupported' }

    const profileID = this.runtimeContext.behavior_profile_id
    if (!SUPPORTED_PROFILES.has(profileID)) {
      return { status: 'profile_unsupported', profileId: profileID }
    }

    const listed = await this.api.listModelsV8()
    const revisions = listed.revisions || listed.models || []
    const existing = revisions.find(revision =>
      revision.feature_version === '8.1' &&
      revision.feature_schema_hash === SCHEMA_HASH &&
      revision.behavior_profile_hash === this.runtimeContext.behavior_profile_hash
    )
    if (existing) return { status: 'current', revisionId: existing.revision_id }

    const profileDir = path.join(this.assetsRoot, profileID)
    const modelPath = path.join(profileDir, 'gc_strategy_model.onnx')
    const metadata = JSON.parse(fs.readFileSync(path.join(profileDir, 'meta.json'), 'utf8'))
    const evaluationPath = path.join(profileDir, 'evaluation.json')
    assertDigest(modelPath, metadata.model_checksum, 'bootstrap model')
    assertDigest(evaluationPath, metadata.evaluation_report_digest, 'bootstrap evaluation')
    if (metadata.feature_version !== '8.1' || metadata.feature_dim !== 214 ||
        metadata.output_dim !== 11 || metadata.feature_schema_hash !== SCHEMA_HASH ||
        metadata.behavior_profile_id !== profileID || metadata.observation_policy !== 'synthetic_bootstrap') {
      throw new Error(`Invalid bundled v8.1 bootstrap contract for ${profileID}`)
    }

    metadata.behavior_profile_hash = this.runtimeContext.behavior_profile_hash
    metadata.behavior_profile_revision = Math.max(1, this.runtimeContext.behavior_profile_revision || 0)
    const uploaded = await this.api.uploadModelV8(modelPath, metadata)
    return { status: 'uploaded', revisionId: uploaded.revision_id, profileId: profileID }
  }
}

function assertDigest(filePath, expected, label) {
  const actual = `sha256:${crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')}`
  if (actual !== expected) throw new Error(`${label} checksum mismatch`)
}

module.exports = GcV81ModelBootstrapper
