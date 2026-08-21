const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

class AgentJwtError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'AgentJwtError'
    this.code = code
  }
}

function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

function decodeSegment(segment) {
  try {
    const normalized = segment.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
  } catch {
    throw new AgentJwtError('INVALID_AGENT_JWT', 'AI Rewards agent credential is not a valid JWT')
  }
}

function decodeAgentJwt(token) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new AgentJwtError('AGENT_JWT_REQUIRED', 'AI Rewards agent JWT is required')
  }
  const parts = token.split('.')
  if (parts.length !== 3 || parts.some(part => part.length === 0)) {
    throw new AgentJwtError('INVALID_AGENT_JWT', 'AI Rewards agent credential is not a valid JWT')
  }
  const header = decodeSegment(parts[0])
  const payload = decodeSegment(parts[1])
  if (!header || typeof header !== 'object' || !payload || typeof payload !== 'object') {
    throw new AgentJwtError('INVALID_AGENT_JWT', 'AI Rewards agent credential is not a valid JWT')
  }
  return { header, payload }
}

function audienceIncludes(audience, expected) {
  if (typeof audience === 'string') return audience === expected
  return Array.isArray(audience) && audience.includes(expected)
}

function validateAgentJwt(token, options = {}) {
  const { payload } = decodeAgentJwt(token)
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000)

  if (!isUuid(payload.sub)) {
    throw new AgentJwtError('INVALID_AGENT_JWT_SUBJECT', 'AI Rewards agent JWT subject must be a UUID')
  }
  if (payload.iss !== 'ai-rewards') {
    throw new AgentJwtError('INVALID_AGENT_JWT_ISSUER', 'AI Rewards agent JWT issuer is invalid')
  }
  if (!audienceIncludes(payload.aud, 'game:gc')) {
    throw new AgentJwtError('INVALID_AGENT_JWT_AUDIENCE', 'AI Rewards agent JWT audience is invalid')
  }
  if (payload.token_type !== 'ai_rewards_agent' || payload.service !== 'gc') {
    throw new AgentJwtError('INVALID_AGENT_JWT_TYPE', 'AI Rewards agent JWT type is invalid')
  }
  if (!Number.isInteger(payload.exp)) {
    throw new AgentJwtError('INVALID_AGENT_JWT_EXPIRY', 'AI Rewards agent JWT expiry is invalid')
  }
  if (!options.allowExpired && payload.exp <= nowSeconds) {
    throw new AgentJwtError('AGENT_JWT_EXPIRED', 'AI Rewards agent JWT has expired; issue an Auth Code and register again')
  }
  if (options.expectedAgentId && payload.sub !== options.expectedAgentId) {
    throw new AgentJwtError(
      'AGENT_IDENTITY_MISMATCH',
      'AI Rewards JWT UUID does not match the stored agent UUID'
    )
  }

  return {
    agentId: payload.sub,
    expiresAt: new Date(payload.exp * 1000).toISOString(),
    payload,
  }
}

module.exports = {
  AgentJwtError,
  decodeAgentJwt,
  isUuid,
  validateAgentJwt,
}
