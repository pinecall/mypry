'use strict'
/**
 * A tiny fullstack app with a planted bug, for demoing mypry end-to-end.
 *
 *   Symptom: a valid admin login returns 403 "admins only".
 *   Cause:   sanitizeUser() drops the `role` field, so user.role is undefined.
 *
 * Run it with NO inspector flag — mypry injects one:
 *   node examples/login-bug/server.cjs        # listens on :3060
 * Then, from your agent:
 *   debugger_inject { appPort: 3060, frontend: "http://127.0.0.1:3060" }
 */
const http = require('http')

// Pretend user store. Alice is an admin.
const USERS = {
  'alice@corp.com': { id: 1, email: 'alice@corp.com', password: 'hunter2', role: 'admin' },
}

// BUG: this helper forgets to carry over `role`, so the admin check below
// always fails for everyone — even real admins.
function sanitizeUser(u) {
  return { id: u.id, email: u.email }
}

const PAGE = `<!doctype html><html><head><title>Acme Admin</title></head><body>
  <h1>Admin sign in</h1>
  <input id="email" type="email" aria-label="Email" placeholder="Email">
  <input id="password" type="password" aria-label="Password" placeholder="Password">
  <button id="go">Sign in</button>
  <p id="result"></p>
  <script>
    document.getElementById('go').onclick = async () => {
      const res = await fetch('/api/login', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: document.getElementById('email').value,
          password: document.getElementById('password').value,
        }),
      })
      document.getElementById('result').textContent = res.status + ' — ' + (await res.text())
    }
  </script>
</body></html>`

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(PAGE)
    return
  }
  if (req.method === 'POST' && req.url === '/api/login') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const { email, password } = JSON.parse(body || '{}')
      const dbUser = USERS[email]
      if (!dbUser || dbUser.password !== password) {
        res.writeHead(401); res.end('bad credentials'); return
      }
      const user = sanitizeUser(dbUser)
      if (user.role !== 'admin') {            // ← line 62: the admin gate that wrongly rejects
        res.writeHead(403); res.end('forbidden: admins only'); return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, token: 'admin-session-xyz' }))
    })
    return
  }
  res.writeHead(404); res.end('not found')
})

server.listen(parseInt(process.env.PORT || '3060', 10), () => {
  process.stdout.write('LISTENING ' + (process.env.PORT || '3060') + '\n')
})
