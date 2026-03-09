require('dotenv').config()

const AgentManager = require('./core/AgentManager')
const EventBus = require('./core/EventBus')
const ModelRegistry = require('./core/ModelRegistry')
const DataCollector = require('./core/DataCollector')
const TrainingRunner = require('./core/TrainingRunner')
const HealthMonitor = require('./core/HealthMonitor')
const TrainingExporter = require('./data/exporters/TrainingExporter')
const SqliteStore = require('./data/storage/SqliteStore')
const Metrics = require('./utils/metrics')
const GcAdapter = require('./adapters/gc/GcAdapter')
const gcConfig = require('./adapters/gc/config')
const { createLogger } = require('./utils/logger')

const log = createLogger('main')

async function main() {
  log.info('appback-ai-agent v0.4.0 starting...')

  const eventBus = new EventBus()
  const modelDir = process.env.MODEL_DIR || './models'
  const dataDir = process.env.DATA_DIR || './data'
  const autoTrainAfter = parseInt(process.env.AUTO_TRAIN_AFTER_GAMES || '50')
  const healthPort = parseInt(process.env.HEALTH_PORT || '9090')

  // Data layer
  const store = new SqliteStore(dataDir)
  const dataCollector = new DataCollector(store)
  const modelRegistry = new ModelRegistry(modelDir)
  const metrics = new Metrics(store)
  const exporter = new TrainingExporter(store)
  const trainer = new TrainingRunner({
    dataDir: './training/data/raw',
    outputDir: `${modelDir}/gc`,
    autoTrainAfterGames: autoTrainAfter,
  })

  // Load historical metrics
  metrics.load('claw-clash')

  const config = {
    discoveryIntervalSec: parseInt(process.env.GAME_DISCOVERY_INTERVAL_SEC || '30'),
  }

  const manager = new AgentManager(config)

  // Register gc adapter with metrics
  const gc = new GcAdapter({
    config: gcConfig,
    modelRegistry,
    dataCollector,
    eventBus,
    metrics,
  })
  manager.registerAdapter(gc)

  // Health monitor
  const health = new HealthMonitor(healthPort, metrics, manager.adapters)
  health.start()

  // Graceful shutdown
  const shutdown = async () => {
    log.info('Shutting down...')
    health.stop()
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

    if (totalGames > 0 && totalGames % autoTrainAfter === 0 && !trainer.isRunning) {
      log.info(`Auto-train threshold reached (${totalGames} games), starting pipeline...`)

      const result = exporter.exportForTraining(game)
      if (result) {
        trainer.run(game).then(success => {
          if (success) {
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
