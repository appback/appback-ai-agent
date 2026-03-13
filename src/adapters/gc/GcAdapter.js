const BaseGameAdapter = require('../../core/BaseGameAdapter')
const GcApiClient = require('./GcApiClient')
const GcSocketClient = require('./GcSocketClient')
const GcStrategyEngine = require('./GcStrategyEngine')
const GcFeatureBuilder = require('./GcFeatureBuilder')
const GcEquipmentManager = require('./GcEquipmentManager')
const { createLogger } = require('../../utils/logger')
const log = createLogger('gc-adapter')

// v6.0 action labels: model output index → direction
const ACTION_LABELS = ['stay', 'up', 'down', 'left', 'right']

class GcAdapter extends BaseGameAdapter {
  constructor(opts) {
    super(opts)
    this.api = new GcApiClient(this.config)
    this.ws = new GcSocketClient(this.config)
    this.strategyEngine = new GcStrategyEngine()
    this.featureBuilder = new GcFeatureBuilder()
    this.equipmentManager = new GcEquipmentManager(this.dataCollector?.store)
    this.metrics = opts.metrics || null
    this.activeGameId = null
    this.mySlot = null
    this.currentLoadout = null
    this.gamePhase = null
    this.lastTickNum = -1
    this.sessionId = null
    this._strategyLog = []
    this._terrainCached = false
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

    // Load equipment for feature builder + equipment manager
    try {
      const equip = await this.api.getEquipment()
      this.featureBuilder.setEquipment(equip)
      this.equipmentManager.setCatalog(equip)
      this.equipmentManager.loadStats()
      log.info('Equipment catalog loaded')
    } catch (err) {
      log.warn('Equipment load failed, using defaults', err.message)
    }

    // Try loading ONNX models (v6.0: 162 dims, 5 classes)
    if (this.modelRegistry) {
      await this.modelRegistry.loadModel('gc', 'gc_strategy_model', { featureDim: 162 }).catch(() => {})
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
      // Check queue status first — we may already be assigned to a game
      const queueStatus = await this.api.getQueueStatus().catch(() => null)
      if (queueStatus?.active_game_id) {
        log.info(`Found active game from queue: ${queueStatus.active_game_id}`)
        await this._enterGame(queueStatus.active_game_id)
        return { status: 'joined', gameId: queueStatus.active_game_id }
      }

      // If still in queue, wait for matchmaker
      if (queueStatus?.in_queue) {
        log.debug('Still in matchmaking queue, waiting...')
        return { status: 'queued' }
      }

      // Not in queue, not in game — try to join
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
      // Select optimal loadout based on historical performance
      this.currentLoadout = this.equipmentManager.selectLoadout()
      const result = await this.api.submitChallenge(this.currentLoadout)

      log.info(`Challenge result: ${result.status}`, result)

      if (result.status === 'joined' || result.status === 'updated') {
        await this._enterGame(result.game_id, result.slot)
        return { status: 'joined', gameId: this.activeGameId }
      }

      if (result.status === 'queued') {
        log.info('Queued for matchmaking, will poll for assignment')
        this._startQueuePolling()
        return { status: 'queued' }
      }

      return { status: result.status }
    } catch (err) {
      log.error('Join failed', err.message)
      return { status: 'error' }
    }
  }

  async _enterGame(gameId, slot) {
    this.activeGameId = gameId
    this._stopQueuePolling()
    this.strategyEngine.reset()
    this._strategyLog = []
    this._terrainCached = false

    // If slot not provided, resolve from game detail API
    if (slot != null) {
      this.mySlot = slot
    } else {
      try {
        const game = await this.api.getGameDetail(gameId)
        const me = game?.entries?.find(e => e.agent_id === this.agentId)
        this.mySlot = me?.slot ?? null
        log.info(`Resolved slot=${this.mySlot} from game detail`)
      } catch (err) {
        log.warn('Could not resolve slot from game detail', err.message)
      }
    }

    this.ws.joinGame(this.activeGameId)

    // Start data collection session
    if (this.dataCollector) {
      this.sessionId = this.dataCollector.startSession(
        this.gameName, this.activeGameId, this.mySlot
      )
    }

    if (!this._terrainCached) this._cacheTerrain()

    log.info(`Entered game ${this.activeGameId}, slot=${this.mySlot}`)
  }

