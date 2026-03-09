class BaseModelProvider {
  constructor(name, config) {
    this.name = name
    this.config = config
    this._loaded = false
    this._lastInferenceMs = 0
  }

  get isLoaded() { return this._loaded }
  get inferenceTimeMs() { return this._lastInferenceMs }

  async load(modelPath) { throw new Error('load not implemented') }
  async infer(features) { throw new Error('infer not implemented') }
  async unload() { this._loaded = false }
}

module.exports = BaseModelProvider
