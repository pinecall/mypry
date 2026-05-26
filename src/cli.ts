/**
 * CLI entry point — parses args, connects to inspector, picks transport.
 *
 * Mechanical translation from mypry.js lines 536-604.
 * DO NOT change behavior — this is load-bearing.
 */

import { parseArgs } from 'node:util'
import { CDPClient } from './core/cdp-client.js'
import { DebuggerSession } from './core/session.js'
import { runRepl } from './transports/repl.js'
import { runNdjson } from './transports/ndjson.js'
import { runMcp } from './transports/mcp.js'
import { startHttpServer, type HttpServer } from './transports/http.js'

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      host: { type: 'string', default: '127.0.0.1' },
      port: { type: 'string', default: '9229' },
      url:  { type: 'string' },
      json: { type: 'boolean', default: false },
      mcp:  { type: 'boolean', default: false },
      http: { type: 'string' },
      'http-only': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  })

  if (values.help || positionals[0] === 'help') {
    process.stdout.write(
      `mypry attach [--host HOST] [--port PORT] [--url WS_URL] [--json|--mcp] [--http[=PORT]]\n\n` +
      `Stdio transports (pick one):\n` +
      `  (none)         human REPL (default)\n` +
      `  --json         ndjson stdio (for embedders like Aurora)\n` +
      `  --mcp          MCP server on stdio (for Claude Code, Cursor)\n\n` +
      `Side transport (combinable with any stdio mode):\n` +
      `  --http[=PORT]  HTTP server (default port 3099)\n` +
      `  --http-only    HTTP only, no stdio transport\n\n` +
      `Examples:\n` +
      `  mypry attach                       # human REPL\n` +
      `  mypry attach --json                # Aurora mode\n` +
      `  mypry attach --mcp                 # MCP for Claude Code\n` +
      `  mypry attach --http                # REPL + HTTP (pair programming)\n` +
      `  mypry attach --http-only           # headless HTTP daemon\n`
    )
    return
  }

  // Resolve WebSocket URL via /json discovery if not given
  let wsUrl = values.url
  if (!wsUrl) {
    // 0.0.0.0 is a bind address, not routable — use 127.0.0.1 to connect
    const connectHost = values.host === '0.0.0.0' ? '127.0.0.1' : values.host
    let res: Response
    try {
      res = await fetch(`http://${connectHost}:${values.port}/json`)
    } catch (e: any) {
      process.stderr.write(`cannot reach inspector at ${connectHost}:${values.port} — ${e.message}\n`)
      process.exit(1)
    }
    const list = await res.json() as { webSocketDebuggerUrl: string }[]
    if (!list.length) { process.stderr.write('no inspectable contexts\n'); process.exit(1) }
    wsUrl = list[0].webSocketDebuggerUrl
    // The inspector may advertise 0.0.0.0 in the ws URL — fix it
    if (wsUrl!.includes('0.0.0.0')) wsUrl = wsUrl!.replace('0.0.0.0', connectHost!)
  }

  const cdp = new CDPClient(wsUrl!)
  await cdp.connect()
  const session = new DebuggerSession(cdp)
  await session.init()

  // Unblock target if it was launched with --inspect-brk or wait=true.
  await cdp.send('Runtime.runIfWaitingForDebugger')

  // Give the target a moment to hit a pry()/debugger statement
  if (!session.currentPause) {
    await Promise.race([
      session._waitRawPause(),
      new Promise(r => setTimeout(r, 300)),
    ])
  }

  if (values.json && values.mcp) {
    process.stderr.write('error: --json and --mcp are mutually exclusive\n')
    process.exit(1)
  }

  // Start HTTP side transport if requested
  const httpEnabled = values.http !== undefined || values['http-only']
  const httpPort = values.http ? parseInt(values.http, 10) || 3099 : 3099
  let httpServer: HttpServer | undefined

  if (httpEnabled) {
    httpServer = await startHttpServer(session, { port: httpPort })
    process.stderr.write(`[mypry] HTTP server listening on http://127.0.0.1:${httpPort}\n`)
  }

  if (values['http-only']) {
    // No stdio transport — just keep HTTP running
    await new Promise(() => {}) // block forever
  } else if (values.mcp) {
    await runMcp(session)
  } else if (values.json) {
    await runNdjson(session)
  } else {
    await runRepl(session)
  }

  await httpServer?.close()
  try { cdp.ws.close() } catch {}
  process.exit(0)
}

main().catch((e) => { process.stderr.write(`fatal: ${e.message}\n`); process.exit(1) })
