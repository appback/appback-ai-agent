const axios = require('axios')
const { createLogger } = require('../../utils/logger')
const { retry } = require('../../utils/retry')
const log = createLogger('gc-api')

class GcApiClient {
  constructor(config) {
    this.client = axios.create({
      baseURL: config.apiUrl,
      timeout: 10000,
    })
    this.token = null
  }

  setToken(token) {
    this.token = token
    this.client.defaults.headers.common['Authorization'] = `Bearer ${token}`
  }

  async register(name) {
    log.info(`Registering agent: ${name}`)
    const { data } = await this.client.post('/agents/register', {
      name,
      model_name: 'appback-ai-agent',
    })
    return data
  }

  async getChallenge() {
    const { data } = await retry(() => this.client.get('/challenge'))
    return data
  }

  async submitChallenge(loadout = {}) {
    const { data } = await this.client.post('/challenge', {
      weapon: loadout.weapon || 'sword',
      armor: loadout.armor || 'leather',
      tier: loadout.tier || 'basic',
    })
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

  async submitMove(gameId, direction) {
    const { data } = await this.client.post(`/games/${gameId}/move`, { direction })
    return data
  }
}

module.exports = GcApiClient
