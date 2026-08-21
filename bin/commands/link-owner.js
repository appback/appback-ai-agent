const fs = require('fs')
const path = require('path')

const { AiRewardsAgentAuthClient } = require('../../src/auth/AiRewardsAgentAuthClient')
const { validateAgentJwt } = require('../../src/auth/agentJwt')
const { redactString } = require('../../src/auth/redaction')
const SqliteStore = require('../../src/data/storage/SqliteStore')

const OWNER_LINK_CODE_PATTERN = /^ARW-[A-Z0-9]{4}-[A-Z0-9]{4}$/

async function runLinkOwnerCommand(options = {}) {
  const args = options.args || []
  const cwd = options.cwd || process.cwd()
  const output = options.output || console
  const code = String(args[0] || '').trim().toUpperCase()

  if (args.length !== 1 || !OWNER_LINK_CODE_PATTERN.test(code)) {
    output.error('Usage: npx appback-ai-agent link-owner ARW-XXXX-XXXX')
    return 1
  }

  try {
    if (options.loadEnv !== false) {
      const envPath = path.join(cwd, '.env')
      if (fs.existsSync(envPath)) require('dotenv').config({ path: envPath })
      else require('dotenv').config()
    }

    const rawDataDir = options.dataDir || process.env.DATA_DIR || 'data'
    const dataDir = path.isAbsolute(rawDataDir) ? rawDataDir : path.resolve(cwd, rawDataDir)
    const store = options.storeFactory ? options.storeFactory(dataDir) : new SqliteStore(dataDir)
    let identity
    try {
      identity = store.getIdentity('claw-clash')
    } finally {
      store.close()
    }

    if (!identity) throw new Error('Local AI Rewards identity is missing; start the agent first')
    if (identity.credential_issuer !== 'ai-rewards' || identity.credential_type !== 'agent_jwt') {
      throw new Error('Local credential is not an AI Rewards agent JWT; start the agent to migrate it first')
    }
    validateAgentJwt(identity.api_token, { expectedAgentId: identity.agent_id })

    const client = options.authClient || new AiRewardsAgentAuthClient({
      apiUrl: process.env.AI_REWARDS_API_URL,
    })
    const result = await client.linkOwner({
      registrationCode: code,
      agentToken: identity.api_token,
    })
    if (result.agentId !== identity.agent_id) {
      throw new Error('Owner link response does not match the local agent UUID')
    }

    output.log(`Owner linked: ${result.agentName || identity.name || 'unnamed'} (${result.agentId})`)
    return 0
  } catch (error) {
    output.error(`Owner link failed: ${redactString(error.message)}`)
    return 1
  }
}

module.exports = { runLinkOwnerCommand }
