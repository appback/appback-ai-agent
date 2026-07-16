const assert = require('node:assert/strict')
const test = require('node:test')
const GcAdapter = require('../src/adapters/gc/GcAdapter')

const PROFILE = Object.freeze({
  profile_id: 'hunter',
  profile_hash: `sha256:${'a'.repeat(64)}`,
  source_revision: 4,
  equipment: {},
})

function adapter(featureVersion, behaviorProfile = PROFILE) {
  let sessions = 0
  const instance = new GcAdapter({
    config: { apiUrl: 'https://example.invalid', wsUrl: 'https://example.invalid' },
    dataCollector: {
      startSession() { sessions++; return 1 },
    },
    eventBus: { emit() {} },
    runtimeContext: {
      feature_version: featureVersion,
      feature_dim: featureVersion === '8.1' ? 214 : featureVersion === '8.0' ? 192 : 153,
    },
    agentVersion: '2.2.1',
    behaviorProfile,
  })
  instance.ws = { joinGame() {} }
  instance._cacheTerrain = async () => {}
  return { instance, sessionCount: () => sessions }
}

test('v8 operation never starts the legacy viewer training session', async () => {
  const v8 = adapter('8.0')
  await v8.instance._enterGame('game-v8', 0)
  assert.equal(v8.sessionCount(), 0)
  assert.equal(v8.instance.sessionId, null)

  const v7 = adapter('7.0')
  await v7.instance._enterGame('game-v7', 1)
  assert.equal(v7.sessionCount(), 1)
  assert.equal(v7.instance.sessionId, 1)

  const v81 = adapter('8.1')
  await v81.instance._enterGame('game-v81', 2)
  assert.equal(v81.sessionCount(), 0)
  assert.equal(v81.instance.sessionId, null)
})

test('loadout profile context is gated by the server capability', async () => {
  const { instance } = adapter('8.0')
  instance.api.getAgentContract = async () => ({
    protocol_version: 1,
    enforcement: 'observe',
    accepted_feature_versions: ['7.0', '8.0'],
    capabilities: { loadout_profile_context: true },
  })

  await instance._checkServerContract()
  assert.deepEqual(instance._getLoadoutProfileContext(), {
    loadout_profile_id: 'hunter',
    loadout_profile_hash: PROFILE.profile_hash,
    loadout_profile_revision: 4,
  })

  instance.serverCapabilities = Object.freeze({})
  assert.equal(instance._getLoadoutProfileContext(), null)
})

test('v8.1 contract preflight fails closed without the strategy capability', async () => {
  const { instance } = adapter('8.1')
  instance.api.getAgentContract = async () => ({
    protocol_version: 1,
    enforcement: 'observe',
    accepted_feature_versions: ['7.0', '8.0', '8.1'],
    capabilities: { strategy_v8_1: false },
  })
  await assert.rejects(instance._checkServerContract(), /v8\.1 contract preflight failed/)

  instance.api.getAgentContract = async () => {
    throw new Error('connection refused')
  }
  await assert.rejects(instance._checkServerContract(), /connection refused/)

  instance.api.getAgentContract = async () => ({
    protocol_version: 1,
    enforcement: 'observe',
    accepted_feature_versions: ['7.0', '8.0', '8.1'],
    capabilities: { strategy_v8_1: true },
  })
  await assert.doesNotReject(instance._checkServerContract())
})

test('join submits the complete profile tuple only to supporting servers', async () => {
  const supported = adapter('8.0').instance
  supported.serverCapabilities = Object.freeze({ loadout_profile_context: true })
  supported.equipmentManager.selectLoadout = () => ({ weapon: 'hammer', armor: 'cloth_cape', tier: 'basic' })
  let supportedArgs
  supported.api.submitChallenge = async (...args) => {
    supportedArgs = args
    return { status: 'waiting' }
  }
  await supported.joinGame()
  assert.deepEqual(supportedArgs[1], {
    loadout_profile_id: 'hunter',
    loadout_profile_hash: PROFILE.profile_hash,
    loadout_profile_revision: 4,
  })

  const legacy = adapter('7.0').instance
  legacy.equipmentManager.selectLoadout = supported.equipmentManager.selectLoadout
  let legacyContext = 'not-called'
  legacy.api.submitChallenge = async (_loadout, context) => {
    legacyContext = context
    return { status: 'waiting' }
  }
  await legacy.joinGame()
  assert.equal(legacyContext, null)
})
