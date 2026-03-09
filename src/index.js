require('dotenv').config()

const AgentManager = require('./core/AgentManager')
const EventBus = require('./core/EventBus')
const ModelRegistry = require('./core/ModelRegistry')
const DataCollector = require('./core/DataCollector')
const SqliteStore = require('./data/storage/SqliteStore')
const GcAdapter = require('./adapters/gc/GcAdapter')
const gcConfig = require('./adapters/gc/config')
const { createLogger } = require('./utils/logger')

const log = createLogger('main')

async function main() {
  log.info('appback-ai-agent starting...')

  const eventBus = new EventBus()
  const modelDir = process.env.MODEL_DIR || './models'
  const dataDir = process.env.DATA_DIR || './data'

  // Data layer
  const store = new SqliteStore(dataDir)
  const dataCollector = new DataCollector(store)
  const modelRegistry = new ModelRegistry(modelDir)

  const config = {
    discoveryIntervalSec: parseInt(process.env.GAME_DISCOVERY_INTERVAL_SEC || '30'),
  }

  const manager = new AgentManager(config)

  // Register gc adapter
  const gc = new GcAdapter({
    config: gcConfig,
    modelRegistry,
    dataCollector,
    eventBus,
  })
  manager.registerAdapter(gc)

  // Graceful shutdown
  const shutdown = async () => {
    log.info('Shutting down...')
    await manager.stop()
    store.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // Start
  await manager.start()

  // Log game events
  eventBus.on('game_found', ({ game, gameId }) => {
    log.info(`Game found: ${game} / ${gameId}`)
  })
  eventBus.on('game_ended', ({ game, gameId }) => {
    log.info(`Game completed: ${game} / ${gameId}`)
  })
}

main().catch(err => {
  log.error('Fatal error', err.message)
  process.exit(1)
})
