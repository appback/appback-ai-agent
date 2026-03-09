const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 }
const level = LEVELS[process.env.LOG_LEVEL || 'info'] || 1

function fmt(lvl, tag, msg, data) {
  const ts = new Date().toISOString()
  const base = `[${ts}] [${lvl.toUpperCase()}] [${tag}] ${msg}`
  if (data !== undefined) console.log(base, typeof data === 'object' ? JSON.stringify(data) : data)
  else console.log(base)
}

function createLogger(tag) {
  return {
    debug: (msg, data) => level <= 0 && fmt('debug', tag, msg, data),
    info: (msg, data) => level <= 1 && fmt('info', tag, msg, data),
    warn: (msg, data) => level <= 2 && fmt('warn', tag, msg, data),
    error: (msg, data) => level <= 3 && fmt('error', tag, msg, data),
  }
}

module.exports = { createLogger }
