const { io } = require('socket.io-client')
const { createLogger } = require('../../utils/logger')
const log = createLogger('gc-socket')

class GcSocketClient {
  constructor(config) {
    this.wsUrl = config.wsUrl
    this.socket = null
    this._onReconnectCallback = null
    this._hasConnectedOnce = false
  }

  connect() {
    if (this.socket?.connected) return

    log.info(`Connecting to ${this.wsUrl}`)
    this.socket = io(this.wsUrl, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 2000,
      reconnectionAttempts: Infinity,
    })

    this.socket.on('connect', () => {
      if (!this._hasConnectedOnce) {
        this._hasConnectedOnce = true
        log.info('WebSocket connected (initial)')
        return
      }
      log.info('WebSocket reconnected')
      if (this._onReconnectCallback) {
        Promise.resolve(this._onReconnectCallback()).catch(err => {
          log.error('Reconnect callback failed', err.message)
        })
      }
    })

    this.socket.on('disconnect', (reason) => {
      log.warn('WebSocket disconnected', reason)
    })

    this.socket.on('connect_error', (err) => {
      log.error('WebSocket connection error', err.message)
    })
  }

  onReconnect(callback) {
    this._onReconnectCallback = callback
  }

  joinGame(gameId) {
    if (!this.socket?.connected) return
    log.info(`Joining game room: ${gameId}`)
    this.socket.emit('join_game', gameId)
  }

  leaveGame(gameId) {
    if (!this.socket?.connected) return
    log.info(`Leaving game room: ${gameId}`)
    this.socket.emit('leave_game', gameId)
  }

  onTick(handler) {
    this.socket?.on('tick', handler)
  }

  onGameState(handler) {
    this.socket?.on('game_state', handler)
  }

  onBattleEnded(handler) {
    this.socket?.on('battle_ended', handler)
  }

  onGameCancelled(handler) {
    this.socket?.on('game_cancelled', handler)
  }

  off(event, handler) {
    this.socket?.off(event, handler)
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect()
      this.socket = null
      log.info('WebSocket disconnected')
    }
  }
}

module.exports = GcSocketClient
