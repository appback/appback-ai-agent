const { createLogger } = require('../utils/logger')
const log = createLogger('scheduler')

class Scheduler {
  constructor(intervalSec) {
    this.intervalSec = intervalSec
    this._timer = null
    this._running = false
    this._tickStartedAt = null
    this._maxTickMs = 60_000 // force-reset _running after 60s
  }

  start(fn) {
    if (this._timer) return
    log.info(`Starting scheduler, interval=${this.intervalSec}s`)

    const tick = async () => {
      // Safety: force-reset _running if previous tick exceeded timeout
      if (this._running && this._tickStartedAt) {
        const elapsed = Date.now() - this._tickStartedAt
        if (elapsed > this._maxTickMs) {
          log.warn(`Previous tick stuck for ${Math.round(elapsed / 1000)}s, force-resetting`)
          this._running = false
        }
      }

      if (this._running) return
      this._running = true
      this._tickStartedAt = Date.now()
      try {
        await fn()
      } catch (err) {
        log.error('Scheduler tick failed', err.message)
      } finally {
        this._running = false
        this._tickStartedAt = null
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
