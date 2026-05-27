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

  if (message) process.stderr.write(`[mypry] ${message}\n`)

  // If inspector is already open (client still attached), just pause — don't reconnect.
  if (inspector.url()) {
    debugger
    return
  }

  // No inspector open — open one and wait for a client to connect.
  process.stderr.write(
    `[mypry] inspector listening on ${host}:${port}\n` +
    `[mypry] waiting for client...\n`
  )
  inspector.open(port, host, true)
  process.stderr.write('[mypry] client connected\n')

  // V8 honors `debugger` only while a client is attached → pause now.
  // eslint-disable-next-line no-debugger
  debugger
}

module.exports = pry
module.exports.pry = pry
module.exports.brk = pry
