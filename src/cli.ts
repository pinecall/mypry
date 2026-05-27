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
import { discoverTargets, matchTarget } from './core/targets.js'

const CHROME_DEBUG_PORT = 9222

/** Scan common dev server ports and return all that respond */
async function detectDevServers(): Promise<string[]> {
  const ports = [3000, 3001, 5173, 5174, 5175, 5176, 5177, 5178, 5179, 5180, 8080, 8081, 4200]
  const checks = ports.map(async (port) => {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 300)
      const res = await fetch(`http://localhost:${port}`, { signal: controller.signal })
      clearTimeout(timeout)
      if (res.ok || res.status < 500) return `http://localhost:${port}`
    } catch { /* not running */ }
    return null
  })
  const results = await Promise.all(checks)
  return results.filter((r): r is string => r !== null)
}

/** Prompt user to pick from a list */
async function pickServer(servers: string[]): Promise<string> {
  const readline = await import('node:readline')
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })

  process.stderr.write(`\n[mypry] multiple dev servers found:\n\n`)
  for (let i = 0; i < servers.length; i++) {
    process.stderr.write(`  ${i + 1}) ${servers[i]}\n`)
  }
  process.stderr.write(`\n`)

  return new Promise((resolve) => {
    rl.question(`[mypry] pick one (1-${servers.length}): `, (answer) => {
      rl.close()
      const idx = parseInt(answer, 10) - 1
      if (idx >= 0 && idx < servers.length) {
        resolve(servers[idx])
      } else {
        resolve(servers[0])
      }
    })
  })
}

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
      tab: { type: 'string' },
      'tab-url': { type: 'string' },
      chrome: { type: 'boolean', default: false },
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
      `Frontend debugging:\n` +
      `  --chrome [URL]  launch Chrome with CDP (auto-detects dev server if no URL)\n\n` +
      `Examples:\n` +
      `  mypry attach                                # backend only\n` +
      `  mypry attach --chrome                       # auto-detect frontend\n` +
      `  mypry attach --chrome http://localhost:5178  # explicit frontend URL\n` +
      `  mypry attach --json                      # Aurora mode\n` +
      `  mypry attach --mcp                       # MCP for Claude Code\n`
    )
    return
  }

  // ── Frontend session (Chrome CDP) — launch first so user can interact ──

  let frontendSession: DebuggerSession | undefined

  if (values.chrome) {
    // Check for explicit URL in positionals
    const explicitUrl = positionals.find(p => p.startsWith('http://') || p.startsWith('https://') || p.startsWith('localhost'))
    let chromeUrl: string

    if (explicitUrl) {
      chromeUrl = explicitUrl.startsWith('http') ? explicitUrl : `http://${explicitUrl}`
      process.stderr.write(`[mypry] using ${chromeUrl}\n`)
    } else {
      // Auto-detect frontend dev servers
      process.stderr.write(`[mypry] scanning for dev servers...\n`)
      const servers = await detectDevServers()
      if (servers.length === 0) {
        process.stderr.write('[mypry] error: no dev server found on common ports (3000, 5173-5180, 8080)\n')
        process.stderr.write('[mypry] tip: pass the URL explicitly — mypry attach --chrome http://localhost:PORT\n')
        process.exit(1)
      } else if (servers.length === 1) {
        chromeUrl = servers[0]
        process.stderr.write(`[mypry] found ${chromeUrl}\n`)
      } else {
        chromeUrl = await pickServer(servers)
        process.stderr.write(`[mypry] using ${chromeUrl}\n`)
      }
    }

    // Kill any previous debug Chrome
    try {
      const { execSync } = await import('node:child_process')
      execSync('pkill -f "remote-debugging-port=9222" 2>/dev/null', { stdio: 'ignore' })
      await new Promise(r => setTimeout(r, 1000))
    } catch {}

    // Launch Chrome with remote debugging
    const chromePaths = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium-browser',
    ]
    let chromePath = ''
    const { existsSync } = await import('node:fs')
    for (const p of chromePaths) {
      if (existsSync(p)) { chromePath = p; break }
    }
    if (!chromePath) {
      process.stderr.write('[mypry] error: Chrome not found\n')
      process.exit(1)
    }

    const { spawn } = await import('node:child_process')
    const chromeProc = spawn(chromePath, [
      `--remote-debugging-port=${CHROME_DEBUG_PORT}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--user-data-dir=/tmp/mypry-chrome-debug',
      chromeUrl,
    ], { stdio: 'ignore', detached: true })
    chromeProc.unref()

    // Wait for Chrome CDP to be ready
    process.stderr.write(`[mypry] waiting for Chrome CDP on port ${CHROME_DEBUG_PORT}...\n`)
    let frontendWsUrl = ''
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 500))
      try {
        const targets = await discoverTargets('127.0.0.1', CHROME_DEBUG_PORT)
        const pageTarget = targets.find(t =>
          t.kind === 'chrome' && t.url?.includes(chromeUrl!.replace(/^https?:\/\//, ''))
        )
        if (pageTarget) {
          frontendWsUrl = pageTarget.wsUrl
          process.stderr.write(`[mypry] Chrome tab: ${pageTarget.title || pageTarget.url}\n`)
          break
        }
      } catch { /* Chrome not ready yet */ }
    }

    if (!frontendWsUrl) {
      process.stderr.write('[mypry] error: Chrome tab not found\n')
      process.exit(1)
    }

    const frontendCdp = new CDPClient(frontendWsUrl)
    await frontendCdp.connect()
    frontendSession = new DebuggerSession(frontendCdp)
    await frontendSession.init()
    process.stderr.write(`[mypry] ✅ frontend debugger attached\n`)
  }

  if (values.json && values.mcp) {
    process.stderr.write('error: --json and --mcp are mutually exclusive\n')
    process.exit(1)
  }

  // ── Backend connection (with auto-reconnect) ──

  const connectHost = values.host === '0.0.0.0' ? '127.0.0.1' : values.host!
  const port = parseInt(values.port!, 10)

  async function connectBackend(): Promise<{ session: DebuggerSession, cdp: CDPClient }> {
    let wsUrl = values.url
    if (!wsUrl) {
      let targets: Awaited<ReturnType<typeof discoverTargets>> | undefined

      // Try once — if it fails, poll until pry() opens the inspector
      try {
        targets = await discoverTargets(connectHost, port)
      } catch {
        process.stderr.write(
          `[mypry] waiting for backend inspector on ${connectHost}:${port}...\n` +
          `[mypry] trigger a pry() call or add a debugger statement\n`
        )
        while (true) {
          await new Promise(r => setTimeout(r, 500))
          try {
            targets = await discoverTargets(connectHost, port)
            if (targets.length) break
          } catch { /* keep trying */ }
        }
        process.stderr.write(`[mypry] backend inspector found!\n`)
      }
      if (!targets?.length) { process.stderr.write('no inspectable contexts\n'); process.exit(1) }

      // Tab matching (for Chrome/browser targets)
      const tabMatch = matchTarget(targets, { tab: values.tab, tabUrl: values['tab-url'] })
      if (tabMatch) {
        wsUrl = tabMatch.wsUrl
        const kind = tabMatch.kind === 'chrome' ? 'browser' : 'node'
        process.stderr.write(`[mypry] attaching to ${kind} target: ${tabMatch.title || tabMatch.url || 'unknown'}\n`)
      } else {
        wsUrl = targets[0].wsUrl
      }
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

    return { session, cdp }
  }

  let { session: backendSession, cdp: backendCdp } = await connectBackend()

  // Auto-reconnect when WebSocket drops (nodemon, NestJS --watch, etc.)
  function setupReconnect() {
    backendCdp.onClose(() => {
      process.stderr.write(`\n[mypry] backend disconnected — reconnecting...\n`)
      const retry = async () => {
        for (let i = 1; i <= 20; i++) {
          await new Promise(r => setTimeout(r, 2000))
          try {
            const conn = await connectBackend()
            backendSession = conn.session
            backendCdp = conn.cdp
            process.stderr.write(`[mypry] ✅ backend reconnected\n`)
            setupReconnect()  // re-wire for the new connection
            return
          } catch {
            if (i % 5 === 0) process.stderr.write(`[mypry] reconnect attempt ${i}...\n`)
          }
        }
        process.stderr.write(`[mypry] gave up reconnecting after 20 attempts\n`)
      }
      retry()
    })
  }
  setupReconnect()

  // Start HTTP side transport if requested
  const httpEnabled = values.http !== undefined || values['http-only']
  const httpPort = values.http ? parseInt(values.http, 10) || 3099 : 3099
  let httpServer: HttpServer | undefined

  if (httpEnabled) {
    httpServer = await startHttpServer(backendSession, { port: httpPort })
    process.stderr.write(`[mypry] HTTP server listening on http://127.0.0.1:${httpPort}\n`)
  }

  if (values['http-only']) {
    // No stdio transport — just keep HTTP running
    await new Promise(() => {}) // block forever
  } else if (values.mcp) {
    await runMcp(backendSession)
  } else if (values.json) {
    await runNdjson(backendSession)
  } else {
    await runRepl(backendSession, frontendSession)
  }

  await httpServer?.close()
  try { backendCdp?.ws.close() } catch {}
  process.exit(0)
}

main().catch((e) => { process.stderr.write(`fatal: ${e.message}\n`); process.exit(1) })

