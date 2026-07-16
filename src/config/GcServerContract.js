const GC_PROTOCOL_VERSION = '1'

function createClientContract(agentVersion, featureVersion) {
  return Object.freeze({
    protocol_version: GC_PROTOCOL_VERSION,
    agent_version: String(agentVersion || '0.0.0'),
    feature_version: String(featureVersion || 'unknown'),
  })
}

function buildAgentHeaders(contract) {
  return {
    'X-GC-Protocol-Version': contract.protocol_version,
    'X-AI-Agent-Version': contract.agent_version,
  }
}

function evaluateServerContract(server, client) {
  if (!server || typeof server !== 'object') throw new Error('Invalid GC agent contract response')
  const enforcement = server.enforcement || 'observe'
  const problems = []

  if (String(server.protocol_version) !== client.protocol_version) {
    problems.push(`protocol=${client.protocol_version}, required=${server.protocol_version}`)
  }

  const accepted = Array.isArray(server.accepted_feature_versions)
    ? server.accepted_feature_versions.map(String)
    : []
  if (accepted.length > 0 && !accepted.includes(client.feature_version)) {
    problems.push(`feature=${client.feature_version}, accepted=${accepted.join(',')}`)
  }

  if (server.required_feature_version && String(server.required_feature_version) !== client.feature_version) {
    problems.push(`feature=${client.feature_version}, required=${server.required_feature_version}`)
  }

  if (server.minimum_agent_version && !isVersionAtLeast(client.agent_version, server.minimum_agent_version)) {
    problems.push(`agent=${client.agent_version}, minimum=${server.minimum_agent_version}`)
  }

  if (enforcement === 'strict' && problems.length > 0) {
    throw new Error(`GC strict contract rejected this agent: ${problems.join('; ')}`)
  }

  return {
    enforcement,
    compatible: problems.length === 0,
    warnings: problems,
  }
}

function isVersionAtLeast(actual, minimum) {
  const left = parseSemVer(actual)
  const right = parseSemVer(minimum)
  if (!left || !right) return false
  for (let i = 0; i < 3; i++) {
    const diff = left.core[i] - right.core[i]
    if (diff !== 0) return diff > 0
  }
  return comparePrerelease(left.prerelease, right.prerelease) >= 0
}

function parseSemVer(value) {
  const match = String(value || '').match(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
  )
  if (!match) return null
  return {
    core: match.slice(1, 4).map(Number),
    prerelease: match[4] ? match[4].split('.') : [],
  }
}

function comparePrerelease(left, right) {
  if (left.length === 0 || right.length === 0) {
    if (left.length === right.length) return 0
    return left.length === 0 ? 1 : -1
  }
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] === undefined) return -1
    if (right[i] === undefined) return 1
    if (left[i] === right[i]) continue
    const leftNumeric = /^\d+$/.test(left[i])
    const rightNumeric = /^\d+$/.test(right[i])
    if (leftNumeric && rightNumeric) return Number(left[i]) > Number(right[i]) ? 1 : -1
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return left[i] > right[i] ? 1 : -1
  }
  return 0
}

module.exports = {
  GC_PROTOCOL_VERSION,
  buildAgentHeaders,
  createClientContract,
  evaluateServerContract,
  isVersionAtLeast,
  parseSemVer,
}
