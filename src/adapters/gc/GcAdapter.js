const BaseGameAdapter = require('../../core/BaseGameAdapter')
const GcApiClient = require('./GcApiClient')
const GcSocketClient = require('./GcSocketClient')
const GcStrategyEngine = require('./GcStrategyEngine')
const { createLogger } = require('../../utils/logger')
const log = createLogger('gc-adapter')

const BATTLE_STATES = ['lobby', 'betting', 'sponsoring', 'battle']

class GcAdapter extends BaseGameAdapter {
  constructor(opts) {
    super(opts)
    this.api = new GcApiClient(this.config)
    this.ws = new GcSocketClient(this.config)
    this.strategyEngine = new GcStrategyEngine()
    this.activeGameId = null
    this.mySlot = null
    this.gamePhase = null
    this.lastTickNum = -1
  }

  get gameName() { return 'claw-clash' }
  get supportsRealtime() { return true }

  async initialize() {
    // Use existing token or register new agent
    if (this.config.apiToken) {
      this.apiToken = this.config.apiToken
      this.api.setToken(this.apiToken)
      log.info('Using existing API token')
      try {
        const me = await this.api.getAgentMe()
        this.agentId = me.id
        log.info(`Agent: ${me.name} (${me.id})`)
      } catch (err) {
        log.error('Token invalid, will re-register', err.message)
        this.apiToken = null
      }
    }

    if (!this.apiToken) {
      const result = await this.api.register(this.config.agentName)
      this.apiToken = result.token || result.api_token
      this.agentId = result.id || result.agent_id
      this.api.setToken(this.apiToken)
      log.info(`Registered new agent: ${this.config.agentName} → ${this.agentId}`)
      log.info(`API Token: ${this.apiToken}`)
      log.warn('Save this token to GC_API_TOKEN env var!')
    }

    // Connect WebSocket
    this.ws.connect()

    // Listen for battle events
    this.ws.onTick((data) => this._onTick(data))
    this.ws.onGameState((data) => this._onGameState(data))
    this.ws.onBattleEnded((data) => this._onBattleEnded(data))
  }

  async discoverGames() {
    // Already in a game
    if (this.activeGameId) {
      log.debug('Already in active game, skipping discovery')
      return { status: 'busy' }
    }

    try {
      const challenge = await this.api.getChallenge()

      if (challenge.status === 'busy') {
        log.debug('Agent is busy on server side')
        return { status: 'busy' }
      }

      if (challenge.status === 'ready') {
        log.info('Agent is ready, submitting challenge...')
        return await this.joinGame()
      }

      return { status: challenge.status }
    } catch (err) {
      log.error('Discovery failed', err.message)
      return { status: 'error' }
    }
  }

  async joinGame() {
    try {
      const result = await this.api.submitChallenge({
        weapon: this.config.defaultWeapon,
        armor: this.config.defaultArmor,
        tier: this.config.defaultTier,
      })

      log.info(`Challenge result: ${result.status}`, result)

      if (result.status === 'joined' || result.status === 'updated') {
        this.activeGameId = result.game_id
        this.mySlot = result.slot
        this.strategyEngine.reset()
        this.ws.joinGame(this.activeGameId)
        log.info(`Joined game ${this.activeGameId}, slot=${this.mySlot}`)
        return { status: 'joined', gameId: this.activeGameId }
      }

      if (result.status === 'queued') {
        log.info('Queued for matchmaking')
        return { status: 'queued' }
      }

      return { status: result.status }
    } catch (err) {
      log.error('Join failed', err.message)
      return { status: 'error' }
    }
  }

  _onGameState(data) {
    if (!data) return
    const prevPhase = this.gamePhase
    this.gamePhase = data.state

    if (prevPhase !== this.gamePhase) {
      log.info(`Phase change: ${prevPhase} → ${this.gamePhase}`)
    }

    // Game assigned from queue
    if (data.game_id && !this.activeGameId) {
      this.activeGameId = data.game_id
      this.mySlot = data.slot
      this.strategyEngine.reset()
      this.ws.joinGame(this.activeGameId)
      log.info(`Assigned game from queue: ${this.activeGameId}, slot=${this.mySlot}`)
    }
  }

  _onTick(data) {
    if (!this.activeGameId || !data) return

    const { tick, subTick, agents, shrinkPhase, events, eliminations } = data

    // Find ourselves
    const me = this.mySlot !== null
      ? agents?.find(a => a.slot === this.mySlot)
      : null

    if (!me || !me.alive) return

    // Only decide strategy on sub-tick 0, every 10 ticks
    if (subTick !== 0 || tick % this.config.strategyCooldownTicks !== 0) return
    if (tick === this.lastTickNum) return
    this.lastTickNum = tick

    const gameState = { me, agents, shrinkPhase, tick }
    const strategy = this.strategyEngine.decide(gameState)

    if (strategy) {
      this.api.submitStrategy(this.activeGameId, strategy)
        .then(res => log.debug(`Strategy submitted at tick ${tick}`, res))
        .catch(err => log.warn(`Strategy submit failed at tick ${tick}`, err.message))
    }
  }

  _onBattleEnded(data) {
    if (!this.activeGameId) return
    log.info('Battle ended', data)
    this.onGameEnd(this.activeGameId, data)
  }

  async onGameEnd(gameId, results) {
    if (results?.rankings) {
      const myResult = results.rankings.find(r => r.slot === this.mySlot)
      if (myResult) {
        log.info(`Game result: rank=${myResult.placement}, score=${myResult.score}, kills=${myResult.kills}`)
      }
    }

    // Cleanup
    this.ws.leaveGame(gameId)
    this.activeGameId = null
    this.mySlot = null
    this.gamePhase = null
    this.lastTickNum = -1
    this.strategyEngine.reset()

    this.eventBus.emit('game_ended', { game: this.gameName, gameId, results })
    log.info('Ready for next game')
  }

  async shutdown() {
    if (this.activeGameId) {
      this.ws.leaveGame(this.activeGameId)
    }
    this.ws.disconnect()
    log.info('GC adapter shut down')
  }
}

module.exports = GcAdapter
