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
import type { WorkerInfo } from '../core/cdp-client.js'
import { executeOp } from '../core/ops.js'
import { snapshot } from '../core/snapshot.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface HttpServerOptions {
  port?: number           // default 3099
  host?: string           // default 127.0.0.1
  token?: string          // single token (rw) or 'tok1:rw,tok2:ro' for multi
  workerSessions?: Map<string, { info: WorkerInfo, session: DebuggerSession }>
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

  // Parse token config: single token = rw, or 'tok1:rw,tok2:ro'
  const tokenMap = parseTokens(opts.token)

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

  // Wire trace hits to SSE
  session.onTraceHit = (entry) => pushSSE('trace', entry)

  const server = http.createServer(async (req, res) => {
    // CORS — open for localhost dev tooling
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

    // Auth check
    if (tokenMap) {
      const auth = req.headers.authorization
      const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : ''
      const perm = tokenMap.get(bearer)
      if (!perm) {
        res.setHeader('Content-Type', 'application/json')
        return respond(res, 401, { error: 'Unauthorized — Bearer token required' })
      }
      // Store permission for later use
      ;(req as any)._perm = perm
    } else {
      ;(req as any)._perm = 'rw'
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
        if (url.pathname === '/workers') {
          const workers = opts.workerSessions || new Map()
          const list = Array.from(workers.entries()).map(([id, { info }]) => ({
            sessionId: id,
            title: info.title,
            url: info.url,
          }))
          return respond(res, 200, { workers: list, count: list.length })
        }
        if (url.pathname === '/health') {
          return respond(res, 200, {
            ok: true,
            connected: !session.cdp.closed,
            status: session.currentPause ? 'paused' : 'running',
          })
        }

        // SSE — Server-Sent Events stream
        if (url.pathname === '/traces') {
          return respond(res, 200, {
            tracing: session.tracing,
            count: session.traceBuffer.length,
            hits: session.traceBuffer,
          })
        }

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
        if ((req as any)._perm === 'ro' && !isReadOnlyOp(body.op)) {
          return respond(res, 403, { error: `Forbidden — '${body.op}' requires rw token` })
        }
        // Route to worker session if specified
        let targetSession = session
        if (body.worker && opts.workerSessions) {
          const ws = opts.workerSessions.get(body.worker)
          if (!ws) return respond(res, 404, { error: `worker '${body.worker}' not found` })
          targetSession = ws.session
        }
        opts.pairChannel?.emit('agent-action', body)
        let result = await executeOp(targetSession, body.op, body)
        opts.pairChannel?.emit('agent-result', { op: body.op, result })

        // Inject worker data (executeOp doesn't have workerSessions context)
        if (body.op === 'workers' && result._needs_context && opts.workerSessions) {
          const workers = Array.from(opts.workerSessions.entries()).map(([id, { info }]) => ({
            sessionId: id, title: info.title, url: info.url,
          }))
          result = { workers, count: workers.length }
        }

        // wait: true → block until next pause (for continue/step ops)
        const WAIT_OPS = new Set(['continue', 'step_over', 'step_into', 'step_out'])
        if (body.wait && WAIT_OPS.has(body.op) && result.status === 'running') {
          const outcome = await Promise.race([
            targetSession.waitNextPause().then(() => 'paused' as const),
            new Promise<'timeout'>(r => setTimeout(() => r('timeout'), 30_000)),
          ])
          if (outcome === 'paused') {
            return respond(res, 200, await snapshot(targetSession))
          }
          return respond(res, 200, { status: 'running', wait_timeout: true })
        }

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

// ── Auth helpers ──

const READ_ONLY_OPS = new Set([
  'state', 'eval', 'locals', 'backtrace', 'source',
  'breakpoints', 'trace_status',
])

function isReadOnlyOp(op: string): boolean {
  return READ_ONLY_OPS.has(op)
}

function parseTokens(raw?: string): Map<string, 'rw' | 'ro'> | null {
  if (!raw) return null
  const map = new Map<string, 'rw' | 'ro'>()

  // Check if it's multi-token format: "tok1:rw,tok2:ro"
  if (raw.includes(':')) {
    for (const part of raw.split(',')) {
      const [tok, perm] = part.trim().split(':')
      if (tok && (perm === 'rw' || perm === 'ro')) {
        map.set(tok, perm)
      }
    }
    if (map.size > 0) return map
  }

  // Single token = full rw access
  map.set(raw, 'rw')
  return map
}