  _startQueuePolling() {
    if (this._queuePollTimer) return
    log.info('Starting queue poll (every 5s)')
    this._queuePollTimer = setInterval(() => this._pollQueue(), 5000)
  }

  _stopQueuePolling() {
    if (this._queuePollTimer) {
      clearInterval(this._queuePollTimer)
      this._queuePollTimer = null
    }
  }

  async _pollQueue() {
    try {
      const status = await this.api.getQueueStatus()
      if (status.active_game_id && !this.activeGameId) {
        log.info(`Game assigned from queue: ${status.active_game_id}`)
        await this._enterGame(status.active_game_id)
      }
      if (!status.in_queue && !status.active_game_id) {
        log.info('No longer in queue and no game assigned')
        this._stopQueuePolling()
      }
    } catch (err) {
      log.debug('Queue poll failed', err.message)
    }
  }

  async _cacheTerrain() {
    try {
      const state = await this.api.getGameState(this.activeGameId)
      if (state?.arena) {
        this.featureBuilder.setTerrain(state.arena)
        this._terrainCached = true
        log.info(`Terrain cached: ${this.featureBuilder.gridWidth}x${this.featureBuilder.gridHeight}`)
      }
    } catch (err) {
      log.warn('Terrain cache failed, will retry on next tick', err.message)
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
      this._terrainCached = false
      this.ws.joinGame(this.activeGameId)

      if (this.dataCollector) {
        this.sessionId = this.dataCollector.startSession(
          this.gameName, this.activeGameId, this.mySlot
        )
      }

      // Cache terrain for the new game
      this._cacheTerrain()

      log.info(`Assigned game from queue: ${this.activeGameId}, slot=${this.mySlot}`)
    }
  }

