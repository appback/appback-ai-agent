const axios = require('axios')
const fs = require('fs')
const FormData = require('form-data')
const { createLogger } = require('../../utils/logger')
const { retry } = require('../../utils/retry')
const { buildAgentHeaders, validateLoadoutProfileContext } = require('../../config/GcServerContract')
const { isUuid, validateAgentJwt } = require('../../auth/agentJwt')
const log = createLogger('gc-api')

class GcApiClient {
  constructor(config, clientContract = null) {
    this.client = axios.create({
      baseURL: config.apiUrl,
      timeout: 10000,
      headers: clientContract ? buildAgentHeaders(clientContract) : undefined,
    })
    this.token = null
    this.credentialRejected = false
    this.authFailureHandler = null
    this.client.interceptors.request.use(request => {
      if (this.credentialRejected && request.url !== '/agent-contract') {
        const error = new Error('REAUTH_REQUIRED: AI Rewards agent JWT must be reissued')
        error.code = 'REAUTH_REQUIRED'
        return Promise.reject(error)
      }
      return request
    })
    this.client.interceptors.response.use(
      response => response,
      error => {
        const code = gcErrorCode(error)
        if (
          Number(error.response?.status) === 401 ||
          code === 'AI_REWARDS_JWT_REQUIRED' ||
          code === 'INVALID_AI_REWARDS_AGENT'
        ) {
          this.credentialRejected = true
          this.authFailureHandler?.(code || 'INVALID_AI_REWARDS_AGENT')
        }
        return Promise.reject(error)
      }
    )
  }

  async getAgentContract() {
    const { data } = await this.client.get('/agent-contract')
    return data
  }

  async getTrainingFrames(after = null, limit = 200) {
    const params = { limit }
    if (after) params.after = after
    const { data } = await this.client.get('/agents/me/training-frames', { params })
    return data
  }

  async getTrainingResults(after = null, limit = 200) {
    const params = { limit }
    if (after) params.after = after
    const { data } = await this.client.get('/agents/me/training-results', { params })
    return data
  }

  async getTrainingSession(sessionId) {
    const { data } = await this.client.get(`/agents/me/training-sessions/${encodeURIComponent(sessionId)}`)
    return data
  }

  setToken(token) {
    this.token = null
    this.credentialRejected = true
    delete this.client.defaults.headers.common['Authorization']
    const credential = validateAgentJwt(token)
    this.token = token
    this.credentialRejected = false
    this.client.defaults.headers.common['Authorization'] = `Bearer ${token}`
    return credential
  }

  onAuthFailure(handler) {
    this.authFailureHandler = typeof handler === 'function' ? handler : null
  }

  async register() {
    if (!this.token) throw new Error('AI_REWARDS_JWT_REQUIRED: register requires an AI Rewards agent JWT')
    log.info('Registering agent...')
    const { data } = await this.client.post('/agents/register', {
      model_name: 'appback-ai-agent',
    })
    if (!data || !isUuid(data.agent_id) || data.identity_source !== 'ai_rewards_jwt') {
      throw new Error('GC registration did not return a canonical AI Rewards identity')
    }
    return {
      ...data,
      agent_id: data.agent_id,
      identity_source: data.identity_source,
    }
  }

  async getChallenge() {
    const { data } = await retry(() => this.client.get('/challenge'))
    return data
  }

  async submitChallenge(loadout = {}, loadoutProfileContext = null) {
    const payload = {
      weapon: loadout.weapon || 'sword',
      armor: loadout.armor || 'leather',
      tier: loadout.tier || 'basic',
    }
    if (loadoutProfileContext) Object.assign(payload, validateLoadoutProfileContext(loadoutProfileContext))
    const { data } = await this.client.post('/challenge', payload)
    return data
  }

  async leaveQueue() {
    const { data } = await this.client.delete('/queue/leave')
    return data
  }

  async submitStrategy(gameId, strategy) {
    const { data } = await this.client.post(`/games/${gameId}/strategy`, strategy)
    return data
  }

  async getGameState(gameId) {
    const { data } = await this.client.get(`/games/${gameId}/state`)
    return data
  }

  async getEquipment() {
    const { data } = await this.client.get('/equipment')
    return data
  }

  async getAgentMe() {
    const { data } = await this.client.get('/agents/me')
    return data
  }

  async getQueueStatus() {
    const { data } = await this.client.get('/queue/status')
    return data
  }

  async getGameDetail(gameId) {
    const { data } = await this.client.get(`/games/${gameId}`)
    return data
  }

  async uploadModel(onnxPath) {
    const form = new FormData()
    form.append('model', fs.createReadStream(onnxPath))
    const { data } = await this.client.post('/agents/me/model', form, {
      headers: form.getHeaders(),
      maxBodyLength: 2 * 1024 * 1024,
    })
    return data
  }

  async uploadModelV8(onnxPath, metadata) {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      throw new TypeError('v8 model metadata must be an object')
    }

    const form = new FormData()
    form.append('model', fs.createReadStream(onnxPath))
    form.append('metadata', JSON.stringify(metadata))
    const { data } = await this.client.post('/agents/me/models/v8', form, {
      headers: form.getHeaders(),
      maxBodyLength: 2 * 1024 * 1024,
    })
    return data
  }

  async listModelsV8() {
    const { data } = await this.client.get('/agents/me/models/v8')
    return data
  }

  async deleteModel() {
    const { data } = await this.client.delete('/agents/me/model')
    return data
  }
}

function gcErrorCode(error) {
  const data = error?.response?.data
  if (typeof data?.error === 'string') return data.error
  if (typeof data?.error?.code === 'string') return data.error.code
  if (typeof data?.code === 'string') return data.code
  return null
}

module.exports = GcApiClient
