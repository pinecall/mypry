'use strict'
/**
 * mypry Feature Showcase — complete example for the tutorial.
 *
 * A tiny HTTP API that demonstrates every mypry feature:
 *   1. Conditional breakpoints
 *   2. Trace mode (non-blocking observation)
 *   3. Granular auth (ro/rw tokens)
 *   4. Worker threads
 *   5. Inject PID (shown separately)
 *
 * Usage:
 *   node --inspect=9231 examples/tutorial-server.cjs
 *
 * Then in another terminal:
 *   mypry attach --http-only --port 9231 --workers \
 *     --token "admin:rw,viewer:ro"
 */

const http = require('http')
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads')

// ─── Worker: long-running background processor ───
if (!isMainThread) {
  const { name } = workerData
  console.log(`[worker:${name}] started`)

  let tickCount = 0
  setInterval(() => {
    tickCount++
    const memMB = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)
    debugger  // ← worker breakpoint: inspect worker health
    parentPort.postMessage({ name, tickCount, memMB })
  }, 3000)

  return  // keep alive via setInterval
}

// ─── Main thread: HTTP API ───

const users = [
  { id: 1, name: 'Alice', email: 'alice@example.com', role: 'user' },
  { id: 2, name: 'Bob',   email: 'bob@example.com',   role: 'user' },
  { id: 3, name: 'Admin', email: 'admin@example.com', role: 'admin' },
  { id: 4, name: 'Diana', email: 'diana@example.com', role: 'user' },
  { id: 5, name: 'Eve',   email: 'eve@example.com',   role: 'moderator' },
]

let requestCount = 0
const activeWorkers = new Map()

function authenticate(email, password) {
  requestCount++
  const user = users.find(u => u.email === email)
  const isValid = user && password === 'secret'

  debugger  // ← auth breakpoint: inspect login attempts

  return isValid ? user : null
}

function getUser(id) {
  requestCount++
  const user = users.find(u => u.id === parseInt(id))
  return user || null
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  res.setHeader('Content-Type', 'application/json')

  // POST /login — authenticate a user
  if (req.method === 'POST' && url.pathname === '/login') {
    const body = await readBody(req)
    const user = authenticate(body.email, body.password)
    if (user) {
      res.end(JSON.stringify({ ok: true, user }))
    } else {
      res.writeHead(401)
      res.end(JSON.stringify({ ok: false, error: 'invalid credentials' }))
    }
    return
  }

  // GET /user/:id — get user by ID
  if (req.method === 'GET' && url.pathname.startsWith('/user/')) {
    const id = url.pathname.split('/')[2]
    const user = getUser(id)
    if (user) {
      res.end(JSON.stringify(user))
    } else {
      res.writeHead(404)
      res.end(JSON.stringify({ error: 'not found' }))
    }
    return
  }

  // GET /stats
  if (url.pathname === '/stats') {
    const workers = Array.from(activeWorkers.keys())
    res.end(JSON.stringify({ requestCount, workers, userCount: users.length }))
    return
  }

  res.writeHead(404)
  res.end(JSON.stringify({ error: 'not found' }))
})

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString()
      try { resolve(JSON.parse(text)) } catch { resolve({}) }
    })
  })
}

// Spawn a long-lived worker at startup
function spawnWorker(name) {
  const worker = new Worker(__filename, { workerData: { name } })
  worker.on('message', (msg) => {
    activeWorkers.set(name, msg)
  })
  worker.on('exit', () => {
    activeWorkers.delete(name)
    console.log(`[main] worker:${name} exited`)
  })
  return worker
}

const PORT = 4444
server.listen(PORT, () => {
  // Spawn background workers
  spawnWorker('metrics')
  spawnWorker('health-check')

  console.log(``)
  console.log(`  ┌───────────────────────────────────────┐`)
  console.log(`  │  mypry Tutorial Server                │`)
  console.log(`  │  http://localhost:${PORT}                 │`)
  console.log(`  │                                       │`)
  console.log(`  │  Endpoints:                           │`)
  console.log(`  │    POST /login   {email, password}    │`)
  console.log(`  │    GET  /user/:id                     │`)
  console.log(`  │    GET  /stats                        │`)
  console.log(`  │                                       │`)
  console.log(`  │  Workers: metrics, health-check       │`)
  console.log(`  │  PID: ${process.pid}                          │`)
  console.log(`  └───────────────────────────────────────┘`)
  console.log(``)
})
