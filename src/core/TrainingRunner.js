const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const { createLogger } = require('../utils/logger')
const log = createLogger('trainer')

class TrainingRunner {
  constructor(config = {}) {
    this.dataDir = config.dataDir || './training/data/raw'
    this.outputDir = config.outputDir || './models/gc'
    this.autoTrainAfterGames = config.autoTrainAfterGames || 50
    this.pythonPath = config.pythonPath || process.env.PYTHON_PATH || 'python3'
    this.runtimeContext = config.runtimeContext
      ? Object.freeze({ ...config.runtimeContext })
      : null
    this._running = false
  }

  get isRunning() { return this._running }

  async run(game = 'claw-clash') {
    if (this._running) {
      log.warn('Training already in progress')
      return false
    }

    this._running = true
    log.info(`Starting training for ${game} (python: ${this.pythonPath})...`)

    return new Promise((resolve) => {
      const scriptName = this.runtimeContext?.feature_version === '8.1'
        ? 'train_gc_strategy_model.py'
        : 'train_gc_model.py'
      const scriptPath = path.join(__dirname, '..', '..', 'training', scriptName)
      const proc = spawn(this.pythonPath, [
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
          try {
            this._writeOperationMetadata()
            log.info('Training completed successfully')
            resolve(true)
          } catch (err) {
            log.error('Trained model contract validation failed', err.message)
            resolve(false)
          }
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

  _writeOperationMetadata() {
    if (!this.runtimeContext) return
    const metaPath = path.join(this.outputDir, 'meta.json')
    if (!fs.existsSync(metaPath)) throw new Error(`Metadata not found: ${metaPath}`)
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
    if (meta.input_dim !== this.runtimeContext.feature_dim) {
      throw new Error(`input_dim=${meta.input_dim}, expected=${this.runtimeContext.feature_dim}`)
    }
    if (meta.output_dim !== this.runtimeContext.output_dim) {
      throw new Error(`output_dim=${meta.output_dim}, expected=${this.runtimeContext.output_dim}`)
    }
    const versioned = {
      ...meta,
      operation_version: this.runtimeContext.operation_version,
      feature_version: this.runtimeContext.feature_version,
      feature_schema_hash: this.runtimeContext.feature_schema_hash,
      training_version: this.runtimeContext.training_version,
      behavior_profile_id: this.runtimeContext.behavior_profile_id,
      behavior_profile_hash: this.runtimeContext.behavior_profile_hash,
      behavior_profile_revision: this.runtimeContext.behavior_profile_revision,
    }
    fs.writeFileSync(metaPath, `${JSON.stringify(versioned, null, 2)}\n`)
  }
}

module.exports = TrainingRunner
