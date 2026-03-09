const { spawn } = require('child_process')
const path = require('path')
const { createLogger } = require('../utils/logger')
const log = createLogger('trainer')

class TrainingRunner {
  constructor(config = {}) {
    this.dataDir = config.dataDir || './training/data/raw'
    this.outputDir = config.outputDir || './models/gc'
    this.autoTrainAfterGames = config.autoTrainAfterGames || 50
    this._running = false
  }

  get isRunning() { return this._running }

  async run(game = 'claw-clash') {
    if (this._running) {
      log.warn('Training already in progress')
      return false
    }

    this._running = true
    log.info(`Starting training for ${game}...`)

    return new Promise((resolve) => {
      const scriptPath = path.join(__dirname, '..', '..', 'training', 'train_gc_model.py')
      const proc = spawn('python3', [
        scriptPath,
        '--data-dir', this.dataDir,
        '--output-dir', this.outputDir,
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''

      proc.stdout.on('data', (data) => {
        stdout += data.toString()
        const lines = data.toString().trim().split('\n')
        for (const line of lines) {
          if (line.trim()) log.info(`[train] ${line.trim()}`)
        }
      })

      proc.stderr.on('data', (data) => {
        stderr += data.toString()
      })

      proc.on('close', (code) => {
        this._running = false
        if (code === 0) {
          log.info('Training completed successfully')
          resolve(true)
        } else {
          log.error(`Training failed (exit code ${code})`, stderr.slice(-500))
          resolve(false)
        }
      })

      proc.on('error', (err) => {
        this._running = false
        log.error('Failed to start training process', err.message)
        resolve(false)
      })
    })
  }
}

module.exports = TrainingRunner
