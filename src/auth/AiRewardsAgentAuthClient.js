const axios = require('axios')
const { isUuid, validateAgentJwt } = require('./agentJwt')

const DEFAULT_API_URL = 'https://appback.app/api/v1'
const CODE_PATTERN = /^ARW-[A-Z0-9]{4}-[A-Z0-9]{4}$/i

class AiRewardsAgentAuthError extends Error {
  constructor(code, message, status = null) {
    super(message)
    this.name = 'AiRewardsAgentAuthError'
    this.code = code
    this.status = status
  }
}

class AiRewardsAgentAuthClient {
  constructor(options = {}) {
    this.client = options.client || axios.create({
      baseURL: options.apiUrl || DEFAULT_API_URL,
      timeout: options.timeoutMs || 10000,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  async exchange({ registrationCode, agentName }) {
    if (!CODE_PATTERN.test(String(registrationCode || ''))) {
      throw new AiRewardsAgentAuthError('INVALID_REGISTRATION_CODE', 'AI Rewards registration code format is invalid')
    }
    if (typeof agentName !== 'string' || agentName.trim().length === 0 || agentName.length > 120) {
      throw new AiRewardsAgentAuthError('INVALID_AGENT_NAME', 'Agent name is required and must be at most 120 characters')
    }

    let data
    try {
      const response = await this.client.post('/ai/agent-auth/exchange', {
        registration_code: registrationCode,
        agent_name: agentName.trim(),
      })
      data = response.data
    } catch (error) {
      const status = Number(error.response?.status) || null
      const code = status === 400 || status === 404 || status === 409
        ? 'REGISTRATION_CODE_REJECTED'
        : status === 429
          ? 'REGISTRATION_RATE_LIMITED'
          : 'AI_REWARDS_EXCHANGE_FAILED'
      throw new AiRewardsAgentAuthError(code, `AI Rewards code exchange failed${status ? ` (${status})` : ''}`, status)
    }

    return validateExchangeResponse(data)
  }
}

function validateExchangeResponse(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new AiRewardsAgentAuthError('INVALID_EXCHANGE_RESPONSE', 'AI Rewards returned an invalid exchange response')
  }
  if (data.status !== 'ok' || data.service !== 'gc') {
    throw new AiRewardsAgentAuthError('INVALID_EXCHANGE_SERVICE', 'AI Rewards exchange response is not for GC')
  }
  if (!isUuid(data.agent_id)) {
    throw new AiRewardsAgentAuthError('INVALID_EXCHANGE_AGENT_ID', 'AI Rewards exchange response has an invalid agent UUID')
  }
  if (data.token_type !== 'Bearer') {
    throw new AiRewardsAgentAuthError('INVALID_EXCHANGE_TOKEN_TYPE', 'AI Rewards exchange response has an invalid token type')
  }

  let jwt
  try {
    jwt = validateAgentJwt(data.agent_token, { expectedAgentId: data.agent_id })
  } catch (error) {
    throw new AiRewardsAgentAuthError(error.code || 'INVALID_EXCHANGE_JWT', error.message)
  }

  const expiresAt = new Date(data.expires_at)
  if (!data.expires_at || Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    throw new AiRewardsAgentAuthError('INVALID_EXCHANGE_EXPIRY', 'AI Rewards exchange response has an invalid expiry')
  }

  return Object.freeze({
    service: 'gc',
    agentId: data.agent_id,
    agentName: typeof data.agent_name === 'string' && data.agent_name ? data.agent_name : null,
    agentToken: data.agent_token,
    tokenType: 'Bearer',
    expiresAt: expiresAt.toISOString(),
    jwtExpiresAt: jwt.expiresAt,
  })
}

module.exports = {
  AiRewardsAgentAuthClient,
  AiRewardsAgentAuthError,
  validateExchangeResponse,
}
