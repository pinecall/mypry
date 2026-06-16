'use strict'
/**
 * Plain Node http server fixture — gives a real IncomingMessage/ServerResponse
 * and a realistic handler scope (secrets, deep nesting, big string, long array)
 * for end-to-end serializer tests. No external dependencies.
 *
 * Started WITHOUT --inspect by the test; the test injects or attaches.
 */
const http = require('http')

const server = http.createServer((req, res) => {
  // Realistic handler locals an agent would want to inspect.
  const submission = {
    email: 'alice@example.com',
    password: 'hunter2',                 // must be redacted
    vdfProof: {
      token: 'secret-token-abcdef',      // must be redacted (key)
      steps: Array.from({ length: 200 }, (_, i) => i), // must be array-capped
    },
    nested: { a: { b: { c: { d: { e: 'too deep' } } } } }, // must depth-cap
  }
  const bigString = 'x'.repeat(5000)     // must be string-capped
  // eslint-disable-next-line no-debugger
  debugger                               // ← pause here; req/res/submission in scope
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, email: submission.email, big: bigString.length }))
})

const PORT = parseInt(process.env.PORT || '3097', 10)
server.listen(PORT, () => { process.stdout.write('LISTENING ' + PORT + '\n') })
