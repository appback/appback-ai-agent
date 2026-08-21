const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const Database = require('better-sqlite3')

const { AiRewardsAgentAuthClient } = require('../src/auth/AiRewardsAgentAuthClient')
const { validateAgentJwt } = require('../src/auth/agentJwt')
const { redactSensitive, redactString } = require('../src/auth/redaction')
const { issueCanonicalAgent } = require('../src/auth/issueCanonicalAgent')
const GcApiClient = require('../src/adapters/gc/GcApiClient')
const GcAdapter = require('../src/adapters/gc/GcAdapter')
const SqliteStore = require('../src/data/storage/SqliteStore')
const AgentManager = require('../src/core/AgentManager')

const AGENT_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_AGENT_ID = '22222222-2222-4222-8222-222222222222'

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function makeJwt(agentId = AGENT_ID, options = {}) {
  const now = Math.floor(Date.now() / 1000)
  const payload = {
    sub: agentId,
    iss: 'ai-rewards',
    aud: 'game:gc',
    token_type: 'ai_rewards_agent',
    service: 'gc',
    jti: 'test-jti',
    exp: options.exp ?? now + 3600,
    ...options.claims,
  }
  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(payload)}.test-signature`
}

function makeExchange(token = makeJwt(), overrides = {}) {
  return {
    status: 'ok',
    service: 'gc',
    agent_id: AGENT_ID,
    agent_name: 'canonical-agent',
    agent_token: token,
    token_type: 'Bearer',
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    ...overrides,
  }
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

test('AI Rewards issue requests a UUID/JWT without owner identity', async () => {
  const jwt = makeJwt()
  let request = null
  const client = new AiRewardsAgentAuthClient({
    client: {
      post: async (url, body) => {
        request = { url, body }
        return { data: makeExchange(jwt) }
      },
    },
  })

  const result = await client.issue({ agentName: 'canonical-agent' })
  assert.equal(result.agentId, AGENT_ID)
  assert.equal(request.url, '/ai/agent-auth/issue')
  assert.deepEqual(request.body, { agent_name: 'canonical-agent', service: 'gc' })
  assert.doesNotMatch(JSON.stringify(request.body), /owner|email|user/i)
})

test('AI Rewards issue rejects another service and non-JWT credentials', async () => {
  const wrongService = new AiRewardsAgentAuthClient({
    client: { post: async () => ({ data: makeExchange(makeJwt(), { service: 'tc' }) }) },
  })
  await assert.rejects(
    wrongService.issue({ agentName: 'agent' }),
    error => error.code === 'INVALID_ISSUE_SERVICE'
  )

  const legacyToken = new AiRewardsAgentAuthClient({
    client: { post: async () => ({ data: makeExchange('legacy-agent-token') }) },
  })
  await assert.rejects(
    legacyToken.issue({ agentName: 'agent' }),
    error => error.code === 'INVALID_AGENT_JWT'
  )
  assert.throws(() => validateAgentJwt('cr_agent_legacy-credential'), /not a valid JWT/)
})

test('secret redaction removes registration codes, JWTs, bearer headers, and token fields', () => {
  const jwt = makeJwt()
  const safe = redactSensitive({
    registration_code: 'ARW-1234-ABCD',
    agent_token: jwt,
    headers: { Authorization: `Bearer ${jwt}` },
    message: `code ARW-1234-ABCD jwt ${jwt}`,
  })

  const serialized = JSON.stringify(safe)
  assert.doesNotMatch(serialized, /ARW-1234-ABCD/)
  assert.doesNotMatch(serialized, /test-signature/)
  assert.match(redactString(`Bearer ${jwt}`), /Bearer \[REDACTED\]/)
})

test('SQLite additive migration preserves a legacy identity row', () => {
  const dir = tempDir('agent-auth-migration-')
  const dbPath = path.join(dir, 'agent.db')
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE agent_identity (
      game TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      api_token TEXT NOT NULL,
      name TEXT,
      registered_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `)
  db.prepare('INSERT INTO agent_identity (game, agent_id, api_token, name) VALUES (?, ?, ?, ?)')
    .run('claw-clash', AGENT_ID, 'legacy-token', 'legacy-agent')
  db.close()

  const store = new SqliteStore(dir)
  const identity = store.getIdentity('claw-clash')
  const columns = new Set(store.db.pragma('table_info(agent_identity)').map(column => column.name))
  store.close()

  assert.equal(identity.agent_id, AGENT_ID)
  assert.equal(identity.api_token, 'legacy-token')
  assert.ok(columns.has('credential_issuer'))
  assert.ok(columns.has('credential_type'))
  assert.ok(columns.has('token_expires_at'))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('canonical identity save is atomic and rejects every UUID mismatch', () => {
  const dir = tempDir('agent-auth-store-')
  const store = new SqliteStore(dir)
  const originalJwt = makeJwt()
  store.saveCanonicalIdentity({
    game: 'claw-clash',
    agentId: AGENT_ID,
    gcAgentId: AGENT_ID,
    agentToken: originalJwt,
    name: 'canonical-agent',
  })

  assert.throws(() => store.saveCanonicalIdentity({
    game: 'claw-clash',
    agentId: AGENT_ID,
    gcAgentId: OTHER_AGENT_ID,
    agentToken: originalJwt,
    name: 'wrong-gc-agent',
  }), /UUID validation failed/)
  assert.throws(() => store.saveCanonicalIdentity({
    game: 'claw-clash',
    agentId: OTHER_AGENT_ID,
    gcAgentId: OTHER_AGENT_ID,
    agentToken: makeJwt(OTHER_AGENT_ID),
    name: 'wrong-local-agent',
  }), /Existing agent UUID/)

  const preserved = store.getIdentity('claw-clash')
  assert.equal(preserved.agent_id, AGENT_ID)
  assert.equal(preserved.api_token, originalJwt)
  assert.equal(preserved.credential_issuer, 'ai-rewards')
  assert.equal(preserved.credential_type, 'agent_jwt')
  store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('owner-free issue flow resumes the local UUID and persists only after GC agrees', async () => {
  const dir = tempDir('agent-auth-issue-')
  const store = new SqliteStore(dir)
  const legacyJwt = makeJwt()
  store.saveCanonicalIdentity({
    game: 'claw-clash', agentId: AGENT_ID, gcAgentId: AGENT_ID,
    agentToken: legacyJwt, name: 'canonical-agent',
  })
  const renewedJwt = makeJwt(AGENT_ID, { claims: { jti: 'renewed-jti' } })
  let issueInput = null
  const result = await issueCanonicalAgent({
    agentName: 'canonical-agent',
    authClient: {
      issue: async input => {
        issueInput = input
        return {
          service: 'gc', agentId: AGENT_ID, agentName: 'canonical-agent',
          agentToken: renewedJwt, expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }
      },
    },
    gcClient: {
      setToken: token => assert.equal(token, renewedJwt),
      register: async () => ({
        agent_id: AGENT_ID, name: 'canonical-agent', identity_source: 'ai_rewards_jwt',
      }),
    },
    store,
  })
  assert.deepEqual(issueInput, {
    agentId: AGENT_ID,
    agentName: 'canonical-agent',
    agentToken: legacyJwt,
  })
  assert.equal(result.agentId, AGENT_ID)
  assert.equal(store.getIdentity('claw-clash').api_token, renewedJwt)
  store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('mock AI Rewards and GC integration issues, registers, and persists one identity', async t => {
  const jwt = makeJwt()
  const seen = []
  const rewardsServer = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      seen.push({ service: 'rewards', path: req.url, body: JSON.parse(body) })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(makeExchange(jwt)))
    })
  })
  const gcServer = http.createServer((req, res) => {
    seen.push({ service: 'gc', path: req.url, authorization: req.headers.authorization })
    res.writeHead(201, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      agent_id: AGENT_ID,
      name: 'canonical-agent',
      identity_source: 'ai_rewards_jwt',
    }))
  })
  await Promise.all([
    new Promise(resolve => rewardsServer.listen(0, '127.0.0.1', resolve)),
    new Promise(resolve => gcServer.listen(0, '127.0.0.1', resolve)),
  ])
  t.after(() => rewardsServer.close())
  t.after(() => gcServer.close())

  const rewardsUrl = `http://127.0.0.1:${rewardsServer.address().port}`
  const gcUrl = `http://127.0.0.1:${gcServer.address().port}`
  const dir = tempDir('agent-auth-integration-')
  const store = new SqliteStore(dir)
  const authClient = new AiRewardsAgentAuthClient({ apiUrl: rewardsUrl })
  const gcClient = new GcApiClient({ apiUrl: gcUrl })

  await issueCanonicalAgent({
    agentName: 'canonical-agent',
    authClient,
    gcClient,
    store,
  })

  assert.equal(seen[0].path, '/ai/agent-auth/issue')
  assert.equal(seen[1].path, '/agents/register')
  assert.equal(seen[1].authorization, `Bearer ${jwt}`)
  assert.equal(store.getIdentity('claw-clash').agent_id, AGENT_ID)
  store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('GC auth rejection revokes the client session until a new JWT is set', async t => {
  const server = http.createServer((req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ message: 'unauthorized' }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())

  const client = new GcApiClient({ apiUrl: `http://127.0.0.1:${server.address().port}` })
  let failureCode = null
  client.onAuthFailure(code => { failureCode = code })
  client.setToken(makeJwt())
  await assert.rejects(client.getAgentMe())
  assert.equal(failureCode, 'INVALID_AI_REWARDS_AGENT')
  assert.equal(client.credentialRejected, true)
  await assert.rejects(client.getQueueStatus(), /REAUTH_REQUIRED/)

  assert.throws(() => client.setToken('cr_agent_legacy-credential'), /not a valid JWT/)
  assert.equal(client.token, null)
  assert.equal(client.client.defaults.headers.common.Authorization, undefined)
})

