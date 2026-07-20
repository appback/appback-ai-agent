const fs = require('fs')
const path = require('path')
const { createLogger } = require('../utils/logger')

const log = createLogger('gc-v81-auto-trainer')

class GcV81AutoTrainer {
  constructor(config) {
    this.store = config.store
    this.exporter = config.exporter
    this.trainer = config.trainer
    this.api = config.api
    this.runtimeContext = Object.freeze({ ...config.runtimeContext })
    this.outputDir = config.outputDir
    this.threshold = positiveInteger(config.threshold, 50)
    this.retryDelayMs = positiveInteger(config.retryDelayMs, 60 * 60 * 1000)
    this.statePath = path.join(this.outputDir, 'auto-training-state.json')
    this._running = false
  }

  get isRunning() { return this._running }

  async maybeTrain(game = 'claw-clash') {
    if (this.runtimeContext.feature_version !== '8.1') return { status: 'disabled' }
    if (this._running || this.trainer.isRunning) return { status: 'running' }

    const sessionCount = this.store.getCompletedTrainingSessionCount()
    const thresholdCount = Math.floor(sessionCount / this.threshold) * this.threshold
    if (thresholdCount < this.threshold) {
      return { status: 'collecting', sessionCount, required: this.threshold }
    }

    const state = this._readState()
    if (Number(state.last_success_session_count || 0) >= thresholdCount) {
      return { status: 'current', sessionCount, thresholdCount }
    }
    if (this._retryBlocked(state, thresholdCount)) {
      return { status: 'retry_wait', sessionCount, thresholdCount }
    }

    this._running = true
    try {
      return await this._trainAndUpload(game, sessionCount, thresholdCount)
    } finally {
      this._running = false
    }
  }

  async _trainAndUpload(game, sessionCount, thresholdCount) {
    this._writeState({
      status: 'running',
      attempted_session_count: thresholdCount,
      available_session_count: sessionCount,
    })
    try {
      const exported = this.exporter.exportForTraining(game, thresholdCount)
      if (!exported) throw new Error(`v8.1 export unavailable at ${sessionCount} completed sessions`)

      const trained = await this.trainer.run(game)
      if (!trained) throw new Error('v8.1 strategy training or offline gates failed')

      const modelPath = path.join(this.outputDir, 'gc_strategy_model.onnx')
      const metadata = readJson(path.join(this.outputDir, 'meta.json'))
      const evaluation = readJson(path.join(this.outputDir, 'evaluation.json'))
      this._validateArtifacts(modelPath, metadata, evaluation, exported)

      const uploaded = await this.api.uploadModelV8(modelPath, metadata)
      const revisionId = uploaded?.revision_id || uploaded?.id || null
      this._writeState({
        status: 'uploaded',
        attempted_session_count: thresholdCount,
        available_session_count: sessionCount,
        last_success_session_count: exported.sessionCount,
        dataset_manifest_hash: exported.datasetManifestHash,
        model_checksum: metadata.model_checksum,
        revision_id: revisionId,
      })
      log.info(
        `Uploaded v8.1 training candidate: sessions=${exported.sessionCount}, ` +
        `profile=${this.runtimeContext.behavior_profile_id}, revision=${revisionId || 'unknown'}`
      )
      return { status: 'uploaded', sessionCount: exported.sessionCount, thresholdCount, revisionId }
    } catch (error) {
      this._writeState({
        status: 'failed',
        attempted_session_count: thresholdCount,
        available_session_count: sessionCount,
        error: String(error.message || error).slice(0, 1000),
      })
      log.error('v8.1 automatic training failed', error.message)
      return { status: 'failed', sessionCount, thresholdCount, error: error.message }
    }
  }

  _validateArtifacts(modelPath, metadata, evaluation, exported) {
    if (!fs.existsSync(modelPath)) throw new Error(`trained model not found: ${modelPath}`)
    const expected = this.runtimeContext
    const exactFields = [
      'operation_version', 'feature_version', 'feature_schema_hash', 'training_version',
      'behavior_profile_id', 'behavior_profile_hash', 'behavior_profile_revision', 'output_dim',
    ]
    for (const field of exactFields) {
      if (metadata[field] !== expected[field]) {
        throw new Error(`trained metadata mismatch: ${field}=${metadata[field]}, expected=${expected[field]}`)
      }
    }
    if ((metadata.feature_dim ?? metadata.input_dim) !== expected.feature_dim) {
      throw new Error(`trained metadata mismatch: feature_dim=${metadata.feature_dim ?? metadata.input_dim}`)
    }
    if (!Array.isArray(metadata.action_labels) ||
        metadata.action_labels.length !== expected.strategy_labels.length ||
        metadata.action_labels.some((label, index) => label !== expected.strategy_labels[index])) {
      throw new Error('trained strategy label order does not match the active contract')
    }
    if (metadata.observation_policy !== 'same_profile_only') {
      throw new Error(`unsafe observation_policy=${metadata.observation_policy}`)
    }
    if (!Array.isArray(metadata.source_behavior_profile_hashes) ||
        metadata.source_behavior_profile_hashes.length !== 1 ||
        metadata.source_behavior_profile_hashes[0] !== expected.behavior_profile_hash) {
      throw new Error('source behavior profile does not match the active personality')
    }
    if (metadata.dataset_session_count !== exported.sessionCount ||
        metadata.dataset_manifest_hash !== exported.datasetManifestHash) {
      throw new Error('trained metadata does not match the exported dataset')
    }
    const failedGates = Object.entries(evaluation.offline_gates || {})
      .filter(([, passed]) => passed !== true)
      .map(([name]) => name)
    if (failedGates.length > 0) throw new Error(`offline gates failed: ${failedGates.join(', ')}`)
  }

  _retryBlocked(state, thresholdCount) {
    if (!['failed', 'running'].includes(state.status) ||
        Number(state.attempted_session_count || 0) !== thresholdCount) return false
    const updatedAt = Date.parse(state.updated_at || '')
    return Number.isFinite(updatedAt) && Date.now() - updatedAt < this.retryDelayMs
  }

  _readState() {
    if (!fs.existsSync(this.statePath)) return {}
    try {
      return readJson(this.statePath)
    } catch (error) {
      log.warn(`Ignoring invalid auto-training state: ${error.message}`)
      return {}
    }
  }

  _writeState(next) {
    fs.mkdirSync(this.outputDir, { recursive: true })
    const previous = this._readState()
    const state = {
      ...previous,
      ...next,
      operation_version: this.runtimeContext.operation_version,
      behavior_profile_hash: this.runtimeContext.behavior_profile_hash,
      updated_at: new Date().toISOString(),
    }
    if (state.status !== 'failed') delete state.error
    const temporary = `${this.statePath}.${process.pid}.tmp`
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`)
    fs.renameSync(temporary, this.statePath)
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function positiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

module.exports = GcV81AutoTrainer
