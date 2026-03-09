const { createLogger } = require('../utils/logger')
const log = createLogger('data-collector')

class DataCollector {
  constructor(store) {
    this.store = store
    this._tickBuffer = []
    this._flushInterval = 10 // flush every 10 ticks
  }

  startSession(game, gameId, mySlot) {
    this._tickBuffer = []
    const sessionId = this.store.startSession(game, gameId, mySlot)
    log.info(`Session started: ${game}/${gameId} → session#${sessionId}`)
    return sessionId
  }

  endSession(sessionId, result, strategyLog) {
    this._flush(sessionId)
    this.store.endSession(sessionId, result, strategyLog)
    log.info(`Session ended: #${sessionId}`)
  }

  recordTick(sessionId, tick, subTick, state, features, decision) {
    this._tickBuffer.push({ sessionId, tick, subTick, state, features, decision })

    if (this._tickBuffer.length >= this._flushInterval * 5) {
      this._flush(sessionId)
    }
  }

  _flush(sessionId) {
    if (this._tickBuffer.length === 0) return
    try {
      this.store.recordTickBatch(this._tickBuffer)
      log.debug(`Flushed ${this._tickBuffer.length} ticks for session#${sessionId}`)
    } catch (err) {
      log.error('Tick flush failed', err.message)
    }
    this._tickBuffer = []
  }

  getSessionCount(game) {
    return this.store.getSessionCount(game)
  }
}

module.exports = DataCollector
