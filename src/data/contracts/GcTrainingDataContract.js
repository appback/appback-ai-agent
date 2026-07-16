const ACTIONS = new Set(['stay', 'up', 'down', 'left', 'right'])
const EXECUTION_STATUSES = new Set([
  'applied',
  'blocked_dynamic',
  'invalid',
  'inference_failed',
  'timeout',
  'fallback',
])

function assertTrainingFrame(frame, expected = {}) {
  assertObject(frame, 'training frame')
  assertEqual(frame.record_version, 1, 'record_version')
  for (const field of ['frame_id', 'cursor', 'session_id', 'game_id']) assertString(frame[field], field)
  assertInteger(frame.tick, 'tick', 0)
  assertInteger(frame.decision_seq, 'decision_seq', 0)
  assertObject(frame.agent, 'agent')
  assertInteger(frame.agent.slot, 'agent.slot', 0)

  assertObject(frame.contract, 'contract')
  assertString(frame.contract.operation_version, 'contract.operation_version')
  assertString(frame.contract.feature_version, 'contract.feature_version')
  assertInteger(frame.contract.feature_dim, 'contract.feature_dim', 1)
  assertSha256(frame.contract.feature_schema_hash, 'contract.feature_schema_hash')
  assertString(frame.contract.training_version, 'contract.training_version')

  assertObject(frame.behavior_profile, 'behavior_profile')
  assertString(frame.behavior_profile.id, 'behavior_profile.id')
  assertSha256(frame.behavior_profile.hash, 'behavior_profile.hash')

  assertObject(frame.input, 'input')
  if (!Array.isArray(frame.input.feature_vector) || frame.input.feature_vector.length !== frame.contract.feature_dim) {
    throw new Error(`input.feature_vector must contain exactly ${frame.contract.feature_dim} values`)
  }
  for (const value of frame.input.feature_vector) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error('input.feature_vector contains a non-finite value')
    }
  }
  if (!Array.isArray(frame.input.action_mask) || frame.input.action_mask.length !== 5 ||
      frame.input.action_mask.some(value => value !== 0 && value !== 1 && value !== false && value !== true)) {
    throw new Error('input.action_mask must contain exactly five boolean/0/1 values')
  }

  assertObject(frame.inference, 'inference')
  assertString(frame.inference.status, 'inference.status')
  assertOptionalAction(frame.inference.raw_argmax_action, 'inference.raw_argmax_action')
  assertOptionalAction(frame.inference.model_action, 'inference.model_action')

  assertObject(frame.execution, 'execution')
  assertAction(frame.execution.executed_action, 'execution.executed_action')
  if (!EXECUTION_STATUSES.has(frame.execution.execution_status)) {
    throw new Error(`execution.execution_status is invalid: ${frame.execution.execution_status}`)
  }
  assertOptionalString(frame.execution.override_reason, 'execution.override_reason', true)

  assertExpected(frame.contract.operation_version, expected.operation_version, 'operation_version')
  assertExpected(frame.contract.feature_version, expected.feature_version, 'feature_version')
  assertExpected(frame.contract.feature_dim, expected.feature_dim, 'feature_dim')
  assertExpected(frame.contract.feature_schema_hash, expected.feature_schema_hash, 'feature_schema_hash')
  assertExpected(frame.contract.training_version, expected.training_version, 'training_version')
  assertExpected(frame.behavior_profile.hash, expected.behavior_profile_hash, 'behavior_profile_hash')

  return frame
}

function assertTrainingResult(result) {
  assertObject(result, 'training result')
  for (const field of ['result_id', 'cursor', 'session_id', 'game_id']) assertString(result[field], field)
  assertInteger(result.agent_slot, 'agent_slot', 0)
  assertInteger(result.rank, 'rank', 1)
  assertFiniteNumber(result.score, 'score')
  for (const field of ['kills', 'damage_dealt', 'damage_taken', 'survived_ticks']) {
    assertFiniteNumber(result[field], field)
  }
  if (typeof result.completed !== 'boolean') throw new Error('completed must be a boolean')
  assertString(result.finish_reason, 'finish_reason', true)
  return result
}

function assertTrainingSession(session, expectedSessionId = null) {
  assertObject(session, 'training session')
  assertString(session.session_id, 'session_id')
  assertString(session.game_id, 'game_id')
  if (expectedSessionId && session.session_id !== expectedSessionId) {
    throw new Error(`session_id mismatch: ${session.session_id}, expected=${expectedSessionId}`)
  }
  return session
}

function assertExpected(actual, expected, field) {
  if (expected !== undefined && expected !== null && actual !== expected) {
    throw new Error(`${field} mismatch: ${actual}, expected=${expected}`)
  }
}

function assertEqual(actual, expected, field) {
  if (actual !== expected) throw new Error(`${field} must be ${expected}`)
}

function assertObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object`)
}

function assertString(value, field, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) throw new Error(`${field} must be a string`)
}

function assertOptionalString(value, field, allowEmpty = false) {
  if (value !== null && value !== undefined) assertString(value, field, allowEmpty)
}

function assertInteger(value, field, minimum) {
  if (!Number.isInteger(value) || value < minimum) throw new Error(`${field} must be an integer >= ${minimum}`)
}

function assertFiniteNumber(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${field} must be finite`)
}

function assertSha256(value, field) {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${field} must be a lowercase sha256 digest`)
  }
}

function assertAction(value, field) {
  if (!ACTIONS.has(value)) throw new Error(`${field} is invalid: ${value}`)
}

function assertOptionalAction(value, field) {
  if (value !== null && value !== undefined) assertAction(value, field)
}

module.exports = {
  ACTIONS,
  EXECUTION_STATUSES,
  assertTrainingFrame,
  assertTrainingResult,
  assertTrainingSession,
}
