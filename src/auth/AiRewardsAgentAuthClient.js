const axios = require('axios')
const { isUuid, validateAgentJwt } = require('./agentJwt')

const DEFAULT_API_URL = 'https://appback.app/api/v1'
const OWNER_LINK_CODE_PATTERN = /^ARW-[A-Z0-9]{4}-[A-Z0-9]{4}$/

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

  async issue({ agentId = null, agentName, agentToken = null }) {
    if (agentId && !isUuid(agentId)) {
      throw new AiRewardsAgentAuthError('INVALID_AGENT_ID', 'Existing agent ID must be a UUID')
    }
    if (typeof agentName !== 'string' || agentName.trim().length === 0 || agentName.length > 120) {
      throw new AiRewardsAgentAuthError('INVALID_AGENT_NAME', 'Agent name is required and must be at most 120 characters')
    }

    let data
    try {
      const payload = {
        agent_name: agentName.trim(),
        service: 'gc',
      }
      if (agentId) {
        payload.agent_id = agentId
        payload.agent_token = agentToken
      }
      const response = await this.client.post('/ai/agent-auth/issue', payload)
      data = response.data
    } catch (error) {
      const status = Number(error.response?.status) || null
      const code = status === 429 ? 'AGENT_ISSUE_RATE_LIMITED' : 'AI_REWARDS_AGENT_ISSUE_FAILED'
      throw new AiRewardsAgentAuthError(code, `AI Rewards agent credential issue failed${status ? ` (${status})` : ''}`, status)
    }

    return validateIssueResponse(data)
  }

  async linkOwner({ registrationCode, agentToken }) {
    const normalizedCode = String(registrationCode || '').trim().toUpperCase()
    if (!OWNER_LINK_CODE_PATTERN.test(normalizedCode)) {
      throw new AiRewardsAgentAuthError(
        'INVALID_OWNER_LINK_CODE',
        'Owner link code must use the ARW-XXXX-XXXX format'
      )
    }

    let jwt
    try {
      jwt = validateAgentJwt(agentToken)
    } catch (error) {
      throw new AiRewardsAgentAuthError(error.code || 'INVALID_AGENT_JWT', error.message)
    }

    let data
    try {
      const response = await this.client.post(
        '/ai/agent-owner/link',
        { registration_code: normalizedCode },
        { headers: { Authorization: `Bearer ${agentToken}` } }
      )
      data = response.data
    } catch (error) {
      const status = Number(error.response?.status) || null
      const code = status === 429 ? 'OWNER_LINK_RATE_LIMITED' : 'OWNER_LINK_FAILED'
      throw new AiRewardsAgentAuthError(code, `AI Rewards owner link failed${status ? ` (${status})` : ''}`, status)
    }

    return validateOwnerLinkResponse(data, jwt.agentId)
  }

}

function validateIssueResponse(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new AiRewardsAgentAuthError('INVALID_ISSUE_RESPONSE', 'AI Rewards returned an invalid issue response')
  }
  if (data.status !== 'ok' || data.service !== 'gc') {
    throw new AiRewardsAgentAuthError('INVALID_ISSUE_SERVICE', 'AI Rewards issue response is not for GC')
  }
  if (!isUuid(data.agent_id)) {
    throw new AiRewardsAgentAuthError('INVALID_ISSUE_AGENT_ID', 'AI Rewards issue response has an invalid agent UUID')
  }
  if (data.token_type !== 'Bearer') {
    throw new AiRewardsAgentAuthError('INVALID_ISSUE_TOKEN_TYPE', 'AI Rewards issue response has an invalid token type')
  }

  let jwt
  try {
    jwt = validateAgentJwt(data.agent_token, { expectedAgentId: data.agent_id })
  } catch (error) {
    throw new AiRewardsAgentAuthError(error.code || 'INVALID_ISSUE_JWT', error.message)
  }

  const expiresAt = new Date(data.expires_at)
  if (!data.expires_at || Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    throw new AiRewardsAgentAuthError('INVALID_ISSUE_EXPIRY', 'AI Rewards issue response has an invalid expiry')
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

function validateOwnerLinkResponse(data, expectedAgentId) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new AiRewardsAgentAuthError('INVALID_OWNER_LINK_RESPONSE', 'AI Rewards returned an invalid owner link response')
  }
  if (data.status !== 'linked' || data.service !== 'gc') {
    throw new AiRewardsAgentAuthError('INVALID_OWNER_LINK_RESPONSE', 'AI Rewards owner link response is not for GC')
  }
  if (!isUuid(data.registration_id) || data.agent_id !== expectedAgentId) {
    throw new AiRewardsAgentAuthError('OWNER_LINK_IDENTITY_MISMATCH', 'Owner link response does not match the local agent UUID')
  }
  if (['agent_token', 'token_type', 'expires_at'].some(key => Object.hasOwn(data, key))) {
    throw new AiRewardsAgentAuthError('OWNER_LINK_RETURNED_CREDENTIAL', 'Owner link must not issue or replace an agent credential')
  }

  return Object.freeze({
    service: 'gc',
    registrationId: data.registration_id,
    agentId: data.agent_id,
    agentName: typeof data.agent_name === 'string' && data.agent_name ? data.agent_name : null,
  })
}

module.exports = {
  AiRewardsAgentAuthClient,
  AiRewardsAgentAuthError,
  validateIssueResponse,
  validateOwnerLinkResponse,
}
