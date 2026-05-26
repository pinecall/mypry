'use strict'

const inspector = require('node:inspector')

/**
 * Pause execution until a `mypry attach` client connects.
 * Each call closes any stale inspector and re-opens with wait=true,
 * ensuring it always blocks — even on subsequent calls.
 *
 *   const pry = require('mypry')
 *   pry()                                  // default: 0.0.0.0:9229
 *   pry({ port: 9230, host: '127.0.0.1' })
 *   pry({ message: 'after fetching user' })
 */
function pry(opts = {}) {
  const { port = 9229, host = '0.0.0.0', message } = opts

  // Always close + re-open so we block waiting for a fresh client every time
  if (inspector.url()) {
    try { inspector.close() } catch {}
  }

  process.stderr.write(
    `[mypry] inspector listening on ${host}:${port}\n` +
    `[mypry] waiting for client...\n`
  )
  // 3rd arg = wait for client to connect before returning.
  inspector.open(port, host, true)
  process.stderr.write('[mypry] client connected\n')

  if (message) process.stderr.write(`[mypry] ${message}\n`)

  // V8 honors `debugger` only while a client is attached → pause now.
  // eslint-disable-next-line no-debugger
  debugger
  // NOTE: inspector stays open after continue — next pry() call will close + reopen it
}

module.exports = pry
module.exports.pry = pry
module.exports.brk = pry
