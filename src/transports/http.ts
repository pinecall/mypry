/**
 * HTTP transport — REST API for agents and embedders.
 *
 * Side transport: runs alongside REPL, ndjson, or MCP.
 * Invocation: mypry attach --http[=PORT]
 *
 * API:
 *   POST /command  { op, ...params }  → same JSON shapes as ndjson
 *   GET  /state                       → current debugger state
 *   GET  /backtrace                   → call stack
 *   GET  /breakpoints                 → active breakpoints
 *   GET  /health                      → { ok, connected, status }
 */

import http from 'node:http'
import { EventEmitter } from 'node:events'
import type { DebuggerSession } from '../core/session.js'
import { executeOp } from '../core/ops.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface HttpServerOptions {
  port?: number           // default 3099
  host?: string           // default 127.0.0.1
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

  const server = http.createServer(async (req, res) => {
    // CORS — open for localhost dev tooling
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    res.setHeader('Content-Type', 'application/json')

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

    try {
      const url = new URL(req.url || '/', `http://${host}:${port}`)

      // GET shortcuts
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