function adapterWith(options = {}) {
  const store = options.store || {
    getIdentity: () => options.saved || null,
    saveCanonicalIdentity: () => {},
  }
  const adapter = new GcAdapter({
    config: { apiUrl: 'https://gc.invalid', agentJwt: options.token || '', discoveryIntervalSec: 30 },
    runtimeContext: { feature_version: '8.1', operation_version: 'gc-v8-strategy-r2' },
    dataCollector: { store },
    eventBus: { emit() {} },
    agentVersion: '2.5.1',
    authClient: options.authClient || {
      issue: async ({ agentId }) => {
        const issuedId = agentId || AGENT_ID
        return {
          service: 'gc', agentId: issuedId, agentName: options.saved?.name || 'canonical-agent',
          agentToken: makeJwt(issuedId), expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }
      },
    },
  })
  adapter._checkServerContract = async () => {}
  return adapter
}

test('runtime obtains a UUID when absent and preserves a legacy local UUID', async () => {
  const missing = adapterWith()
  missing.api = {
    setToken() {},
    register: async () => ({
      agent_id: AGENT_ID, name: 'canonical-agent', identity_source: 'ai_rewards_jwt',
    }),
    getEquipment: async () => { throw new Error('not needed') },
  }
  await missing.initialize()
  assert.equal(missing.authState, GcAdapter.AUTH_STATES.ACTIVE)
  assert.equal(missing.agentId, AGENT_ID)

  let resumedId = null
  const legacy = adapterWith({
    token: 'cr_agent_legacy-credential',
    saved: { agent_id: AGENT_ID, api_token: 'cr_agent_legacy-credential', name: 'existing' },
    authClient: {
      issue: async ({ agentId, agentToken }) => {
        resumedId = agentId
        assert.equal(agentToken, 'cr_agent_legacy-credential')
        return {
          service: 'gc', agentId, agentName: 'existing', agentToken: makeJwt(agentId),
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }
      },
    },
  })
  legacy.api = {
    setToken() {},
    register: async () => ({ agent_id: AGENT_ID, name: 'existing', identity_source: 'ai_rewards_jwt' }),
    getEquipment: async () => { throw new Error('not needed') },
  }
  await legacy.initialize()
  assert.equal(resumedId, AGENT_ID)
  assert.equal(legacy.authState, GcAdapter.AUTH_STATES.ACTIVE)
})

