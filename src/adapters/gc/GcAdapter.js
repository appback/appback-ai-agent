const BaseGameAdapter = require('../../core/BaseGameAdapter')
const GcApiClient = require('./GcApiClient')
const GcSocketClient = require('./GcSocketClient')
const GcStrategyEngine = require('./GcStrategyEngine')
const GcFeatureBuilder = require('./GcFeatureBuilder')
const GcEquipmentManager = require('./GcEquipmentManager')
const { createLogger } = require('../../utils/logger')
const { INACTIVE_STATES } = require('./constants')
const { createClientContract, evaluateServerContract } = require('../../config/GcServerContract')
const log = createLogger('gc-adapter')

// v6.0 action labels: model output index → direction
const ACTION_LABELS = ['stay', 'up', 'down', 'left', 'right']

class GcAdapter extends BaseGameAdapter {
  constructor(opts) {
    super(opts)
    this.runtimeContext = opts.runtimeContext || { feature_dim: 153, feature_version: '7.0' }
    this.collectLegacyTraining = this.runtimeContext.feature_version !== '8.0'
    this.clientContract = createClientContract(opts.agentVersion, this.runtimeContext.feature_version)
    this.api = new GcApiClient(this.config, this.clientContract)
    this.ws = new GcSocketClient(this.config)
    this.strategyEngine = new GcStrategyEngine()
    this.featureBuilder = new GcFeatureBuilder()
    this.equipmentManager = new GcEquipmentManager(this.dataCollector?.store, opts.behaviorProfile)
    this.metrics = opts.metrics || null
    this.modelRelativePath = opts.modelRelativePath || null
    this.activeGameId = null
    this.mySlot = null
    this.currentLoadout = null
    this.gamePhase = null
    this.lastTickNum = -1
    this.sessionId = null
    this._strategyLog = []
    this._terrainCached = false
    this._queuedSince = null
    this._reconnecting = false
    this._busyCount = 0
  }

  get gameName() { return 'claw-clash' }
  get supportsRealtime() { return true }

