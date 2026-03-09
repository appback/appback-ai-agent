const { createLogger } = require('../utils/logger')
const log = createLogger('scheduler')

class Scheduler {
  constructor(intervalSec) {
    this.intervalSec = intervalSec
    this._timer = null
    this._running = false
  }

  start(fn) {
    if (this._timer) return
    log.info(`Starting scheduler, interval=${this.intervalSec}s`)

    const tick = async () => {
      if (this._running) return
      this._running = true
      try {
        await fn()
      } catch (err) {
        log.error('Scheduler tick failed', err.message)
      } finally {
        this._running = false
      }
    }

    tick()
    this._timer = setInterval(tick, this.intervalSec * 1000)
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
      log.info('Scheduler stopped')
    }
  }
}

module.exports = Scheduler