test('runtime accepts the same canonical UUID and persists credential metadata', async () => {
  const jwt = makeJwt()
  let saved = null
  const adapter = adapterWith({
    token: jwt,
    saved: { agent_id: AGENT_ID, api_token: jwt, name: 'canonical-agent' },
    store: {
      getIdentity: () => ({ agent_id: AGENT_ID, api_token: jwt, name: 'canonical-agent' }),
      saveCanonicalIdentity: value => { saved = value },
    },
  })
  adapter.api = {
    setToken(token) { assert.equal(token, jwt) },
    getAgentMe: async () => ({ id: AGENT_ID, name: 'canonical-agent' }),
    getEquipment: async () => { throw new Error('not needed') },
  }

  await adapter.initialize()
  assert.equal(adapter.authState, GcAdapter.AUTH_STATES.ACTIVE)
  assert.equal(adapter.agentId, AGENT_ID)
  assert.equal(saved.agentId, AGENT_ID)
  assert.equal(saved.gcAgentId, AGENT_ID)
})

test('expired JWT is reissued automatically for the same local UUID', async () => {
  const expired = makeJwt(AGENT_ID, { exp: Math.floor(Date.now() / 1000) - 5 })
  const adapter = adapterWith({
    token: expired,
    saved: { agent_id: AGENT_ID, api_token: expired, name: 'canonical-agent' },
  })
  let registered = false
  adapter.api = {
    setToken() {},
    register: async () => {
      registered = true
      return { agent_id: AGENT_ID, name: 'canonical-agent', identity_source: 'ai_rewards_jwt' }
    },
    getEquipment: async () => { throw new Error('not needed') },
  }

  await adapter.initialize()
  assert.equal(adapter.authState, GcAdapter.AUTH_STATES.ACTIVE)
  assert.equal(adapter.agentId, AGENT_ID)
  assert.equal(registered, true)
})

test('manager propagates a fail-closed adapter initialization error', async () => {
  const manager = new AgentManager({ discoveryIntervalSec: 30 })
  manager.registerAdapter({
    gameName: 'claw-clash',
    initialize: async () => { throw new Error('AUTH_BOOTSTRAP_FAILED') },
  })
  await assert.rejects(manager.start(), /AUTH_BOOTSTRAP_FAILED/)
})
