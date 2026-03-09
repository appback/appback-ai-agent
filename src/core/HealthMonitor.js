const http = require('http')
const { createLogger } = require('../utils/logger')
const log = createLogger('health')

/**
 * HealthMonitor — HTTP endpoint for health checks and metrics.
 * GET /health → 200 OK
 * GET /metrics → JSON agent stats
 */
class HealthMonitor {
  constructor(port, metrics, adapters) {
    this.port = port || 9090
    this.metrics = metrics
    this.adapters = adapters || new Map()
    this.server = null
    this.startedAt = new Date()
  }

  start() {
    this.server = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok', uptime: this._uptime() }))
        return
      }

      if (req.url === '/metrics') {
        const data = {
          uptime: this._uptime(),
          metrics: this.metrics ? this.metrics.toJSON() : {},
          adapters: {},
        }
        for (const [name, adapter] of this.adapters) {
          data.adapters[name] = {
            activeGameId: adapter.activeGameId || null,
            gamePhase: adapter.gamePhase || null,
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(data, null, 2))
        return
      }

      res.writeHead(404)
      res.end('Not found')
    })

    this.server.listen(this.port, '0.0.0.0', () => {
      log.info(`Health monitor listening on :${this.port}`)
    })
  }

  _uptime() {
    const sec = Math.floor((Date.now() - this.startedAt.getTime()) / 1000)
    const h = Math.floor(sec / 3600)
    const m = Math.floor((sec % 3600) / 60)
    const s = sec % 60
    return `${h}h ${m}m ${s}s`
  }

  stop() {
    if (this.server) {
      this.server.close()
      this.server = null
    }
  }
}

module.exports = HealthMonitor
