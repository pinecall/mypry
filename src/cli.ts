/**
 * CLI entry point — parses args, connects to inspector, picks transport.
 *
 * Mechanical translation from mypry.js lines 536-604.
 * DO NOT change behavior — this is load-bearing.
 */

import { parseArgs } from 'node:util'
import { CDPClient, WorkerCDPProxy, discoverWorkers } from './core/cdp-client.js'
import type { WorkerInfo } from './core/cdp-client.js'
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

/** Find Chrome/Chromium binary on disk */
async function findChrome(): Promise<string> {
  const { existsSync } = await import('node:fs')
  const paths = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ]
  for (const p of paths) {
    if (existsSync(p)) return p
  }
  process.stderr.write('[mypry] error: Chrome not found\n')
  process.exit(1)
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      host: { type: 'string', default: '127.0.0.1' },
      port: { type: 'string', default: '9229' },
      inspect: { type: 'string' },            // backend inspector port (serve mode)
      url:  { type: 'string' },
      json: { type: 'boolean', default: false },
      mcp:  { type: 'boolean', default: false },
      http: { type: 'string' },
      'http-only': { type: 'boolean', default: false },
      token: { type: 'string' },
      tab: { type: 'string' },
      'tab-url': { type: 'string' },
      chrome: { type: 'boolean', default: false },
      frontend: { type: 'string' },           // --frontend URL (cleaner --chrome)
      'chrome-host': { type: 'string' },        // remote Chrome CDP host:port
      workers: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  })

  // ── Load .mypry.json config file (if present in CWD) ──
  let configFile: Record<string, any> = {}
  try {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const cfgPath = resolve(process.cwd(), '.mypry.json')
    const raw = readFileSync(cfgPath, 'utf-8')
    configFile = JSON.parse(raw)
    process.stderr.write(`[mypry] loaded config from .mypry.json\n`)
  } catch { /* no config file — that's fine */ }

  // Merge config → values (CLI flags take priority)
  // Config keys: port, inspect, frontend, token, host, workers
  function applyDefault(key: string, val: any) {
    if (val === undefined || val === null) return
    if ((values as any)[key] === undefined || (values as any)[key] === false ||
        ((values as any)[key] === '9229' && key === 'port')) {
      ;(values as any)[key] = typeof val === 'number' ? String(val) : val
    }
  }
  applyDefault('frontend', configFile.frontend)
  applyDefault('chrome-host', configFile.chromeHost)
  applyDefault('token', configFile.token)
  applyDefault('host', configFile.host)
  applyDefault('inspect', configFile.inspect ? String(configFile.inspect) : undefined)
  if (configFile.port && !values.http) {
    applyDefault('http', String(configFile.port))
  }
  if (configFile.workers === true) values.workers = true

  // ── `mypry serve` normalisation ──
  // `serve` = HTTP daemon for agents. Clean, opinionated defaults.
  const isServe = positionals[0] === 'serve'

  if (isServe) {
    values['http-only'] = true
    values.workers = true

    // --port in serve mode = HTTP port (default 3098), not inspector port
    // --inspect in serve mode = backend inspector port (default 9229)
    if (!values.http) {
      values.http = values.port !== '9229' ? values.port : '3098'
    }
    if (values.inspect) {
      values.port = values.inspect
    } else {
      values.port = '9229'
    }

    // Positional URL or --frontend URL → enable Chrome
    const frontendUrl = values.frontend || positionals.find(p =>
      p.startsWith('http://') || p.startsWith('https://') || p.startsWith('localhost')
    )
    if (frontendUrl) {
      values.chrome = true
      ;(values as any)._frontendUrl = frontendUrl.startsWith('http') ? frontendUrl : `http://${frontendUrl}`
    }
  }

  // --frontend URL (new flag, works in any mode)
  if (values.frontend && !isServe) {
    values.chrome = true
    ;(values as any)._frontendUrl = values.frontend.startsWith('http') ? values.frontend : `http://${values.frontend}`
  }

  if (values.help || positionals[0] === 'help') {
    process.stdout.write(
      `mypry - inline debugger for Node.js and the browser\n\n` +
      `Commands:\n` +
      `  mypry serve [options]   HTTP daemon for AI agents (recommended)\n` +
      `  mypry attach [options]  Interactive REPL debugger\n` +
      `  mypry watch [--port]    Monitor agent activity in realtime\n` +
      `  mypry open [URL]        Launch Chrome with debugger port\n` +
      `  mypry inject <PID>      Enable inspector on a running Node.js process\n\n` +
      `Serve options (daemon mode):\n` +
      `  --port PORT             HTTP API port (default: 3098)\n` +
      `  --inspect PORT          Backend inspector port (default: 9229)\n` +
      `  --frontend URL          Connect Chrome to URL for fullstack debugging\n` +
      `  --chrome-host HOST:PORT Connect to remote Chrome CDP (skip local launch)\n` +
      `  --token TOKEN           Bearer token for HTTP auth\n\n` +
      `Attach options (interactive REPL):\n` +
      `  --port PORT             V8 inspector port (default: 9229)\n` +
      `  --host HOST             Inspector host (default: 127.0.0.1)\n` +
      `  --url WS_URL            Direct WebSocket URL\n` +
      `  --json                  ndjson stdio transport\n` +
      `  --mcp                   MCP server on stdio\n` +
      `  --frontend URL          Also launch Chrome for frontend debugging\n\n` +
      `Config file (.mypry.json in project root):\n` +
      `  {"port": 3098, "frontend": "http://localhost:3001"}\n\n` +
      `Examples:\n` +
      `  mypry serve                                    # backend daemon on :3098\n` +
      `  mypry serve --frontend http://localhost:3001    # fullstack daemon\n` +
      `  mypry serve --port 3099 --inspect 9229         # custom ports\n` +
      `  mypry watch                                    # monitor agent ops in realtime\n` +
      `  mypry attach                                   # backend REPL\n` +
      `  mypry attach --frontend http://localhost:3001   # REPL + frontend\n` +
      `  mypry open http://localhost:5173                # launch Chrome for debugging\n` +
      `  mypry inject 12345                              # enable inspector on PID\n`
    )
    return
  }

  // ── `mypry watch` — live monitor of agent ops via SSE ──

  if (positionals[0] === 'watch') {
    const httpPort = values.http ? parseInt(values.http, 10) : (values.port !== '9229' ? parseInt(values.port!, 10) : 3098)
    const watchHost = values.host || '127.0.0.1'
    const baseUrl = `http://${watchHost}:${httpPort}`
    const headers: Record<string, string> = {}
    if (values.token) headers['Authorization'] = `Bearer ${values.token}`

    // ANSI colors
    const DIM = '\x1b[2m'
    const RESET = '\x1b[0m'
    const BOLD = '\x1b[1m'
    const GREEN = '\x1b[32m'
    const YELLOW = '\x1b[33m'
    const CYAN = '\x1b[36m'
    const RED = '\x1b[31m'
    const MAGENTA = '\x1b[35m'
    const BLUE = '\x1b[34m'

    process.stderr.write(`${BOLD}[mypry watch]${RESET} connecting to ${baseUrl}/events...\n`)

    // First check health
    try {
      const h = await fetch(`${baseUrl}/health`, { headers }).then(r => r.json()) as any
      const statusColor = h.status === 'paused' ? YELLOW : GREEN
      process.stderr.write(`${BOLD}[mypry watch]${RESET} ✅ connected — ${statusColor}${h.status}${RESET}\n`)
      process.stderr.write(`${DIM}─────────────────────────────────────────${RESET}\n`)
    } catch {
      process.stderr.write(`${RED}[mypry watch] ✗ cannot connect to ${baseUrl}${RESET}\n`)
      process.stderr.write(`${DIM}Is the daemon running? Start with: mypry serve${RESET}\n`)
      process.exit(1)
    }

    // Connect to SSE stream
    const res = await fetch(`${baseUrl}/events`, { headers })
    if (!res.ok || !res.body) {
      process.stderr.write(`${RED}[mypry watch] SSE connection failed: ${res.status}${RESET}\n`)
      process.exit(1)
    }

    const decoder = new TextDecoder()
    let eventType = ''
    let dataBuffer = ''

    function formatTimestamp(): string {
      const now = new Date()
      return `${DIM}${now.toLocaleTimeString('en-GB')}${RESET}`
    }

    function formatOp(data: any): void {
      const target = data.target === 'frontend' ? `${MAGENTA}frontend${RESET}` : `${BLUE}backend${RESET}`
      const op = `${BOLD}${data.op}${RESET}`
      const params = data.params || {}
      const extras: string[] = []
      if (params.expr) extras.push(`${DIM}expr=${RESET}"${params.expr.substring(0, 60)}${params.expr.length > 60 ? '…' : ''}"`)
      if (params.file) extras.push(`${DIM}file=${RESET}${params.file}`)
      if (params.line) extras.push(`${DIM}line=${RESET}${params.line}`)
      if (params.condition) extras.push(`${DIM}cond=${RESET}"${params.condition}"`)
      process.stdout.write(`${formatTimestamp()} ${CYAN}→${RESET} ${target} ${op}${extras.length ? ' ' + extras.join(' ') : ''}\n`)
    }

    function formatOpResult(data: any): void {
      const target = data.target === 'frontend' ? `${MAGENTA}frontend${RESET}` : `${BLUE}backend${RESET}`
      const result = data.result || {}
      if (result.error) {
        process.stdout.write(`${formatTimestamp()} ${RED}←${RESET} ${target} ${RED}error:${RESET} ${result.error}\n`)
      } else if (result.status === 'paused') {
        const fn = result.function || '?'
        const file = result.file?.split('/').pop() || '?'
        process.stdout.write(`${formatTimestamp()} ${YELLOW}←${RESET} ${target} ${YELLOW}paused${RESET} at ${BOLD}${fn}${RESET} ${DIM}${file}:${result.line}${RESET}\n`)
      } else if (result.status === 'running') {
        process.stdout.write(`${formatTimestamp()} ${GREEN}←${RESET} ${target} ${GREEN}running${RESET}\n`)
      } else if (result.ok !== undefined) {
        const val = result.value !== undefined ? JSON.stringify(result.value).substring(0, 80) : ''
        process.stdout.write(`${formatTimestamp()} ${GREEN}←${RESET} ${target} ${DIM}=${RESET} ${val}\n`)
      }
    }

    function formatPaused(data: any): void {
      const fn = data.function || '?'
      const file = data.file?.split('/').pop() || '?'
      process.stdout.write(`${formatTimestamp()} ${YELLOW}⏸${RESET}  ${YELLOW}paused${RESET} at ${BOLD}${fn}${RESET} ${DIM}${file}:${data.line}${RESET}\n`)
      if (data.locals) {
        const keys = Object.keys(data.locals).slice(0, 5)
        if (keys.length) {
          process.stdout.write(`${DIM}          locals: ${keys.map(k => `${k}=${JSON.stringify(data.locals[k]).substring(0, 40)}`).join(', ')}${RESET}\n`)
        }
      }
    }

    function formatResumed(): void {
      process.stdout.write(`${formatTimestamp()} ${GREEN}▶${RESET}  ${GREEN}resumed${RESET}\n`)
    }

    function handleEvent(event: string, data: string): void {
      try {
        const parsed = JSON.parse(data)
        switch (event) {
          case 'op': formatOp(parsed); break
          case 'op-result': formatOpResult(parsed); break
          case 'paused': formatPaused(parsed); break
          case 'resumed': formatResumed(); break
          case 'disconnected':
            process.stdout.write(`${formatTimestamp()} ${RED}✗${RESET}  ${RED}disconnected${RESET}\n`)
            break
          default:
            process.stdout.write(`${formatTimestamp()} ${DIM}${event}: ${data.substring(0, 100)}${RESET}\n`)
        }
      } catch {
        process.stdout.write(`${formatTimestamp()} ${DIM}${event}: ${data.substring(0, 100)}${RESET}\n`)
      }
    }

    // Parse SSE stream
    const reader = res.body.getReader()
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = decoder.decode(value, { stream: true })
      const lines = chunk.split('\n')
      for (const line of lines) {
        if (line.startsWith('event: ')) {
          eventType = line.slice(7).trim()
        } else if (line.startsWith('data: ')) {
          dataBuffer += line.slice(6)
        } else if (line === '') {
          if (eventType && dataBuffer) {
            handleEvent(eventType, dataBuffer)
          }
          eventType = ''
          dataBuffer = ''
        }
      }
    }

    process.stderr.write(`\n${DIM}[mypry watch] stream ended${RESET}\n`)
    process.exit(0)
  }

  // ── `mypry open [URL]` — launch Chrome with CDP ──

  if (positionals[0] === 'open') {
    const explicitUrl = positionals[1] || positionals.find(p => p.startsWith('http://') || p.startsWith('https://'))
    let chromeUrl: string

    if (explicitUrl) {
      chromeUrl = explicitUrl.startsWith('http') ? explicitUrl : `http://${explicitUrl}`
    } else {
      process.stderr.write(`[mypry] scanning for dev servers...\n`)
      const servers = await detectDevServers()
      if (servers.length === 0) {
        process.stderr.write('[mypry] no dev servers found\n')
        process.exit(1)
      } else if (servers.length === 1) {
        chromeUrl = servers[0]
      } else {
        chromeUrl = await pickServer(servers)
      }
    }

    process.stderr.write(`[mypry] opening Chrome → ${chromeUrl}\n`)

    // Kill any previous debug Chrome
    try {
      const { execSync } = await import('node:child_process')
      execSync('pkill -f "remote-debugging-port=9222" 2>/dev/null', { stdio: 'ignore' })
      await new Promise(r => setTimeout(r, 1000))
    } catch {}

    const chromePath = await findChrome()
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
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500))
      try {
        const targets = await discoverTargets('127.0.0.1', CHROME_DEBUG_PORT)
        if (targets.some(t => t.kind === 'chrome')) {
          process.stderr.write(`[mypry] ✅ Chrome ready — CDP on port ${CHROME_DEBUG_PORT}\n`)
          break
        }
      } catch { /* Chrome not ready yet */ }
    }
    process.stderr.write('[mypry] ✅ Chrome launched (CDP may take a moment)\n')
    process.exit(0)
  }

  // ── `mypry inject <PID>` — enable inspector on running process ──

  if (positionals[0] === 'inject') {
    const pid = parseInt(positionals[1], 10)
    if (!pid || isNaN(pid)) {
      process.stderr.write('[mypry] usage: mypry inject <PID>\n')
      process.exit(1)
    }
    process.stderr.write(`[mypry] sending SIGUSR1 to PID ${pid} to enable inspector...\n`)
    try {
      process.kill(pid, 'SIGUSR1')
    } catch (err: any) {
      process.stderr.write(`[mypry] failed: ${err.message}\n`)
      process.exit(1)
    }
    // Wait a moment for the inspector to start
    await new Promise(r => setTimeout(r, 500))
    process.stderr.write(`[mypry] inspector should be active on port ${values.port}\n`)
    // Fall through to attach
  }

  // ── Frontend session (Chrome CDP) — launch first so user can interact ──

  let frontendSession: DebuggerSession | undefined

  if (values.chrome) {
    // Check for explicit URL from --frontend, positionals, or auto-detect
    const presetUrl = (values as any)._frontendUrl
    const explicitUrl = presetUrl || positionals.find(p => p.startsWith('http://') || p.startsWith('https://') || p.startsWith('localhost'))
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
        process.stderr.write('[mypry] tip: pass the URL explicitly — mypry serve --frontend http://localhost:PORT\n')
        process.exit(1)
      } else if (servers.length === 1) {
        chromeUrl = servers[0]
        process.stderr.write(`[mypry] found ${chromeUrl}\n`)
      } else {
        chromeUrl = await pickServer(servers)
        process.stderr.write(`[mypry] using ${chromeUrl}\n`)
      }
    }

    // Determine Chrome CDP host — local (127.0.0.1) or remote
    const chromeHostRaw = values['chrome-host']
    const isRemoteChrome = !!chromeHostRaw
    let chromeHost = '127.0.0.1'
    let chromePort = CHROME_DEBUG_PORT
    if (chromeHostRaw) {
      const parts = chromeHostRaw.split(':')
      chromeHost = parts[0]
      if (parts[1]) chromePort = parseInt(parts[1], 10)
    }

    if (!isRemoteChrome) {
      // Local: kill previous, launch Chrome with remote debugging
      try {
        const { execSync } = await import('node:child_process')
        execSync('pkill -f "remote-debugging-port=9222" 2>/dev/null', { stdio: 'ignore' })
        await new Promise(r => setTimeout(r, 1000))
      } catch {}

      const chromePath = await findChrome()

      const { spawn } = await import('node:child_process')
      const chromeProc = spawn(chromePath, [
        `--remote-debugging-port=${chromePort}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--user-data-dir=/tmp/mypry-chrome-debug',
        chromeUrl,
      ], { stdio: 'ignore', detached: true })
      chromeProc.unref()
    } else {
      process.stderr.write(`[mypry] connecting to remote Chrome at ${chromeHost}:${chromePort}\n`)
    }

    // Wait for Chrome CDP to be ready
    process.stderr.write(`[mypry] waiting for Chrome CDP on ${chromeHost}:${chromePort}...\n`)
    let frontendWsUrl = ''
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 500))
      try {
        const targets = await discoverTargets(chromeHost, chromePort)
        // For remote Chrome, pick first page target; for local, match URL
        const pageTarget = isRemoteChrome
          ? targets.find(t => t.kind === 'chrome')
          : targets.find(t =>
              t.kind === 'chrome' && t.url?.includes(chromeUrl!.replace(/^https?:\/\//, ''))
            )
        if (pageTarget) {
          frontendWsUrl = pageTarget.wsUrl
          // For remote Chrome, fix the WebSocket URL to use the correct host
          if (isRemoteChrome && frontendWsUrl.includes('127.0.0.1')) {
            frontendWsUrl = frontendWsUrl.replace('127.0.0.1', chromeHost)
          }
          if (isRemoteChrome && frontendWsUrl.includes('localhost')) {
            frontendWsUrl = frontendWsUrl.replace('localhost', chromeHost)
          }
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

    // If paused inside pry(), auto-step-out to the caller's frame
    if (session.currentPause) {
      await session._skipPryFrames()
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

  // Discover and attach to worker threads
  const workerSessions = new Map<string, { info: WorkerInfo, session: DebuggerSession }>()

  if (values.workers) {
    const workers = await discoverWorkers(backendCdp)
    for (const info of workers) {
      const proxy = new WorkerCDPProxy(backendCdp, info.sessionId)
      const wsession = new DebuggerSession(proxy as any)
      await wsession.init()
      workerSessions.set(info.sessionId, { info, session: wsession })
      process.stderr.write(`[mypry] worker attached: ${info.title} (${info.sessionId.slice(0, 8)})\n`)
    }
    if (workers.length === 0) {
      process.stderr.write(`[mypry] no workers found (they may not have started yet)\n`)
    }
  }

  // Start HTTP side transport if requested
  const httpEnabled = values.http !== undefined || values['http-only']
  const httpPort = values.http ? parseInt(values.http, 10) || 3099 : 3099
  let httpServer: HttpServer | undefined

  if (httpEnabled) {
    const httpHost = values.host === '127.0.0.1' ? undefined : values.host
    httpServer = await startHttpServer(backendSession, {
      port: httpPort,
      host: httpHost,
      token: values.token,
      workerSessions: workerSessions.size > 0 ? workerSessions : undefined,
      frontendSession,
    })
    process.stderr.write(`[mypry] HTTP server listening on http://${httpHost || '127.0.0.1'}:${httpPort}\n`)
  }

  if (values['http-only']) {
    // Serve mode — also display live watch output
    if (httpServer) {
      const DIM = '\x1b[2m', RESET = '\x1b[0m', BOLD = '\x1b[1m'
      const GREEN = '\x1b[32m', YELLOW = '\x1b[33m', RED = '\x1b[31m'
      const CYAN = '\x1b[36m', BLUE = '\x1b[34m', MAGENTA = '\x1b[35m'
      const ts = () => `${DIM}${new Date().toLocaleTimeString('en-GB')}${RESET}`

      process.stderr.write(`${DIM}─────────────────────────────────────────${RESET}\n`)

      httpServer.events.on('paused', (d: any) => {
        const fn = d.function || '?'
        const file = d.file?.split('/').pop() || '?'
        process.stderr.write(`${ts()} ${YELLOW}⏸${RESET}  ${YELLOW}paused${RESET} at ${BOLD}${fn}${RESET} ${DIM}${file}:${d.line}${RESET}\n`)
        if (d.locals) {
          const keys = Object.keys(d.locals).slice(0, 5)
          if (keys.length) {
            process.stderr.write(`${DIM}          locals: ${keys.map((k: string) => `${k}=${JSON.stringify(d.locals[k]).substring(0, 40)}`).join(', ')}${RESET}\n`)
          }
        }
      })
      httpServer.events.on('resumed', () => {
        process.stderr.write(`${ts()} ${GREEN}▶${RESET}  ${GREEN}resumed${RESET}\n`)
      })
      httpServer.events.on('disconnected', () => {
        process.stderr.write(`${ts()} ${RED}✗${RESET}  ${RED}disconnected${RESET}\n`)
      })
      httpServer.events.on('op', (d: any) => {
        const target = d.target === 'frontend' ? `${MAGENTA}fe${RESET}` : `${BLUE}be${RESET}`
        const params = d.params || {}
        const extras: string[] = []
        if (params.expr) extras.push(`"${params.expr.substring(0, 50)}"`)
        if (params.file) extras.push(params.file)
        if (params.line) extras.push(`L${params.line}`)
        process.stderr.write(`${ts()} ${CYAN}→${RESET} ${target} ${BOLD}${d.op}${RESET}${extras.length ? ' ' + extras.join(' ') : ''}\n`)
      })
      httpServer.events.on('op-result', (d: any) => {
        const target = d.target === 'frontend' ? `${MAGENTA}fe${RESET}` : `${BLUE}be${RESET}`
        const r = d.result || {}
        if (r.error) {
          process.stderr.write(`${ts()} ${RED}←${RESET} ${target} ${RED}${r.error}${RESET}\n`)
        } else if (r.status === 'paused') {
          process.stderr.write(`${ts()} ${YELLOW}←${RESET} ${target} ${YELLOW}paused${RESET} ${DIM}${r.file?.split('/').pop()}:${r.line}${RESET}\n`)
        } else if (r.status === 'running') {
          process.stderr.write(`${ts()} ${GREEN}←${RESET} ${target} ${GREEN}running${RESET}\n`)
        } else if (r.ok !== undefined || r.value !== undefined) {
          const val = r.value !== undefined ? JSON.stringify(r.value).substring(0, 80) : 'ok'
          process.stderr.write(`${ts()} ${GREEN}←${RESET} ${target} ${DIM}=${RESET} ${val}\n`)
        }
      })
      httpServer.events.on('trace', (d: any) => {
        process.stderr.write(`${ts()} ${DIM}trace${RESET} ${d.function || '?'} ${DIM}${d.file?.split('/').pop()}:${d.line}${RESET}\n`)
      })
    }
    await new Promise(() => {}) // block forever
  } else if (values.mcp) {
    await runMcp(backendSession, {
      workerSessions: workerSessions.size > 0 ? workerSessions : undefined,
    })
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

