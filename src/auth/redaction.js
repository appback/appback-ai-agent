const SENSITIVE_KEY = /^(authorization|registration[_-]?code|agent[_-]?token|api[_-]?token|jwt|token)$/i
const REGISTRATION_CODE = /\bARW-[A-Z0-9]{4}-[A-Z0-9]{4}\b/gi
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~-]+/gi
const JWT_TOKEN = /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g

function redactString(value) {
  return String(value)
    .replace(REGISTRATION_CODE, '[REDACTED_CODE]')
    .replace(BEARER_TOKEN, 'Bearer [REDACTED]')
    .replace(JWT_TOKEN, '[REDACTED_JWT]')
}

function redactSensitive(value, seen = new WeakSet()) {
  if (typeof value === 'string') return redactString(value)
  if (!value || typeof value !== 'object') return value
  if (seen.has(value)) return '[Circular]'
  seen.add(value)

  if (Array.isArray(value)) return value.map(item => redactSensitive(item, seen))

  const output = {}
  for (const [key, item] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactSensitive(item, seen)
  }
  return output
}

module.exports = { redactSensitive, redactString }
