const assert = require('node:assert/strict')
const test = require('node:test')
const GcAdapter = require('../src/adapters/gc/GcAdapter')

function adapter(featureVersion) {
  let sessions = 0
  const instance = new GcAdapter({
    config: { apiUrl: 'https://example.invalid', wsUrl: 'https://example.invalid' },
    dataCollector: {
      startSession() { sessions++; return 1 },
    },
    eventBus: { emit() {} },
    runtimeContext: { feature_version: featureVersion, feature_dim: featureVersion === '8.0' ? 192 : 153 },
    agentVersion: '2.2.1',
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
})
