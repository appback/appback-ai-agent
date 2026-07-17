const fs = require('fs')
const path = require('path')
const OnnxProvider = require('../models/providers/OnnxProvider')
const { createLogger } = require('../utils/logger')
const log = createLogger('model-registry')

class ModelRegistry {
  constructor(modelDir) {
    this.modelDir = modelDir || './models'
    this.providers = new Map() // key -> OnnxProvider
    this._watcher = null
  }

  async loadModel(gameKey, modelKey, config = {}) {
    const key = `${gameKey}/${modelKey}`
    const modelPath = path.join(this.modelDir, gameKey, config.path || `${modelKey}.onnx`)

    if (!fs.existsSync(modelPath)) {
      log.warn(`Model file not found: ${modelPath}`)
      return false
    }

    if (config.runtimeContext) this._validateContract(modelPath, config.runtimeContext)

    const provider = new OnnxProvider(key, { featureDim: config.featureDim })
    await provider.load(modelPath)
    this.providers.set(key, provider)
    log.info(`Registered model: ${key}`)
    return true
  }

  _validateContract(modelPath, expected) {
    const metaPath = path.join(path.dirname(modelPath), 'meta.json')
    if (!fs.existsSync(metaPath)) throw new Error(`Model metadata not found: ${metaPath}`)

    let meta
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
    } catch (err) {
      throw new Error(`Invalid model metadata: ${err.message}`)
    }

    const required = [
      'operation_version',
      'feature_version',
      'feature_schema_hash',
      'training_version',
      'behavior_profile_hash',
    ]
    for (const key of required) {
      if (meta[key] !== expected[key]) {
        throw new Error(`Model contract mismatch: ${key}=${meta[key] || 'missing'}, expected=${expected[key]}`)
      }
    }
    const inputDim = meta.feature_dim ?? meta.input_dim
    if (inputDim !== expected.feature_dim || meta.output_dim !== expected.output_dim) {
      throw new Error(
        `Model shape mismatch: ${inputDim}x${meta.output_dim}, ` +
        `expected=${expected.feature_dim}x${expected.output_dim}`
      )
    }
  }

  getProvider(gameKey, modelKey) {
    return this.providers.get(`${gameKey}/${modelKey}`) || null
  }

  async hotReload(gameKey, modelKey, config = {}) {
    const key = `${gameKey}/${modelKey}`
    const old = this.providers.get(key)

    try {
      await this.loadModel(gameKey, modelKey, config)
      if (old) await old.unload()
      log.info(`Hot-reloaded: ${key}`)
      return true
    } catch (err) {
      log.error(`Hot-reload failed: ${key}`, err.message)
      return false
    }
  }

  startWatcher() {
    if (this._watcher) return

    const modelsDir = this.modelDir
    if (!fs.existsSync(modelsDir)) return

    try {
      this._watcher = fs.watch(modelsDir, { recursive: true }, (eventType, filename) => {
        if (!filename?.endsWith('.onnx')) return
        const parts = filename.split(path.sep)
        if (parts.length >= 2) {
          const gameKey = parts[0]
          const modelKey = parts[1].replace('.onnx', '')
          log.info(`Model file changed: ${filename}, triggering reload`)
          this.hotReload(gameKey, modelKey).catch(() => {})
        }
      })
      log.info('Model directory watcher started')
    } catch (err) {
      log.warn(`Model watcher unavailable (${err.message}), hot-reload disabled`)
    }
  }

  stopWatcher() {
    if (this._watcher) {
      this._watcher.close()
      this._watcher = null
    }
  }
}

module.exports = ModelRegistry
