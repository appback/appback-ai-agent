const { createLogger } = require('./logger')
const log = createLogger('retry')

async function retry(fn, { maxAttempts = 3, delayMs = 1000, backoff = 2 } = {}) {
  let lastErr
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (i < maxAttempts) {
        const wait = delayMs * Math.pow(backoff, i - 1)
        log.warn(`Attempt ${i}/${maxAttempts} failed, retrying in ${wait}ms`, err.message)
        await new Promise(r => setTimeout(r, wait))
      }
    }
  }
  throw lastErr
}

module.exports = { retry }
