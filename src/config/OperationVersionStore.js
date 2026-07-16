const fs = require('fs')
const path = require('path')
const {
  CURRENT_OPERATION_CONTRACT,
  contractsEqual,
  getOperationContract,
} = require('./operationContract')
const { readJson, writeJsonAtomic } = require('./BehaviorProfileStore')

class OperationVersionStore {
  constructor(configDir, currentContract = null) {
    this.configDir = configDir
    this.contractPath = path.join(configDir, 'operation.json')
    this.historyDir = path.join(configDir, 'operation.history')
    const active = fs.existsSync(this.contractPath) ? readJson(this.contractPath) : null
    const detected = active ? getOperationContract(active.operation_version) : null
    this.currentContract = { ...(currentContract || detected || CURRENT_OPERATION_CONTRACT) }
  }

  getStatus() {
    const active = fs.existsSync(this.contractPath) ? readJson(this.contractPath) : null
    return {
      active,
      binary: { ...this.currentContract },
      initialized: Boolean(active),
      compatible: contractsEqual(active, this.currentContract),
    }
  }

  ensureActive(options = {}) {
    const { initialize = true } = options
    const status = this.getStatus()
    if (!status.initialized && initialize) return this.activate({ allowChange: true })
    if (!status.compatible) {
      const active = status.active?.operation_version || 'not-initialized'
      throw new Error(
        `Operation contract mismatch: active=${active}, binary=${status.binary.operation_version}. ` +
        'Run: appback-ai-agent operation activate --yes'
      )
    }
    return status.active
  }

  activate(options = {}) {
    const { allowChange = false } = options
    const status = this.getStatus()
    if (status.initialized && !status.compatible && !allowChange) {
      throw new Error('Changing the operation contract requires --yes')
    }
    if (status.compatible) return status.active

    fs.mkdirSync(this.configDir, { recursive: true })
    if (status.active) {
      fs.mkdirSync(this.historyDir, { recursive: true })
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      writeJsonAtomic(path.join(this.historyDir, `${timestamp}-${status.active.operation_version}.json`), status.active)
    }

    const activated = {
      ...this.currentContract,
      activated_at: new Date().toISOString(),
    }
    writeJsonAtomic(this.contractPath, activated)
    return activated
  }

  listHistory() {
    if (!fs.existsSync(this.historyDir)) return []
    return fs.readdirSync(this.historyDir)
      .filter(name => name.endsWith('.json'))
      .sort()
      .reverse()
      .map(name => readJson(path.join(this.historyDir, name)))
  }
}

module.exports = { OperationVersionStore }
