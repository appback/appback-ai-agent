const BaseModelProvider = require('../../core/BaseModelProvider')

class RuleBasedProvider extends BaseModelProvider {
  constructor() {
    super('rule-based', {})
    this._loaded = true
  }

  async load() { this._loaded = true }

  async infer(features) {
    // Rule-based doesn't use feature vectors
    // Strategy decisions are handled by GcStrategyEngine
    return { decision: null, confidence: 0 }
  }
}

module.exports = RuleBasedProvider
