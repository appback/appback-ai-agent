const { createLogger } = require('../utils/logger')
const EventBus = require('./EventBus')
const Scheduler = require('./Scheduler')
const log = createLogger('manager')

class AgentManager {
  constructor(config) {
    this.config = config
    this.adapters = new Map()
    this.eventBus = new EventBus()
    this.schedulers = new Map()
  }

  registerAdapter(adapter) {
    this.adapters.set(adapter.gameName, adapter)
    log.info(`Registered adapter: ${adapter.gameName}`)
  }

  async start() {
    log.info('Starting agent manager...')

    for (const [name, adapter] of this.adapters) {
      try {
        await adapter.initialize()
        log.info(`Initialized adapter: ${name}`)

        const intervalSec = adapter.config.discoveryIntervalSec ||
          this.config.discoveryIntervalSec || 30
        const scheduler = new Scheduler(intervalSec)

        scheduler.start(async () => {
          const result = await adapter.discoverGames()
          if (result && result.gameId) {
            this.eventBus.emit('game_found', { game: name, gameId: result.gameId })
          }
        })

        this.schedulers.set(name, scheduler)
      } catch (err) {
        log.error(`Failed to initialize adapter: ${name}`, err.message)
      }
    }

    log.info('Agent manager started')
  }

  async stop() {
    log.info('Stopping agent manager...')
    for (const [name, scheduler] of this.schedulers) {
      scheduler.stop()
    }
    for (const [name, adapter] of this.adapters) {
      await adapter.shutdown()
    }
    log.info('Agent manager stopped')
  }
}

module.exports = AgentManager
