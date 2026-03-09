require('dotenv').config()

const AgentManager = require('./core/AgentManager')
const EventBus = require('./core/EventBus')
const ModelRegistry = require('./core/ModelRegistry')
const DataCollector = require('./core/DataCollector')
const TrainingRunner = require('./core/TrainingRunner')
const TrainingExporter = require('./data/exporters/TrainingExporter')
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
  const autoTrainAfter = parseInt(process.env.AUTO_TRAIN_AFTER_GAMES || '50')

  // Data layer
  const store = new SqliteStore(dataDir)
  const dataCollector = new DataCollector(store)
  const modelRegistry = new ModelRegistry(modelDir)
  const exporter = new TrainingExporter(store)
  const trainer = new TrainingRunner({
    dataDir: './training/data/raw',
    outputDir: `${modelDir}/gc`,
    autoTrainAfterGames: autoTrainAfter,
  })

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

  // Event handlers
  eventBus.on('game_found', ({ game, gameId }) => {
    log.info(`Game found: ${game} / ${gameId}`)
  })

  // Auto-training pipeline after games
  eventBus.on('game_ended', async ({ game, gameId }) => {
    log.info(`Game completed: ${game} / ${gameId}`)

    const totalGames = dataCollector.getSessionCount(game)

    // Check if we should trigger training
    if (totalGames > 0 && totalGames % autoTrainAfter === 0 && !trainer.isRunning) {
      log.info(`Auto-train threshold reached (${totalGames} games), starting pipeline...`)

      // Export data
      const result = exporter.exportForTraining(game)
      if (result) {
        // Run training (async, non-blocking)
        trainer.run(game).then(success => {
          if (success) {
            // ModelRegistry hot-reload will pick up the new model via fs.watch
            log.info('New model will be loaded automatically via hot-reload')
          }
        })
      }
    }
  })
}

main().catch(err => {
  log.error('Fatal error', err.message)
  process.exit(1)
})
