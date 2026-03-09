class BaseGameAdapter {
  constructor({ config, modelRegistry, dataCollector, eventBus }) {
    this.config = config
    this.modelRegistry = modelRegistry
    this.dataCollector = dataCollector
    this.eventBus = eventBus
    this.agentId = null
    this.apiToken = null
  }

  // Must implement
  get gameName() { throw new Error('gameName not implemented') }
  get supportsRealtime() { return false }

  async initialize() { throw new Error('initialize not implemented') }
  async discoverGames() { throw new Error('discoverGames not implemented') }
  async joinGame(gameId) { throw new Error('joinGame not implemented') }
  async playGame(gameId) { throw new Error('playGame not implemented') }
  async onGameEnd(gameId, results) { throw new Error('onGameEnd not implemented') }
  async shutdown() {}
}

module.exports = BaseGameAdapter
