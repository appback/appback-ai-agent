const axios = require('axios')
const fs = require('fs')
const FormData = require('form-data')
const { createLogger } = require('../../utils/logger')
const { retry } = require('../../utils/retry')
const { buildAgentHeaders, validateLoadoutProfileContext } = require('../../config/GcServerContract')
const log = createLogger('gc-api')

class GcApiClient {
  constructor(config, clientContract = null) {
    this.client = axios.create({
      baseURL: config.apiUrl,
      timeout: 10000,
      headers: clientContract ? buildAgentHeaders(clientContract) : undefined,
    })
    this.token = null
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
    this.token = token
    this.client.defaults.headers.common['Authorization'] = `Bearer ${token}`
  }

  async register() {
    log.info('Registering agent...')
    const { data } = await this.client.post('/agents/register', {
      model_name: 'appback-ai-agent',
    })
    return data
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

module.exports = GcApiClient