  async initialize() {
    await this._checkServerContract()

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
      } catch (err) {
        log.error(`Token validation failed: ${err.message}`)
        throw new Error('Agent token validation failed. Check server status or re-register manually.')
      }
    }

    // No token available — auto-register
    if (!this.apiToken) {
      log.info('No agent token found. Auto-registering...')
      try {
        const reg = await this.api.register()
        this.apiToken = reg.api_token || reg.token
        this.agentId = reg.agent_id || reg.id
        this.api.setToken(this.apiToken)
        log.info(`Registered as: ${reg.name} (${this.agentId})`)

        // Persist to SQLite
        if (this.dataCollector) {
          this.dataCollector.store.saveIdentity(this.gameName, this.agentId, this.apiToken, reg.name)
          log.info('Identity saved to database')
        }
      } catch (err) {
        const msg = err.response?.data?.message || err.message
        throw new Error(`Auto-registration failed: ${msg}`)
      }
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

    // Only load a model produced for the active operation/profile generation.
    if (this.modelRegistry && this.modelRelativePath) {
      await this.modelRegistry.loadModel('gc', 'gc_move_model', {
        featureDim: this.runtimeContext.feature_dim,
        path: this.modelRelativePath,
        runtimeContext: this.runtimeContext,
      }).catch(err => log.warn(`Active generation model rejected: ${err.message}`))
    }

    // Connect WebSocket
    this.ws.connect()
    this.ws.onTick((data) => this._onTick(data))
    this.ws.onGameState((data) => this._onGameState(data))
    this.ws.onBattleEnded((data) => this._onBattleEnded(data))
    this.ws.onGameCancelled((data) => this._onGameCancelled(data))

    // Handle reconnection: re-join room or recover from stale game
    this.ws.onReconnect(() => this._onReconnect())
  }

  async _checkServerContract() {
    try {
      const serverContract = await this.api.getAgentContract()
      const status = evaluateServerContract(serverContract, this.clientContract)
      log.info(
        `GC contract: protocol=${serverContract.protocol_version}, ` +
        `enforcement=${status.enforcement}, feature=${this.clientContract.feature_version}`
      )
      for (const warning of status.warnings) log.warn(`GC observe contract warning: ${warning}`)
    } catch (err) {
      if (String(err.message).includes('GC strict contract rejected')) throw err
      log.warn(`GC contract preflight unavailable, continuing for compatibility: ${err.message}`)
    }
  }

  async _onReconnect() {
    this._reconnecting = true
    log.info('Reconnected — resetting state for recovery')

    // Always stop stale queue polling — queue was likely cleared on server restart
    this._stopQueuePolling()
    this._queuedSince = null

    if (!this.activeGameId) {
      log.info('No active game — will re-queue on next discovery tick')
      this._reconnecting = false
      return
    }

    log.info(`Checking active game ${this.activeGameId}`)
    try {
      const game = await this.api.getGameDetail(this.activeGameId)
      const state = game?.state

      if (INACTIVE_STATES.includes(state)) {
        log.info(`Game ${this.activeGameId} is inactive (${state}), cleaning up`)
        const me = game?.entries?.find(e => e.agent_id === this.agentId)
        const result = me && me.final_rank ? {
          rank: me.final_rank,
          score: me.total_score,
          kills: me.kills,
          damage_dealt: me.damage_dealt,
          damage_taken: me.damage_taken,
          survived_ticks: me.survived_ticks,
        } : null
        if (result) {
          await this.onGameEnd(this.activeGameId, { rankings: [result] })
        } else {
          this._onGameCancelled({ reason: state })
        }
      } else {
        log.info(`Game ${this.activeGameId} still in ${state}, re-joining room`)
        this.ws.joinGame(this.activeGameId)
      }
    } catch (err) {
      log.warn(`Game ${this.activeGameId} not found or server restarted, cleaning up`, err.message)
      this._onGameCancelled({ reason: 'not_found' })
    } finally {
      this._reconnecting = false
    }
  }

  async discoverGames() {
    // Skip if reconnect handler is still running
    if (this._reconnecting) {
      log.info('Reconnect in progress, skipping discovery')
      return { status: 'reconnecting' }
    }

    if (this.activeGameId) {
      try {
        const game = await this.api.getGameDetail(this.activeGameId)
        const state = game?.state
        if (INACTIVE_STATES.includes(state)) {
          log.info(`Active game ${this.activeGameId} is ${state}, cleaning up stale state`)
          this._onGameCancelled({ reason: state })
        } else {
          log.debug(`Active game ${this.activeGameId} in ${state}, skipping discovery`)
          return { status: 'busy' }
        }
      } catch (err) {
        log.warn(`Active game ${this.activeGameId} not found, cleaning up`, err.message)
        this._onGameCancelled({ reason: 'not_found' })
      }
    }

    try {
      // Check queue status first — we may already be assigned to a game
      const queueStatus = await this.api.getQueueStatus().catch(() => null)
      if (queueStatus?.active_game_id) {
        log.info(`Found active game from queue: ${queueStatus.active_game_id}`)
        this._queuedSince = null
        await this._enterGame(queueStatus.active_game_id)
        return { status: 'joined', gameId: queueStatus.active_game_id }
      }

      // If still in queue, check for timeout (2 minutes max)
      if (queueStatus?.in_queue) {
        if (!this._queuedSince) {
          this._queuedSince = Date.now()
        }
        const waitMs = Date.now() - this._queuedSince
        const waitSec = Math.round(waitMs / 1000)

        if (waitMs > 120_000) {
          log.info(`Queue timeout after ${waitSec}s — leaving queue and re-joining`)
          this._queuedSince = null
          // Force re-join by falling through to getChallenge
        } else {
          log.info(`In matchmaking queue (${waitSec}s), waiting...`)
          return { status: 'queued' }
        }
      } else {
        this._queuedSince = null
      }

      // Not in queue, not in game — try to join
      const challenge = await this.api.getChallenge()
      log.info(`Challenge response: ${JSON.stringify(challenge)}`)

      if (challenge.status === 'busy') {
        this._busyCount++

        // Server thinks we're in a game but we have no activeGameId
        // After 3 consecutive busy responses (90s), try to force re-join
        if (this._busyCount >= 3 && !this.activeGameId) {
          log.info(`Busy ${this._busyCount} times with no active game — force submitting challenge`)
          this._busyCount = 0
          return await this.joinGame()
        }
        return { status: 'busy' }
      }

      this._busyCount = 0
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
        this._queuedSince = Date.now()
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
    if (this.dataCollector && this.collectLegacyTraining) {
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

      if (this.dataCollector && this.collectLegacyTraining) {
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
    if (phase === 0 && me.alive && this.collectLegacyTraining) {
      try {
        moveFeatures = this.featureBuilder.buildMoveFeatures(enrichedMe, gameState)
      } catch (err) {
        log.debug('Feature build failed', err.message)
      }

      // Submit move decision and capture result
      decision = await this._decideAndSubmitMove(enrichedMe, gameState, moveFeatures)
    }

    // Record tick data with decision
    if (this.dataCollector && this.collectLegacyTraining && this.sessionId) {
      const tickState = { agents: agents.map(a => ({
        slot: a.slot, hp: a.hp, maxHp: a.maxHp, x: a.x, y: a.y,
        alive: a.alive, score: a.score,
        weapon: a.weapon, weapon_range: a.weapon_range,
        weapon_range_type: a.weapon_range_type, weapon_damage: a.weapon_damage,
        armor: a.armor,
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
        const model = this.modelRegistry.getProvider('gc', 'gc_move_model')
        if (model) {
          const result = await model.infer(features)
          logits = result?.logits || null

          if (logits && logits.length > 0) {
            // Apply action mask
            const masked = logits.map((v, i) => actionMask[i] ? v : -Infinity)
            const bestIdx = masked.indexOf(Math.max(...masked))
            direction = ACTION_LABELS[bestIdx] || 'stay'
            source = 'model'
            log.debug(`Model move: ${direction} (logits: [${masked.map(v => v.toFixed(2)).join(',')}])`)
          }
        }
      }
    } catch (err) {
      log.debug('Model inference failed, using heuristic', err.message)
    }

    // Heuristic fallback if no model
    if (source !== 'model') {
      direction = this._heuristicMove(me, gameState)
    }

    return {
      action: direction,
      source,
      logits,
      actionMask: Array.from(actionMask),
    }
  }

  /**
   * Terrain-aware heuristic: take the first step on the shortest path toward
   * the nearest reachable enemy. This avoids getting stuck behind maze walls
   * when no usable model is available.
   */
  _heuristicMove(me, gameState) {
    const enemies = gameState.agents
      .filter(a => a.alive && a.slot !== me.slot)
      .sort((a, b) => (Math.abs(a.x - me.x) + Math.abs(a.y - me.y)) - (Math.abs(b.x - me.x) + Math.abs(b.y - me.y)))

    if (!enemies.length) return 'stay'

    // If any enemy is in attack range, stay to auto-attack
    const canAttack = enemies.some(en => {
      const dist = Math.abs(en.x - me.x) + Math.abs(en.y - me.y)
      const range = me.weapon?.range || 1
      return dist >= 1 && dist <= range
    })
    if (canAttack) return 'stay'

    const target = enemies[0]
    const actionMask = this.featureBuilder.buildActionMask(me, gameState)

    const pathMove = findShortestMoveDirection(
      me,
      enemies,
      gameState,
      actionMask,
      this.featureBuilder.terrain,
      this.featureBuilder.gridWidth,
      this.featureBuilder.gridHeight
    )
    if (pathMove) return pathMove

    // Check if moving in a direction puts us in attack range
    const DIRS = [
      null,
      { dx: 0, dy: -1 },  // up
      { dx: 0, dy: 1 },   // down
      { dx: -1, dy: 0 },  // left
      { dx: 1, dy: 0 },   // right
    ]
    for (let i = 1; i <= 4; i++) {
      if (!actionMask[i]) continue
      const nx = me.x + DIRS[i].dx
      const ny = me.y + DIRS[i].dy
      const distAfter = Math.abs(target.x - nx) + Math.abs(target.y - ny)
      if (distAfter >= 1 && distAfter <= (me.weapon?.range || 1)) {
        return ACTION_LABELS[i]
      }
    }

    // Move toward target
    const dx = target.x - me.x
    const dy = target.y - me.y

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

  _onGameCancelled(data) {
    if (!this.activeGameId) return
    log.info(`Game cancelled: ${this.activeGameId}`, data)

    // Drop cancelled session data
    if (this.dataCollector && this.collectLegacyTraining && this.sessionId) {
      this.dataCollector.dropSession(this.sessionId)
    }

    // Cleanup
    this.ws.leaveGame(this.activeGameId)
    this.activeGameId = null
    this.mySlot = null
    this.currentLoadout = null
    this.gamePhase = null
    this.lastTickNum = -1
    this.sessionId = null
    this._strategyLog = []
    this._terrainCached = false
    this._queuedSince = null
    this.strategyEngine.reset()
    this.featureBuilder.clearTerrain()

    this.eventBus.emit('game_cancelled', { game: this.gameName })
    log.info('Ready for next game')
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
      try {
        this.dataCollector?.store?.saveLoadoutResult?.(
          gameId,
          this.currentLoadout.weapon,
          this.currentLoadout.armor,
          myResult
        )
      } catch (err) {
        log.warn(`Failed to persist loadout result: ${err.message}`)
      }
      this.equipmentManager.recordResult(
        this.currentLoadout.weapon, this.currentLoadout.armor, myResult
      )
    }

    // End data collection session
    if (this.dataCollector && this.collectLegacyTraining && this.sessionId) {
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
    this._queuedSince = null
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

function findShortestMoveDirection(me, targets, gameState, actionMask, terrain, gridW = 8, gridH = 8) {
  if (!terrain || !targets.length) return null

  const occupied = new Set()
  for (const a of (gameState.agents || [])) {
    if (a.alive && a.slot !== me.slot) occupied.add(`${a.x},${a.y}`)
  }

  const candidates = []
  for (const target of targets) {
    occupied.delete(`${target.x},${target.y}`)
    const path = findShortestPath(me, target, terrain, gridW, gridH, occupied, actionMask)
    occupied.add(`${target.x},${target.y}`)
    if (path) candidates.push(path)
  }

  candidates.sort((a, b) => a.dist - b.dist)
  return candidates.length > 0 ? ACTION_LABELS[candidates[0].firstActionIdx] : null
}

function findShortestPath(from, to, terrain, gridW, gridH, occupied, actionMask) {
  const startKey = `${from.x},${from.y}`
  const targetKey = `${to.x},${to.y}`
  if (startKey === targetKey) return null

  const queue = [{ x: from.x, y: from.y, dist: 0, firstActionIdx: null }]
  const seen = new Set([startKey])

  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi]
    for (let actionIdx = 1; actionIdx <= 4; actionIdx++) {
      if (cur.firstActionIdx == null && !actionMask[actionIdx]) continue
      const [dx, dy] = actionToDelta(actionIdx)
      const nx = cur.x + dx
      const ny = cur.y + dy
      const key = `${nx},${ny}`
      if (seen.has(key)) continue
      if (!isPathPassable(terrain, nx, ny, gridW, gridH, occupied) && key !== targetKey) continue

      const firstActionIdx = cur.firstActionIdx == null ? actionIdx : cur.firstActionIdx
      const dist = cur.dist + 1
      if (key === targetKey) return { dist, firstActionIdx }

      seen.add(key)
      queue.push({ x: nx, y: ny, dist, firstActionIdx })
    }
  }

  return null
}

function actionToDelta(actionIdx) {
  switch (actionIdx) {
    case 1: return [0, -1]
    case 2: return [0, 1]
    case 3: return [-1, 0]
    case 4: return [1, 0]
    default: return [0, 0]
  }
}

function isPathPassable(terrain, x, y, gridW, gridH, occupied) {
  if (x < 0 || x >= gridW || y < 0 || y >= gridH) return false
  if (occupied.has(`${x},${y}`)) return false
  const t = terrain?.[y]?.[x] || 0
  return t !== 1 && t !== 2
}

module.exports = GcAdapter
