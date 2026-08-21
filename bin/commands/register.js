const path = require('path')
const { redactString } = require('../../src/auth/redaction')

async function runRegisterCommand(options) {
  const {
    registrationCode,
    cwd,
    output = console,
    dependencies = {},
  } = options

  const AiRewardsAgentAuthClient = dependencies.AiRewardsAgentAuthClient ||
    require('../../src/auth/AiRewardsAgentAuthClient').AiRewardsAgentAuthClient
  const GcApiClient = dependencies.GcApiClient || require('../../src/adapters/gc/GcApiClient')
  const SqliteStore = dependencies.SqliteStore || require('../../src/data/storage/SqliteStore')
  const registerCanonicalAgent = dependencies.registerCanonicalAgent ||
    require('../../src/auth/registerCanonicalAgent').registerCanonicalAgent
  const config = dependencies.config || require('../../src/adapters/gc/config')

  const rawDataDir = process.env.DATA_DIR || 'data'
  const dataDir = path.isAbsolute(rawDataDir) ? rawDataDir : path.resolve(cwd, rawDataDir)
  let store
  try {
    store = dependencies.store || new SqliteStore(dataDir)
    const existing = store.getIdentity('claw-clash')
    const agentName = process.env.AI_AGENT_NAME || existing?.name || 'appback-ai-agent'
    const authClient = dependencies.authClient || new AiRewardsAgentAuthClient({
      apiUrl: config.aiRewardsApiUrl,
    })
    const gcClient = dependencies.gcClient || new GcApiClient(config)

    const result = await registerCanonicalAgent({
      registrationCode,
      agentName,
      authClient,
      gcClient,
      store,
    })

    output.log('Successfully registered with AI Rewards and GC.')
    output.log(`  Service: ${result.service}`)
    output.log(`  Agent: ${result.agentName || 'unnamed'} (${result.agentId})`)
    output.log(`  Credential expires: ${result.expiresAt}`)
    return 0
  } catch (error) {
    const code = error.code ? `${error.code}: ` : ''
    output.error(`Error: ${code}${redactString(error.message || 'registration failed')}`)
    return 1
  } finally {
    if (!dependencies.store) store?.close?.()
  }
}

module.exports = { runRegisterCommand }
