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
const { registerCanonicalAgent } = require('../src/auth/registerCanonicalAgent')
const GcApiClient = require('../src/adapters/gc/GcApiClient')
const GcAdapter = require('../src/adapters/gc/GcAdapter')
const SqliteStore = require('../src/data/storage/SqliteStore')
const AgentManager = require('../src/core/AgentManager')
const { runRegisterCommand } = require('../bin/commands/register')

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

test('AI Rewards exchange validates the canonical GC UUID/JWT response', async () => {
  const jwt = makeJwt()
  const client = new AiRewardsAgentAuthClient({
    client: { post: async () => ({ data: makeExchange(jwt) }) },
  })

  const result = await client.exchange({
    registrationCode: 'ARW-1234-ABCD',
    agentName: 'canonical-agent',
  })

  assert.equal(result.agentId, AGENT_ID)
  assert.equal(result.service, 'gc')
  assert.equal(result.agentToken, jwt)
  assert.equal(validateAgentJwt(jwt).agentId, AGENT_ID)
})

test('AI Rewards exchange rejects another service and non-JWT credentials', async () => {
  const wrongService = new AiRewardsAgentAuthClient({
    client: { post: async () => ({ data: makeExchange(makeJwt(), { service: 'tc' }) }) },
  })
  await assert.rejects(
    wrongService.exchange({ registrationCode: 'ARW-1234-ABCD', agentName: 'agent' }),
    error => error.code === 'INVALID_EXCHANGE_SERVICE'
  )

  const legacyToken = new AiRewardsAgentAuthClient({
    client: { post: async () => ({ data: makeExchange('legacy-agent-token') }) },
  })
  await assert.rejects(
    legacyToken.exchange({ registrationCode: 'ARW-1234-ABCD', agentName: 'agent' }),
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

test('registration flow saves only after AI Rewards and GC return the same UUID', async () => {
  const dir = tempDir('agent-auth-register-')
  const store = new SqliteStore(dir)
  const jwt = makeJwt()
  const authClient = { exchange: async () => ({
    service: 'gc', agentId: AGENT_ID, agentName: 'canonical-agent', agentToken: jwt,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  }) }
  const gcClient = {
    setToken(token) { assert.equal(token, jwt) },
    register: async () => ({
      agent_id: AGENT_ID,
      name: 'canonical-agent',
      identity_source: 'ai_rewards_jwt',
    }),
  }

  await registerCanonicalAgent({
    registrationCode: 'ARW-1234-ABCD',
    agentName: 'canonical-agent',
    authClient,
    gcClient,
    store,
  })
  assert.equal(store.getIdentity('claw-clash').agent_id, AGENT_ID)

  const mismatchedStore = new SqliteStore(tempDir('agent-auth-register-mismatch-'))
  await assert.rejects(registerCanonicalAgent({
    registrationCode: 'ARW-5678-EF01',
    agentName: 'canonical-agent',
    authClient,
    gcClient: {
      setToken() {},
      register: async () => ({
        agent_id: OTHER_AGENT_ID,
        name: 'other-agent',
        identity_source: 'ai_rewards_jwt',
      }),
    },
    store: mismatchedStore,
  }), error => error.code === 'GC_AGENT_ID_MISMATCH')
  assert.equal(mismatchedStore.getIdentity('claw-clash'), undefined)

  store.close()
  mismatchedStore.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('mock AI Rewards and GC integration exchanges, registers, and persists one identity', async t => {
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

  await registerCanonicalAgent({
    registrationCode: 'ARW-1234-ABCD',
    agentName: 'canonical-agent',
    authClient,
    gcClient,
    store,
  })

  assert.equal(seen[0].path, '/ai/agent-auth/exchange')
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

test('register CLI output never includes a registration code or JWT on failure', async () => {
  const jwt = makeJwt()
  const lines = []
  const store = { getIdentity: () => null }
  const code = await runRegisterCommand({
    registrationCode: 'ARW-1234-ABCD',
    cwd: process.cwd(),
    output: { log: line => lines.push(line), error: line => lines.push(line) },
    dependencies: {
      store,
      config: { aiRewardsApiUrl: 'https://rewards.invalid', apiUrl: 'https://gc.invalid' },
      authClient: {},
      gcClient: {},
      registerCanonicalAgent: async () => {
        throw new Error(`failed ARW-1234-ABCD Bearer ${jwt}`)
      },
    },
  })

  assert.equal(code, 1)
  assert.doesNotMatch(lines.join('\n'), /ARW-1234-ABCD|test-signature/)
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
    agentVersion: '2.5.0',
  })
  adapter._checkServerContract = async () => {}
  return adapter
}

test('runtime fails closed without a JWT and on stored UUID mismatch', async () => {
  const missing = adapterWith()
  await assert.rejects(missing.initialize(), /register <ARW-code>/)
  assert.equal(missing.authState, GcAdapter.AUTH_STATES.CODE_REQUIRED)

  const mismatch = adapterWith({
    token: makeJwt(OTHER_AGENT_ID),
    saved: { agent_id: AGENT_ID, api_token: makeJwt(), name: 'existing' },
  })
  await assert.rejects(mismatch.initialize(), /AGENT_IDENTITY_MISMATCH/)
  assert.equal(mismatch.authState, GcAdapter.AUTH_STATES.REAUTH_REQUIRED)
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

test('expired JWT transitions to REAUTH_REQUIRED and never reaches GC', async () => {
  const expired = makeJwt(AGENT_ID, { exp: Math.floor(Date.now() / 1000) - 5 })
  const adapter = adapterWith({
    token: expired,
    saved: { agent_id: AGENT_ID, api_token: expired, name: 'canonical-agent' },
  })
  let called = false
  adapter.api = { setToken() { called = true } }

  await assert.rejects(adapter.initialize(), /AGENT_JWT_EXPIRED/)
  assert.equal(adapter.authState, GcAdapter.AUTH_STATES.REAUTH_REQUIRED)
  assert.equal(called, false)
})

test('manager propagates a fail-closed adapter initialization error', async () => {
  const manager = new AgentManager({ discoveryIntervalSec: 30 })
  manager.registerAdapter({
    gameName: 'claw-clash',
    initialize: async () => { throw new Error('CODE_REQUIRED') },
  })
  await assert.rejects(manager.start(), /CODE_REQUIRED/)
})
