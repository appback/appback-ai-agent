const { isUuid } = require('./agentJwt')

class CanonicalRegistrationError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'CanonicalRegistrationError'
    this.code = code
  }
}

async function registerCanonicalAgent(options) {
  const {
    registrationCode,
    agentName,
    authClient,
    gcClient,
    store,
    game = 'claw-clash',
  } = options
  const existing = store.getIdentity(game)
  const exchange = await authClient.exchange({ registrationCode, agentName })

  if (existing?.agent_id && existing.agent_id !== exchange.agentId) {
    throw new CanonicalRegistrationError(
      'EXISTING_AGENT_ID_MISMATCH',
      'Auth Code UUID does not match the existing local agent UUID; existing identity was preserved'
    )
  }

  gcClient.setToken(exchange.agentToken)
  const registered = await gcClient.register()
  if (!isUuid(registered.agent_id) || registered.agent_id !== exchange.agentId) {
    throw new CanonicalRegistrationError(
      'GC_AGENT_ID_MISMATCH',
      'GC registration UUID does not match the AI Rewards canonical UUID; credentials were not saved'
    )
  }
  if (registered.identity_source !== 'ai_rewards_jwt') {
    throw new CanonicalRegistrationError(
      'GC_IDENTITY_SOURCE_MISMATCH',
      'GC registration did not confirm AI Rewards JWT identity; credentials were not saved'
    )
  }

  const name = registered.name || exchange.agentName || agentName
  store.saveCanonicalIdentity({
    game,
    agentId: exchange.agentId,
    gcAgentId: registered.agent_id,
    agentToken: exchange.agentToken,
    name,
    expiresAt: exchange.expiresAt,
  })

  return Object.freeze({
    service: exchange.service,
    agentId: exchange.agentId,
    agentName: name,
    expiresAt: exchange.expiresAt,
  })
}

module.exports = { CanonicalRegistrationError, registerCanonicalAgent }
