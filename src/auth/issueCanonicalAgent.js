const { isUuid } = require('./agentJwt')

class CanonicalIdentityError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'CanonicalIdentityError'
    this.code = code
  }
}

async function issueCanonicalAgent(options) {
  const {
    agentName,
    authClient,
    gcClient,
    store,
    game = 'claw-clash',
  } = options
  const existing = store.getIdentity(game)
  const issued = await authClient.issue({
    agentId: existing?.agent_id || null,
    agentName,
    agentToken: existing?.api_token || null,
  })

  if (existing?.agent_id && existing.agent_id !== issued.agentId) {
    throw new CanonicalIdentityError(
      'EXISTING_AGENT_ID_MISMATCH',
      'AI Rewards issued a different UUID; existing identity was preserved'
    )
  }

  gcClient.setToken(issued.agentToken)
  const registered = await gcClient.register()
  if (!isUuid(registered.agent_id) || registered.agent_id !== issued.agentId) {
    throw new CanonicalIdentityError(
      'GC_AGENT_ID_MISMATCH',
      'GC registration UUID does not match the AI Rewards canonical UUID; credentials were not saved'
    )
  }
  if (registered.identity_source !== 'ai_rewards_jwt') {
    throw new CanonicalIdentityError(
      'GC_IDENTITY_SOURCE_MISMATCH',
      'GC registration did not confirm AI Rewards JWT identity; credentials were not saved'
    )
  }

  const name = registered.name || issued.agentName || agentName
  store.saveCanonicalIdentity({
    game,
    agentId: issued.agentId,
    gcAgentId: registered.agent_id,
    agentToken: issued.agentToken,
    name,
    expiresAt: issued.expiresAt,
  })

  return Object.freeze({
    service: issued.service,
    agentId: issued.agentId,
    agentName: name,
    expiresAt: issued.expiresAt,
    agentToken: issued.agentToken,
  })
}

module.exports = { CanonicalIdentityError, issueCanonicalAgent }
