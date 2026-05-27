/**
 * Express API server with mypry inline triggers.
 *
 * Run:    node examples/fullstack/server/index.js
 * Attach: mypry attach --port 9235
 *
 * Hit endpoints and watch the debugger pause on each pry():
 *   curl http://localhost:3456/api/users
 *   curl http://localhost:3456/api/users/1
 *   curl -X POST http://localhost:3456/api/orders -H 'Content-Type: application/json' -d '{"userId":1,"items":["A","B"]}'
 */

import express from 'express'
import cors from 'cors'
import { pry } from 'mypry'

const app = express()
app.use(cors())
app.use(express.json())

// ── Fake data ───

const users = [
  { id: 1, name: 'Alice', email: 'alice@example.com', role: 'admin' },
  { id: 2, name: 'Bob', email: 'bob@example.com', role: 'user' },
  { id: 3, name: 'Charlie', email: 'charlie@example.com', role: 'user' },
]

const orders = []
let nextOrderId = 1

// ── Routes ───

app.get('/api/users', (req, res) => {
  const search = req.query.search?.toString().toLowerCase()
  let result = users

  if (search) {
    result = users.filter(u =>
      u.name.toLowerCase().includes(search) ||
      u.email.toLowerCase().includes(search)
    )
  }

  // 🔮 Inspect the filtered results before responding
  pry({ port: 9235, message: 'GET /api/users — inspect result, search' })

  res.json({ users: result, count: result.length })
})

app.get('/api/users/:id', (req, res) => {
  const id = parseInt(req.params.id)
  const user = users.find(u => u.id === id)

  // 🔮 Inspect whether user was found
  pry({ port: 9235, message: `GET /api/users/${id} — inspect user` })

  if (!user) return res.status(404).json({ error: 'user not found' })
  res.json(user)
})

app.post('/api/orders', (req, res) => {
  const { userId, items } = req.body
  const user = users.find(u => u.id === userId)

  if (!user) return res.status(400).json({ error: 'invalid userId' })

  const order = {
    id: nextOrderId++,
    userId,
    user: user.name,
    items: items || [],
    total: (items || []).length * 9.99,
    status: 'pending',
    createdAt: new Date().toISOString(),
  }
  orders.push(order)

  // 🔮 Inspect the order before responding
  pry({ port: 9235, message: `POST /api/orders — inspect order, user, items` })

  res.status(201).json(order)
})

app.get('/api/orders', (req, res) => {
  res.json({ orders, count: orders.length })
})

app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), users: users.length, orders: orders.length })
})

// ── Browser pry() proxy ───
// The frontend pry() POSTs here with its state.
// This handler calls the real pry() which blocks the server until mypry continues.
// The agent sees the frontend data as local variables.

app.post('/__pry__', (req, res) => {
  const { message, data, source } = req.body
  const browserState = data    // 🔮 agent can inspect this
  const browserSource = source // 🔮 where pry() was called in the frontend

  pry({ port: 9235, message: `[browser] ${message || 'frontend pry()'}` })

  res.json({ ok: true })
})

const PORT = 3456
app.listen(PORT, () => {
  console.log()
  console.log('  🔮 mypry fullstack example — Express API')
  console.log(`  Server:  http://localhost:${PORT}`)
  console.log()
  console.log('  Endpoints:')
  console.log(`    GET  /api/users          → list users`)
  console.log(`    GET  /api/users/:id      → get user`)
  console.log(`    POST /api/orders         → create order`)
  console.log(`    GET  /api/orders         → list orders`)
  console.log(`    GET  /api/health         → health check`)
  console.log()
  console.log('  Attach debugger:')
  console.log(`    mypry attach --port 9235             → human REPL`)
  console.log(`    mypry attach --port 9235 --json      → agent mode`)
  console.log(`    mypry attach --port 9235 --mcp       → MCP for Claude Code`)
  console.log()
})
