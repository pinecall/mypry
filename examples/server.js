'use strict'

// Simulates a server handling requests — no pry() calls.
// Use with: node --inspect examples/server.js

const http = require('node:http')

function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const name = url.searchParams.get('name') || 'World'
  const greeting = `Hello, ${name}!`
  const timestamp = new Date().toISOString()

  console.log(`[${timestamp}] ${req.method} ${req.url} → ${greeting}`)

  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ greeting, timestamp }))
}

const server = http.createServer(handleRequest)
server.listen(3456, () => {
  console.log('Server listening on http://localhost:3456')
  console.log('Try: curl "http://localhost:3456/?name=mypry"')
})
