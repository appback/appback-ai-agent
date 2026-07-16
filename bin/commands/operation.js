const path = require('path')
const { OperationVersionStore } = require('../../src/config/OperationVersionStore')
const { getOperationContract, OPERATION_CONTRACTS } = require('../../src/config/operationContract')

function runOperationCommand({ args, cwd }) {
  const command = args[0] || 'show'

  try {
    const target = command === 'activate' ? args.slice(1).find(arg => !arg.startsWith('-')) : null
    const targetContract = target ? getOperationContract(target) : null
    if (target && !targetContract) {
      throw new Error(`Unknown operation: ${target}. Available: ${Object.keys(OPERATION_CONTRACTS).join(', ')}`)
    }
    const store = new OperationVersionStore(path.join(cwd, 'config'), targetContract)

    if (command === 'show' || command === 'verify') {
      const status = store.getStatus()
      if (args.includes('--json')) console.log(JSON.stringify(status, null, 2))
      else printStatus(status)
      return command === 'verify' && !status.compatible ? 1 : 0
    }

    if (command === 'activate') {
      const contract = store.activate({ allowChange: args.includes('--yes') })
      console.log(`Active operation: ${contract.operation_version}`)
      console.log(`Feature contract: v${contract.feature_version} / ${contract.feature_dim} dimensions`)
      return 0
    }

    if (command === 'history') {
      const history = store.listHistory()
      if (history.length === 0) console.log('No archived operation contracts')
      for (const item of history) console.log(`${item.operation_version}\t${item.activated_at || '-'}`)
      return 0
    }

    printHelp()
    return command === 'help' ? 0 : 1
  } catch (err) {
    console.error(`Error: ${err.message}`)
    return 1
  }
}

function printStatus(status) {
  console.log(`Binary operation: ${status.binary.operation_version}`)
  console.log(`Active operation: ${status.active?.operation_version || 'not initialized'}`)
  console.log(`Feature contract: v${status.binary.feature_version} / ${status.binary.feature_dim} dimensions`)
  console.log(`Status: ${status.compatible ? 'compatible' : 'MISMATCH'}`)
}

function printHelp() {
  console.log(`Usage:
  appback-ai-agent operation show [--json]
  appback-ai-agent operation verify
  appback-ai-agent operation activate [v7|v8|v81] --yes
  appback-ai-agent operation history`)
}

module.exports = { runOperationCommand }
