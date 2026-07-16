// Global error handler — catch native module failures etc.
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.message || err)
  if (String(err.message).includes('better-sqlite3') || String(err.message).includes('better_sqlite3')) {
    console.error('\n  better-sqlite3 failed to load.')
    console.error('  On Windows, run: npm install --global windows-build-tools')
    console.error('  Or install Visual Studio C++ Build Tools + Python 3.\n')
  }
  console.error(err.stack || err)
  process.exit(1)
})

// CLI(bin/cli.js)에서 이미 로드한 경우 스킵
if (!process.env._PKG_ROOT) require('dotenv').config()

const path = require('path')
const paths = require('./paths')
const AgentManager = require('./core/AgentManager')
const EventBus = require('./core/EventBus')
const ModelRegistry = require('./core/ModelRegistry')
const DataCollector = require('./core/DataCollector')
const TrainingRunner = require('./core/TrainingRunner')
const Scheduler = require('./core/Scheduler')
const HealthMonitor = require('./core/HealthMonitor')
const TrainingExporter = require('./data/exporters/TrainingExporter')
const SqliteStore = require('./data/storage/SqliteStore')
const GcTrainingDataConsumer = require('./data/GcTrainingDataConsumer')
const Metrics = require('./utils/metrics')
const { BehaviorProfileStore } = require('./config/BehaviorProfileStore')
const { OperationVersionStore } = require('./config/OperationVersionStore')
const { buildRuntimeContext } = require('./config/operationContract')
const GcAdapter = require('./adapters/gc/GcAdapter')
const gcConfig = require('./adapters/gc/config')
const { createLogger } = require('./utils/logger')

const log = createLogger('main')

async function main() {
  const pkgVersion = require(path.join(__dirname, '..', 'package.json')).version
  log.info(`appback-ai-agent v${pkgVersion} starting...`)

  const eventBus = new EventBus()
  const modelDir = paths.modelDir()
  const dataDir = paths.dataDir()
  const behaviorProfile = new BehaviorProfileStore(paths.configDir()).getCurrent()
  const operationContract = new OperationVersionStore(paths.configDir()).ensureActive()
  const runtimeContext = buildRuntimeContext(operationContract, behaviorProfile)
  const trainingDataDir = paths.trainingDataDir(runtimeContext)
  const modelGenerationDir = paths.modelGenerationDir(runtimeContext)
  const modelRelativePath = path.relative(path.join(modelDir, 'gc'), path.join(modelGenerationDir, 'gc_move_model.onnx'))
  const autoTrainAfter = parseInt(process.env.AUTO_TRAIN_AFTER_GAMES || '50')
  const healthPort = parseInt(process.env.HEALTH_PORT || '9090')
  const trainingSyncEnabled = runtimeContext.feature_version.startsWith('8.') &&
    parseBoolean(process.env.GC_TRAINING_SYNC_ENABLED, true)
  const trainingSyncInterval = parseInt(process.env.GC_TRAINING_SYNC_INTERVAL_SEC || '30')

  log.info(`Behavior personality: ${behaviorProfile.effective.profile_id} (${behaviorProfile.effective.profile_hash}, r${behaviorProfile.effective.source_revision})`)
  log.info(`Operation contract: ${runtimeContext.operation_version} / feature v${runtimeContext.feature_version} (${runtimeContext.feature_dim} dims)`)

  // Data layer
  const store = new SqliteStore(dataDir, runtimeContext)
  const dataCollector = new DataCollector(store)
  const modelRegistry = new ModelRegistry(modelDir)
  const metrics = new Metrics(store)
  const exporter = new TrainingExporter(store, trainingDataDir, runtimeContext, behaviorProfile.effective)
  const trainer = new TrainingRunner({
    dataDir: trainingDataDir,
    outputDir: modelGenerationDir,
    autoTrainAfterGames: autoTrainAfter,
    runtimeContext,
  })

  // Load historical metrics
  metrics.load('claw-clash')

  const config = {
    discoveryIntervalSec: parseInt(process.env.GAME_DISCOVERY_INTERVAL_SEC || '30'),
  }

  const manager = new AgentManager(config)
  let trainingSyncScheduler = null

  // Register gc adapter with metrics
  const gc = new GcAdapter({
    config: gcConfig,
    modelRegistry,
    dataCollector,
    eventBus,
    metrics,
    runtimeContext,
    behaviorProfile: behaviorProfile.effective,
    modelRelativePath,
    agentVersion: pkgVersion,
  })
  manager.registerAdapter(gc)

  // Health monitor
  const health = new HealthMonitor(healthPort, metrics, manager.adapters)
  health.start()

  // Graceful shutdown
  const shutdown = async () => {
    log.info('Shutting down...')
    health.stop()
    if (trainingSyncScheduler) trainingSyncScheduler.stop()
    await manager.stop()
    store.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // Start
  await manager.start()

  if (trainingSyncEnabled && gc.apiToken) {
    const consumer = new GcTrainingDataConsumer({ api: gc.api, store, runtimeContext })
    trainingSyncScheduler = new Scheduler(trainingSyncInterval)
    trainingSyncScheduler.start(() => consumer.syncAvailable())
    log.info(`GC v8 training feed enabled, interval=${trainingSyncInterval}s`)
  } else if (trainingSyncEnabled) {
    log.warn('GC v8 training feed not started because agent authentication is unavailable')
  }

  // Event handlers
  eventBus.on('game_found', ({ game, gameId }) => {
    log.info(`Game found: ${game} / ${gameId}`)
  })

  // Auto-training pipeline after games
  eventBus.on('game_ended', async ({ game, gameId }) => {
    log.info(`Game completed: ${game} / ${gameId}`)

    // v8 training uses the authoritative GC feed, never the legacy viewer snapshots.
    if (runtimeContext.feature_version.startsWith('8.')) return

    const totalGames = dataCollector.getSessionCount(game)

    if (totalGames > 0 && totalGames % autoTrainAfter === 0 && !trainer.isRunning) {
      log.info(`Auto-train threshold reached (${totalGames} games), starting pipeline...`)

      const result = exporter.exportForTraining(game)
      if (result) {
        trainer.run(game).then(async (success) => {
          if (success) {
            log.info('New model trained, attempting server upload...')
            const modelPath = path.join(modelGenerationDir, 'gc_move_model.onnx')
            try {
              const fs = require('fs')
              if (fs.existsSync(modelPath)) {
                const uploadResult = await gc.api.uploadModel(modelPath)
                log.info(`Model uploaded to server: v${uploadResult.model_version}`)
                await modelRegistry.hotReload('gc', 'gc_move_model', {
                  featureDim: runtimeContext.feature_dim,
                  path: modelRelativePath,
                  runtimeContext,
                })
              }
            } catch (err) {
              const errData = err.response?.data
              if (errData?.error === 'VERSION_OUTDATED') {
                log.error(`[UPDATE REQUIRED] ${errData.message}`)
                log.error('Run: npm install -g appback-ai-agent@latest')
              } else {
                log.warn(`Model upload failed: ${err.message}`)
              }
            }
          }
        })
      }
    }
  })
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase())
}

main().catch(err => {
  log.error('Fatal error', err.message)
  console.error(err.stack || err)
  process.exit(1)
})
