const BaseModelProvider = require('../../core/BaseModelProvider')
const { createLogger } = require('../../utils/logger')
const log = createLogger('onnx')

let ort = null
try {
  ort = require('onnxruntime-node')
} catch {
  log.warn('onnxruntime-node not available, ONNX inference disabled')
}

class OnnxProvider extends BaseModelProvider {
  constructor(name, config = {}) {
    super(name, config)
    this.session = null
    this.featureDim = config.featureDim || 0
  }

  async load(modelPath) {
    if (!ort) throw new Error('onnxruntime-node not installed')
    try {
      this.session = await ort.InferenceSession.create(modelPath, {
        executionProviders: ['cpu'],
      })
      this._loaded = true
      log.info(`Model loaded: ${this.name} (${modelPath})`)
    } catch (err) {
      log.error(`Failed to load model: ${this.name}`, err.message)
      throw err
    }
  }

  async infer(features) {
    if (!this.session) return null
    const start = Date.now()
    try {
      const tensor = new ort.Tensor(
        'float32',
        Float32Array.from(features),
        [1, features.length]
      )
      const results = await this.session.run({ input: tensor })
      const outputKey = Object.keys(results)[0]
      const logits = Array.from(results[outputKey].data)
      const idx = argmax(logits)
      const probs = softmax(logits)

      this._lastInferenceMs = Date.now() - start
      return { logits, decision: idx, confidence: probs[idx], probs }
    } catch (err) {
      log.error(`Inference error: ${this.name}`, err.message)
      return null
    }
  }

  async unload() {
    this.session = null
    this._loaded = false
    log.info(`Model unloaded: ${this.name}`)
  }
}

function argmax(arr) {
  let maxIdx = 0, maxVal = arr[0]
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] > maxVal) { maxVal = arr[i]; maxIdx = i }
  }
  return maxIdx
}

function softmax(arr) {
  const max = Math.max(...arr)
  const exp = arr.map(x => Math.exp(x - max))
  const sum = exp.reduce((a, b) => a + b)
  return exp.map(x => x / sum)
}

module.exports = OnnxProvider
