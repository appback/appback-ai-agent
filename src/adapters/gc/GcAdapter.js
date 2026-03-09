const BaseGameAdapter = require('../../core/BaseGameAdapter')
const GcApiClient = require('./GcApiClient')
const GcSocketClient = require('./GcSocketClient')
const GcStrategyEngine = require('./GcStrategyEngine')
const GcFeatureBuilder = require('./GcFeatureBuilder')
const { createLogger } = require('../../utils/logger')
const log = createLogger('gc-adapter')

class GcAdapter extends BaseGameAdapter {
  constructor(opts) {
    super(opts)
    this.api = new GcApiClient(this.config)
    this.ws = new GcSocketClient(this.config)
    this.strategyEngine = new GcStrategyEngine()
    this.featureBuilder = new GcFeatureBuilder()
    this.activeGameId = null
    this.mySlot = null
    this.gamePhase = null
    this.lastTickNum = -1
    this.sessionId = null
    this._strategyLog = []
  }

  get gameName() { return 'claw-clash' }
  get supportsRealtime() { return true }

  async initialize() {
    // Try loading identity from SQLite
    if (this.dataCollector) {
      const saved = this.dataCollector.store.getIdentity(this.gameName)
      if (saved && !this.config.apiToken) {
        this.apiToken = saved.api_token
        this.agentId = saved.agent_id
        this.api.setToken(this.apiToken)
        log.info(`Loaded saved identity: ${saved.name} (${saved.agent_id})`)
      }
    }

    // Use env token if provided
    if (this.config.apiToken && !this.apiToken) {
      this.apiToken = this.config.apiToken
      this.api.setToken(this.apiToken)
    }

    // Validate existing token
    if (this.apiToken) {
      try {
        const me = await this.api.getAgentMe()
        this.agentId = me.id
        log.info(`Agent: ${me.name} (${me.id})`)
      } catch {
        log.warn('Token invalid, will re-register')
        this.apiToken = null
      }
    }

    // Register if needed
    if (!this.apiToken) {
      const result = await this.api.register(this.config.agentName)
      this.apiToken = result.token || result.api_token
      this.agentId = result.id || result.agent_id
      this.api.setToken(this.apiToken)
      log.info(`Registered: ${this.config.agentName} → ${this.agentId}`)
      log.warn('Save this token to GC_API_TOKEN env var!')
    }

    // Persist identity
    if (this.dataCollector) {
      this.dataCollector.store.saveIdentity(
        this.gameName, this.agentId, this.apiToken, this.config.agentName
      )
    }

    // Load equipment for feature builder
    try {
      const equip = await this.api.getEquipment()
      this.featureBuilder.setEquipment(equip)
      log.info('Equipment catalog loaded')
    } catch (err) {
      log.warn('Equipment load failed, using defaults', err.message)
    }

    // Try loading ONNX models
    if (this.modelRegistry) {
      await this.modelRegistry.loadModel('gc', 'gc_move_model', { featureDim: 120 }).catch(() => {})
      await this.modelRegistry.loadModel('gc', 'gc_attack_model', { featureDim: 31 }).catch(() => {})
      this.modelRegistry.startWatcher()
    }

    // Connect WebSocket
    this.ws.connect()
    this.ws.onTick((data) => this._onTick(data))
    this.ws.onGameState((data) => this._onGameState(data))
    this.ws.onBattleEnded((data) => this._onBattleEnded(data))
  }

  async discoverGames() {
    if (this.activeGameId) {
      log.debug('Already in active game, skipping discovery')
      return { status: 'busy' }
    }

    try {
      const challenge = await this.api.getChallenge()
      if (challenge.status === 'busy') return { status: 'busy' }
      if (challenge.status === 'ready') return await this.joinGame()
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
        this._strategyLog = []
        this.ws.joinGame(this.activeGameId)

        // Start data collection session
        if (this.dataCollector) {
          this.sessionId = this.dataCollector.startSession(
            this.gameName, this.activeGameId, this.mySlot
          )
        }

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

    if (data.game_id && !this.activeGameId) {
      this.activeGameId = data.game_id
      this.mySlot = data.slot
      this.strategyEngine.reset()
      this._strategyLog = []
      this.ws.joinGame(this.activeGameId)

      if (this.dataCollector) {
        this.sessionId = this.dataCollector.startSession(
          this.gameName, this.activeGameId, this.mySlot
        )
      }

      log.info(`Assigned game from queue: ${this.activeGameId}, slot=${this.mySlot}`)
    }
  }

  _onTick(data) {
    if (!this.activeGameId || !data) return

    const { tick, subTick, agents, shrinkPhase, powerups, events, eliminations } = data

    const me = this.mySlot !== null
      ? agents?.find(a => a.slot === this.mySlot)
      : null

    if (!me) return

    // Build game state for feature builder
    const gameState = {
      me, agents, shrinkPhase, tick, powerups,
      gridWidth: 8, gridHeight: 8, maxTicks: 300,
    }

    // Build features for data collection (every sub-tick 0)
    let moveFeatures = null
    if (subTick === 0 && me.alive) {
      try {
        moveFeatures = this.featureBuilder.buildMoveFeatures(me, gameState)
      } catch (err) {
        log.debug('Feature build failed', err.message)
      }
    }

    // Record tick data
    if (this.dataCollector && this.sessionId) {
      const tickState = { agents: agents.map(a => ({
        slot: a.slot, hp: a.hp, maxHp: a.maxHp, x: a.x, y: a.y,
        alive: a.alive, score: a.score,
      })), shrinkPhase, eliminations }

      this.dataCollector.recordTick(
        this.sessionId, tick, subTick, tickState, moveFeatures, null
      )
    }

    if (!me.alive) return

    // Strategy decision: sub-tick 0, every 10 ticks
    if (subTick !== 0 || tick % this.config.strategyCooldownTicks !== 0) return
    if (tick === this.lastTickNum) return
    this.lastTickNum = tick

    const strategy = this.strategyEngine.decide(gameState)

    if (strategy) {
      this._strategyLog.push({ tick, ...strategy })
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
    let myResult = null
    if (results?.rankings) {
      myResult = results.rankings.find(r => r.slot === this.mySlot)
      if (myResult) {
        log.info(`Result: rank=${myResult.placement}, score=${myResult.score}, kills=${myResult.kills}`)
      }
    }

    // End data collection session
    if (this.dataCollector && this.sessionId) {
      this.dataCollector.endSession(this.sessionId, myResult, this._strategyLog)

      const totalGames = this.dataCollector.getSessionCount(this.gameName)
      log.info(`Total games played: ${totalGames}`)
    }

    // Cleanup
    this.ws.leaveGame(gameId)
    this.activeGameId = null
    this.mySlot = null
    this.gamePhase = null
    this.lastTickNum = -1
    this.sessionId = null
    this._strategyLog = []
    this.strategyEngine.reset()

    this.eventBus.emit('game_ended', { game: this.gameName, gameId, results })
    log.info('Ready for next game')
  }

  async shutdown() {
    if (this.activeGameId) this.ws.leaveGame(this.activeGameId)
    this.ws.disconnect()
    if (this.modelRegistry) this.modelRegistry.stopWatcher()
    log.info('GC adapter shut down')
  }
}

module.exports = GcAdapter
