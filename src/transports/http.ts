/**
 * HTTP transport — REST API for agents and embedders.
 *
 * Side transport: runs alongside REPL, ndjson, or MCP.
 * Invocation: mypry attach --http[=PORT]
 *
 * API:
 *   POST /command  { op, ...params }  → same JSON shapes as ndjson
 *   POST /batch    { ops: [...] }     → execute multiple ops, return all results
 *   GET  /state                       → current debugger state
 *   GET  /backtrace                   → call stack
 *   GET  /breakpoints                 → active breakpoints
 *   GET  /health                      → { ok, connected, status }
 *   GET  /events                      → SSE stream (paused, resumed, disconnected)
 *
 * Auth (optional):
 *   Pass token via HttpServerOptions. When set, all requests must include
 *   Authorization: Bearer <token> header. SSE and OPTIONS are also gated.
 */

import http from 'node:http'
import { EventEmitter } from 'node:events'
import type { DebuggerSession } from '../core/session.js'
import { executeOp } from '../core/ops.js'
import { snapshot } from '../core/snapshot.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface HttpServerOptions {
  port?: number           // default 3099
  host?: string           // default 127.0.0.1
  token?: string          // optional bearer token for auth
  pairChannel?: EventEmitter
}

export interface HttpServer {
  port: number
  close: () => Promise<void>
}

export async function startHttpServer(
  session: DebuggerSession,
  opts: HttpServerOptions = {}
): Promise<HttpServer> {
  const port = opts.port ?? 3099
  const host = opts.host ?? '127.0.0.1'
  const token = opts.token

  // Track SSE clients for event streaming
  const sseClients = new Set<http.ServerResponse>()

  // Wire up debugger events → SSE
  function pushSSE(event: string, data: any) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const client of sseClients) {
      try { client.write(payload) } catch { sseClients.delete(client) }
    }
  }

  session.cdp.on('Debugger.paused', async () => {
    // Small delay to let session.currentPause get set
    await new Promise(r => setTimeout(r, 50))
    pushSSE('paused', await snapshot(session))
  })
  session.cdp.on('Debugger.resumed', () => {
    pushSSE('resumed', { status: 'running' })
  })
  session.cdp.onClose(() => {
    pushSSE('disconnected', { status: 'disconnected' })
    // Close all SSE connections on disconnect
    for (const client of sseClients) {
      try { client.end() } catch {}
    }
    sseClients.clear()
  })

  const server = http.createServer(async (req, res) => {
    // CORS — open for localhost dev tooling
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

    // Auth check
    if (token) {
      const auth = req.headers.authorization
      if (!auth || auth !== `Bearer ${token}`) {
        res.setHeader('Content-Type', 'application/json')
        return respond(res, 401, { error: 'Unauthorized — Bearer token required' })
      }
    }

    res.setHeader('Content-Type', 'application/json')

    try {
      const url = new URL(req.url || '/', `http://${host}:${port}`)

      // GET endpoints
      if (req.method === 'GET') {
        if (url.pathname === '/state') {
          return respond(res, 200, await executeOp(session, 'state'))
        }
        if (url.pathname === '/backtrace') {
          return respond(res, 200, await executeOp(session, 'backtrace'))
        }
        if (url.pathname === '/breakpoints') {
          return respond(res, 200, await executeOp(session, 'breakpoints'))
        }
        if (url.pathname === '/health') {
          return respond(res, 200, {
            ok: true,
            connected: !session.cdp.closed,
            status: session.currentPause ? 'paused' : 'running',
          })
        }

        // SSE — Server-Sent Events stream
        if (url.pathname === '/events') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          })
          // Send current state as first event
          const currentState = session.currentPause ? 'paused' : 'running'
          const initData = currentState === 'paused'
            ? await snapshot(session)
            : { status: 'running' }
          res.write(`event: ${currentState}\ndata: ${JSON.stringify(initData)}\n\n`)
          sseClients.add(res)
          req.on('close', () => sseClients.delete(res))
          return // keep connection open
        }

        return respond(res, 404, { error: 'not found' })
      }

      // POST /command
      if (req.method === 'POST' && url.pathname === '/command') {
        const body = await readBody(req)
        if (!body.op) {
          return respond(res, 400, { error: 'missing "op" field' })
        }
        opts.pairChannel?.emit('agent-action', body)
        const result = await executeOp(session, body.op, body)
        opts.pairChannel?.emit('agent-result', { op: body.op, result })
        return respond(res, 200, result)
      }

      // POST /batch — execute multiple ops in sequence
      if (req.method === 'POST' && url.pathname === '/batch') {
        const body = await readBody(req)
        if (!Array.isArray(body.ops)) {
          return respond(res, 400, { error: 'missing "ops" array' })
        }
        const results: any[] = []
        for (const op of body.ops) {
          if (!op.op) {
            results.push({ error: 'missing "op" field' })
            continue
          }
          try {
            opts.pairChannel?.emit('agent-action', op)
            const result = await executeOp(session, op.op, op)
            opts.pairChannel?.emit('agent-result', { op: op.op, result })
            results.push(result)
          } catch (err: any) {
            results.push({ error: err.message })
          }
        }
        return respond(res, 200, { results })
      }

      respond(res, 404, { error: 'not found' })
    } catch (err: any) {
      respond(res, 500, { error: err.message })
    }
  })

  await new Promise<void>(r => server.listen(port, host, r))

  return {
    port,
    close: () => new Promise(r => server.close(() => r())),
  }
}

function respond(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code)
  res.end(JSON.stringify(body))
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) return resolve({})
      try { resolve(JSON.parse(text)) } catch { reject(new Error('invalid JSON')) }
    })
    req.on('error', reject)
  })
}