  async _onTick(data) {
    if (!this.activeGameId || !data) return

    const { tick, phase, agents, shrinkPhase, powerups, events, eliminations } = data

    // Retry terrain cache if not yet loaded
    if (!this._terrainCached && tick <= 3) {
      this._cacheTerrain()
    }

    const me = this.mySlot !== null
      ? agents?.find(a => a.slot === this.mySlot)
      : null

    if (!me) return

    // Enrich agent data with equipment catalog
    const enrichedMe = this.featureBuilder.enrichAgent(me)
    const enrichedAgents = agents.map(a => this.featureBuilder.enrichAgent(a))

    // Build game state for feature builder
    const gameState = {
      me: enrichedMe,
      agents: enrichedAgents,
      shrinkPhase: shrinkPhase || 0,
      tick,
      powerups,
      gridWidth: this.featureBuilder.gridWidth,
      gridHeight: this.featureBuilder.gridHeight,
      maxTicks: 300,
    }

    // Build features and decide move on phase 0 (passive phase)
    let moveFeatures = null
    let decision = null
    if (phase === 0 && me.alive) {
      try {
        moveFeatures = this.featureBuilder.buildMoveFeatures(enrichedMe, gameState)
      } catch (err) {
        log.debug('Feature build failed', err.message)
      }

      // Submit move decision and capture result
      decision = await this._decideAndSubmitMove(enrichedMe, gameState, moveFeatures)
    }

    // Record tick data with decision
    if (this.dataCollector && this.sessionId) {
      const tickState = { agents: agents.map(a => ({
        slot: a.slot, hp: a.hp, maxHp: a.maxHp, x: a.x, y: a.y,
        alive: a.alive, score: a.score,
      })), shrinkPhase, eliminations }

      this.dataCollector.recordTick(
        this.sessionId, tick, phase, tickState, moveFeatures, decision
      )
    }

    if (!me.alive) return

    // Strategy decision: phase 0, every N ticks
    if (phase !== 0 || tick % this.config.strategyCooldownTicks !== 0) return
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

  /**
   * Decide move direction and submit to server.
   * Priority: ONNX model → heuristic fallback
   */
  async _decideAndSubmitMove(me, gameState, features) {
    if (!this.activeGameId || !me.alive) return null

    let direction = 'stay'
    let source = 'heuristic'
    let logits = null
    const actionMask = this.featureBuilder.buildActionMask(me, gameState)

    try {
      // Try ONNX model inference
      if (this.modelRegistry && features) {
        const model = this.modelRegistry.getProvider('gc', 'gc_strategy_model')
        if (model) {
          const rawLogits = await model.infer(features)
          logits = Array.from(rawLogits)

          // Apply action mask
          const masked = logits.map((v, i) => actionMask[i] ? v : -Infinity)
          const bestIdx = masked.indexOf(Math.max(...masked))
          direction = ACTION_LABELS[bestIdx] || 'stay'
          source = 'model'

          log.debug(`Model move: ${direction} (logits: [${masked.map(v => v.toFixed(2)).join(',')}])`)
        }
      }
    } catch (err) {
      log.debug('Model inference failed, using heuristic', err.message)
    }

    // Heuristic fallback if no model
    if (source !== 'model') {
      direction = this._heuristicMove(me, gameState)
    }

    // Submit move to server
    try {
      await this.api.submitMove(this.activeGameId, direction)
    } catch (err) {
      log.debug(`Move submit failed: ${err.message}`)
    }

    return {
      action: direction,
      source,
      logits,
      actionMask: Array.from(actionMask),
    }
  }

  /**
   * Simple heuristic: move toward nearest enemy if no model available
   */
  _heuristicMove(me, gameState) {
    const enemies = gameState.agents
      .filter(a => a.alive && a.slot !== me.slot)
      .sort((a, b) => (Math.abs(a.x - me.x) + Math.abs(a.y - me.y)) - (Math.abs(b.x - me.x) + Math.abs(b.y - me.y)))

    if (!enemies.length) return 'stay'

    const target = enemies[0]
    const actionMask = this.featureBuilder.buildActionMask(me, gameState)

    // Prefer moving toward target
    const dx = target.x - me.x
    const dy = target.y - me.y

    // Direction preferences based on target position
    const prefs = []
    if (Math.abs(dx) >= Math.abs(dy)) {
      if (dx > 0) prefs.push(4) // right
      else if (dx < 0) prefs.push(3) // left
      if (dy > 0) prefs.push(2) // down
      else if (dy < 0) prefs.push(1) // up
    } else {
      if (dy > 0) prefs.push(2) // down
      else if (dy < 0) prefs.push(1) // up
      if (dx > 0) prefs.push(4) // right
      else if (dx < 0) prefs.push(3) // left
    }

    for (const idx of prefs) {
      if (actionMask[idx]) return ACTION_LABELS[idx]
    }

    // Any valid move
    for (let i = 1; i <= 4; i++) {
      if (actionMask[i]) return ACTION_LABELS[i]
    }

    return 'stay'
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
        log.info(`Result: rank=${myResult.rank}, score=${myResult.score}, kills=${myResult.kills}`)
      }
    }

    // Track metrics
    if (this.metrics && myResult) {
      this.metrics.record(myResult)
    }

    // Track equipment performance
    if (this.currentLoadout && myResult) {
      this.equipmentManager.recordResult(
        this.currentLoadout.weapon, this.currentLoadout.armor, myResult
      )
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
    this.currentLoadout = null
    this.gamePhase = null
    this.lastTickNum = -1
    this.sessionId = null
    this._strategyLog = []
    this._terrainCached = false
    this.strategyEngine.reset()
    this.featureBuilder.clearTerrain()

    this.eventBus.emit('game_ended', { game: this.gameName, gameId, results })
    log.info('Ready for next game')
  }

  async shutdown() {
    this._stopQueuePolling()
    if (this.activeGameId) this.ws.leaveGame(this.activeGameId)
    this.ws.disconnect()
    if (this.modelRegistry) this.modelRegistry.stopWatcher()
    log.info('GC adapter shut down')
  }
}

module.exports = GcAdapter
