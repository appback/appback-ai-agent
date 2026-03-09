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

    const provider = new OnnxProvider(key, { featureDim: config.featureDim })
    await provider.load(modelPath)
    this.providers.set(key, provider)
    log.info(`Registered model: ${key}`)
    return true
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
  }

  stopWatcher() {
    if (this._watcher) {
      this._watcher.close()
      this._watcher = null
    }
  }
}

module.exports = ModelRegistry
