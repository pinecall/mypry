/**
 * DebuggerToolKit — self-contained, zero-setup fullstack debugger.
 *
 * Combines mypry's CDP debugger with the built-in browser toolkit
 * into a single, unified tool surface for AI agents.
 *
 * Usage:
 *   const kit = new DebuggerToolKit()
 *   await kit.call('debugger_connect', { port: 9229, frontend: 'http://localhost:3000' })
 *   await kit.call('debugger_browse', { actions: [{ fill: ["textbox Email", "alice"] }, { click: "button Sign in" }] })
 *   // ^ auto-detects backend breakpoint if one fires during the browse
 */

import { CDPClient } from './core/cdp-client.js'
import { DebuggerSession } from './core/session.js'
import { discoverTargets } from './core/targets.js'
import { snapshot, cleanUrl, type PausedSnapshot } from './core/snapshot.js'
import { BrowserToolKit } from './browser/toolkit.js'
import { runActions, type BrowserAction, type ActionResult } from './browser/actions.js'
import { execSync } from 'node:child_process'

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── Tool definitions (plain JSON Schema) ──────────────────────────────

export const TOOLS = [
  {
    name: 'debugger_connect',
    description:
      'Connect to a Node.js process (V8 inspector) and optionally launch a browser for the frontend. Call this first. If the process was started with --inspect, it connects immediately. If frontend is given, a Playwright browser opens and navigates to that URL.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        port: { type: 'number', description: 'V8 inspector port (default: 9229)' },
        host: { type: 'string', description: 'Inspector host (default: 127.0.0.1)' },
        frontend: { type: 'string', description: 'Frontend URL — launches browser and navigates here' },
        headless: { type: 'boolean', description: 'Run browser headless (default: true)' },
      },
    },
  },
  {
    name: 'debugger_state',
    description:
      'Get the current state of both backend and browser. Backend: paused/running, file, line, function, locals, source window. Browser: current URL and title. Use this to orient yourself.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'debugger_browse',
    description:
      'Execute browser actions (click, fill, navigate). Pass an array of JSON action objects. Each action has one key (the verb) and its value (the argument). If an action triggers a backend breakpoint, the response includes the pause state automatically. Call debugger_snapshot first to see selectors.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        actions: {
          type: 'array',
          description: 'Array of action objects. Each has one key (verb) and value (args). Examples: { "click": "button Sign in" }, { "fill": ["textbox Email", "alice"] }, { "goto": "http://localhost:3000" }',
          items: { type: 'object' },
        },
        script: { type: 'string', description: '(Deprecated) AgentScript DSL string. Prefer actions array.' },
        timeoutMs: { type: 'number', description: 'Per-action timeout in ms (default: 4000)' },
      },
    },
  },
  {
    name: 'debugger_snapshot',
    description:
      'Get the ARIA accessibility tree of the current browser page. Use this to discover selectors before writing a debugger_browse script. Shows buttons, links, inputs, headings with their roles and names. After navigation, snapshot again.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        scope: { type: 'string', description: 'CSS selector to scope the snapshot' },
      },
    },
  },
  {
    name: 'debugger_eval',
    description:
      'Evaluate a JavaScript expression. Default target is "backend": when paused evaluates in frame scope (access locals), when running evaluates in global scope. Set target to "browser" to evaluate in the browser page context (access DOM, Vue stores, window, etc.). Vue ref() and Pinia $state are auto-unwrapped.',
    inputSchema: {
      type: 'object' as const,
      required: ['expr'],
      properties: {
        expr: { type: 'string', description: 'JavaScript expression to evaluate' },
        target: { type: 'string', enum: ['backend', 'browser'], description: 'Where to evaluate: "backend" (Node.js, default) or "browser" (page context)' },
      },
    },
  },
  {
    name: 'debugger_step',
    description:
      'Step execution: "over" (next line), "into" (enter function), or "out" (exit function). Returns the new state after stepping.',
    inputSchema: {
      type: 'object' as const,
      required: ['mode'],
      properties: {
        mode: { type: 'string', enum: ['over', 'into', 'out'], description: 'Step mode' },
      },
    },
  },
  {
    name: 'debugger_continue',
    description:
      'Resume execution until the next breakpoint or program termination. Returns the new pause state if a breakpoint fires, otherwise {status: "running"}. Default wait is 5s; increase timeoutMs if the operation takes longer to hit a breakpoint.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        timeoutMs: { type: 'number', description: 'Max ms to wait for next breakpoint (default: 5000). Increase for slow operations.' },
      },
    },
  },
  {
    name: 'debugger_set_breakpoint',
    description:
      'Set a breakpoint at a file and line, OR enable exception breakpoints. ' +
      'For line breakpoints: pass file + line (supports TypeScript via source maps). ' +
      'For exception breakpoints: pass exception="all" (pause on every throw), ' +
      '"uncaught" (only unhandled), or "none" (disable). ' +
      'Exception breakpoints use justMyCode — only pauses on YOUR code, not framework internals. ' +
      'Logpoints: pass logMessage to log without pausing (use {expr} for interpolation). ' +
      'Hit count: pass hitCount to only pause on the Nth execution.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        file: { type: 'string', description: 'File path or basename (e.g. "auth.service.ts")' },
        line: { type: 'number', description: 'Line number (1-based)' },
        condition: { type: 'string', description: 'JS condition — only pause when truthy' },
        exception: { type: 'string', enum: ['all', 'uncaught', 'none'], description: 'Pause on exceptions: "all", "uncaught", or "none" to disable' },
        logMessage: { type: 'string', description: 'Log message instead of pausing (logpoint). Use {expr} for interpolation, e.g. "user={user.email} role={user.role}"' },
        hitCount: { type: 'number', description: 'Only pause on the Nth execution of this line. Useful for loops.' },
      },
    },
  },
  {
    name: 'debugger_breakpoints',
    description:
      'List all breakpoints. If "remove" is set, removes that breakpoint ID first.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        remove: { type: 'number', description: 'Breakpoint ID to remove before listing' },
      },
    },
  },
  {
    name: 'debugger_disconnect',
    description:
      'Close the debugger session and browser. Call when done debugging.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'debugger_inject',
    description:
      'Enable the V8 inspector on a running Node.js process that was NOT started with --inspect. Give the app port (e.g. 3000 for your Express/Next.js server) and the tool finds the PID, sends SIGUSR1, discovers the inspector port, and connects automatically. Works with Express, Fastify, Next.js, Vite SSR, etc.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        appPort: { type: 'number', description: 'The port your app listens on (e.g. 3000). Tool finds the PID via lsof.' },
        pid: { type: 'number', description: 'Direct PID if you already know it (alternative to appPort)' },
        frontend: { type: 'string', description: 'Frontend URL — also launches browser for fullstack debugging' },
        headless: { type: 'boolean', description: 'Run browser headless (default: true)' },
      },
    },
  },
]

// ── MCP server instructions ──

export const DEBUGGER_INSTRUCTIONS = [
  'mypry — fullstack debugger for AI agents.',
  'Debug Node.js backend + browser frontend in one session.',
  '',
  'Tested: Express, Vite, Next.js (Turbopack & Webpack), Remix (React Router).',
  '',
  '═══════════════════════════════════════════════════════',
  'GETTING CONNECTED',
  '═══════════════════════════════════════════════════════',
  '',
  '▸ Option A — Inject (RECOMMENDED, no restart needed):',
  '  debugger_inject { appPort: 3000 }',
  '  Works with Express, Fastify, Vite, Hono — any Node.js app.',
  '  Add frontend for fullstack:',
  '  debugger_inject { appPort: 3000, frontend: "http://localhost:3000" }',
  '',
  '▸ Option B — App started with --inspect:',
  '  debugger_connect { port: 9333 }',
  '',
  '▸ Option C — Next.js:',
  '  Tell the user: NODE_OPTIONS=\'--inspect=9555\' npm run dev',
  '  Then connect to PORT+1 (the child router process):',
  '  debugger_connect { port: 9556, frontend: "http://localhost:3000" }',
  '',
  '▸ Option D — Browser only:',
  '  debugger_connect { frontend: "http://localhost:3000" }',
  '',
  'Decision tree:',
  '  "Debug my app on port 3000"    → debugger_inject { appPort: 3000 }',
  '  "I started with --inspect"     → debugger_connect { port: XXXX }',
  '  "Debug my Next.js app"         → Tell user: NODE_OPTIONS, then connect PORT+1',
  '  "Test the UI"                  → debugger_connect { frontend: "http://..." }',
  '',
  '═══════════════════════════════════════════════════════',
  'DEBUGGER WORKFLOW',
  '═══════════════════════════════════════════════════════',
  '',
  '1. Connect: debugger_inject or debugger_connect',
  '2. Set breakpoints:',
  '   Line:      debugger_set_breakpoint { file: "auth.ts", line: 47 }',
  '   Conditional: debugger_set_breakpoint { file: "auth.ts", line: 47, condition: "email === \\"admin@test.com\\"" }',
  '   Exception: debugger_set_breakpoint { exception: "all" }  ← BEST when you don\'t know WHERE the error is',
  '   Uncaught:  debugger_set_breakpoint { exception: "uncaught" }  ← only unhandled errors',
  '   Disable:   debugger_set_breakpoint { exception: "none" }',
  '   Logpoint:  debugger_set_breakpoint { file: "auth.ts", line: 47, logMessage: "user={user.email} role={user.role}" }',
  '             → logs without pausing. Use {expr} for interpolation.',
  '   Hit count: debugger_set_breakpoint { file: "loop.ts", line: 12, hitCount: 5 }',
  '             → only pauses on the 5th execution.',
  '3. Trigger the breakpoint:',
  '   — debugger_browse to interact with the UI (click Submit → backend BP fires)',
  '   — or run `curl ... &` in the terminal',
  '4. debugger_state — see paused state:',
  '   • file, line, function name',
  '   • locals (deep-serialized objects, not just "Object")',
  '   • __closure__: variables from parent scopes (module imports, singletons)',
  '   • call_stack: full call chain (who called this function)',
  '   • source_window: ±4 lines of ORIGINAL TypeScript (not compiled JS)',
  '   • return_value: value returned by the last function call (after step-over)',
  '5. debugger_eval { expr: "request.body" } — backend variables',
  '   debugger_eval { expr: "document.title", target: "browser" } — frontend DOM/state',
  '6. debugger_step { mode: "over" } — step through code',
  '   debugger_step { mode: "into" } — smart: auto-skips framework code (node_modules)',
  '7. debugger_continue — resume execution',
  '   debugger_continue { timeoutMs: 15000 } — wait longer for slow operations',
  '',
  'Fullstack example:',
  '  debugger_inject { appPort: 3000, frontend: "http://localhost:3000" }',
  '  debugger_set_breakpoint { file: "auth.controller.ts", line: 47 }',
  '  debugger_snapshot                          ← see page selectors',
  '  debugger_browse { actions: [',
  '    { "fill": ["textbox Email", "alice@test.com"] },',
  '    { "click": "button Sign in" }',
  '  ]}',
  '  ← response includes backend pause if breakpoint fired!',
  '  debugger_eval { expr: "body.email" }       ← inspect backend locals',
  '  debugger_continue',
  '',
  '═══════════════════════════════════════════════════════',
  'BROWSER ACTIONS — debugger_browse Reference',
  '═══════════════════════════════════════════════════════',
  '',
  'debugger_browse accepts a JSON actions array. Each action is an object',
  'with one key (the verb) and its value (the argument or argument array).',
  '',
  'ALWAYS call debugger_snapshot FIRST to see available selectors.',
  'Never guess selectors — use what the snapshot returns.',
  '',
  'SELECTORS — from debugger_snapshot output:',
  '  "button Sign In"         ARIA role + name (preferred)',
  '  "textbox Email"          ARIA role + name',
  '  "link Dashboard"         ARIA role + name',
  '  "label:Email"            by label',
  '  "placeholder:Search"     by placeholder',
  '  "#id", ".class"          CSS selectors also work',
  '',
  'ACTIONS:',
  '  { "click": "button Sign In" }',
  '  { "fill": ["textbox Email", "alice@example.com"] }',
  '  { "type": ["textbox Search", "hello", { "delay": 100 }] }',
  '  { "press": "Enter" }',
  '  { "press": ["textbox Email", "Enter"] }',
  '  { "select": ["combobox Country", "US"] }',
  '  { "check": "checkbox Remember me" }',
  '  { "uncheck": "checkbox Newsletter" }',
  '  { "hover": "button Menu" }',
  '  { "clear": "textbox Search" }',
  '',
  'NAVIGATION:',
  '  { "goto": "http://localhost:3000/login" }',
  '  { "back": true }',
  '  { "forward": true }',
  '  { "reload": true }',
  '  { "waiturl": "/dashboard" }',
  '',
  'TIMING:',
  '  { "wait": "500ms" }',
  '  { "wait": ["button Submit", "visible"] }',
  '  { "wait": ["spinner", "hidden"] }',
  '',
  'UPLOAD / DIALOG:',
  '  { "upload": ["input[type=file]", "/path/to/file.pdf"] }',
  '  { "ondialog": "accept" }',
  '  { "scroll": "down" }',
  '  { "scroll": ["listbox Results", "down"] }',
  '',
  'FULL EXAMPLE:',
  '  debugger_browse { actions: [',
  '    { "goto": "http://localhost:3000/login" },',
  '    { "fill": ["textbox Email", "alice@example.com"] },',
  '    { "fill": ["textbox Password", "secret"] },',
  '    { "click": "button Sign in" },',
  '    { "waiturl": "/dashboard" }',
  '  ]}',
  '',
  'TIPS:',
  '- For reading DOM values, use debugger_eval { expr: "...", target: "browser" }.',
  '- After navigation, call debugger_snapshot before interacting with new elements.',
  '- debugger_browse auto-detects backend pauses — if a breakpoint fires, the response includes pause state.',
  '- If you know selectors from source code, use CSS directly ("#email", ".btn").',
  '',
  '═══════════════════════════════════════════════════════',
  'IMPORTANT BEHAVIOR',
  '═══════════════════════════════════════════════════════',
  '',
  '- debugger_inject is the easiest path — no restart, no flags. Just the app port.',
  '- debugger_browse auto-detects pauses — if a breakpoint fires during browser interaction, the response includes backend state.',
  '- debugger_continue waits 5s for next breakpoint. Returns {status: "running"} if nothing fires.',
  '- Source maps automatic — TypeScript paths in state, breakpoints, eval. Works with Vite, Turbopack, Webpack, tsc.',
  '- Auto-reconnect — survives process restarts (nodemon, NestJS --watch).',
  '- Vue/Pinia unwrap — ref() and $state auto-unwrapped in eval.',
  '- inject requires port 9229 to be free.',
].join('\n')

// ── Result type ──

export interface ToolResult {
  [key: string]: unknown
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

// ── DebuggerToolKit ──

export class DebuggerToolKit {
  private session: DebuggerSession | null = null
  private cdp: CDPClient | null = null
  private browserKit: BrowserToolKit | null = null
  private _reconnecting = false
  private _disposed = false
  // Exception state is managed by session.exceptions (ExceptionPauseService)

  /** Tool definitions — register in your MCP server. */
  get tools() { return TOOLS }

  /** Instructions for the MCP server init. */
  get instructions() { return DEBUGGER_INSTRUCTIONS }

  /** Check if a tool name belongs to this kit. */
  handles(name: string): boolean {
    return TOOLS.some(t => t.name === name)
  }

  /** Dispatch a tool call. */
  async call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    try {
      switch (name) {
        case 'debugger_connect':    return this.handleConnect(args)
        case 'debugger_state':      return this.handleState()
        case 'debugger_browse':     return this.handleBrowse(args)
        case 'debugger_snapshot':   return this.handleSnapshot(args)
        case 'debugger_eval':       return this.handleEval(args)
        case 'debugger_step':       return this.handleStep(args)
        case 'debugger_continue':   return this.handleContinue(args)
        case 'debugger_set_breakpoint': return this.handleSetBreakpoint(args)
        case 'debugger_breakpoints':    return this.handleBreakpoints(args)
        case 'debugger_disconnect':     return this.handleDisconnect()
        case 'debugger_inject':         return this.handleInject(args)
        default:
          throw new Error(`unknown tool: ${name}`)
      }
    } catch (e: any) {
      return this.err(e?.message ?? String(e))
    }
  }

  /** Clean up everything. */
  async dispose(): Promise<void> {
    this._disposed = true
    this._reconnecting = false
    await this.browserKit?.dispose()
    try { this.cdp?.ws.close() } catch {}
    this.session = null
    this.cdp = null
    this.browserKit = null
  }

  // ── Tool handlers ──

  private async handleConnect(args: Record<string, unknown>): Promise<ToolResult> {
    // Close previous session if any
    await this.dispose()
    this._disposed = false  // re-enable for the new session

    const port = args.port as number | undefined
    const host = (args.host as string) ?? '127.0.0.1'
    const frontend = args.frontend as string | undefined
    const headless = (args.headless as boolean) ?? true

    const result: Record<string, unknown> = {}

    // Connect to backend inspector (optional — skip if no port given)
    if (port) {
      const connectHost = host === '0.0.0.0' ? '127.0.0.1' : host
      let targets: Awaited<ReturnType<typeof discoverTargets>> = []

      // Poll for inspector (app may not have started yet)
      for (let i = 0; i < 10; i++) {
        try {
          targets = await discoverTargets(connectHost, port)
          if (targets.length) break
        } catch { /* not ready */ }
        await sleep(500)
      }

      if (!targets.length) {
        throw new Error(
          `No inspector found on ${connectHost}:${port}. ` +
          `Start your app with: node --inspect=${port} server.js`
        )
      }

      const wsUrl = targets[0].wsUrl
      this.cdp = new CDPClient(wsUrl)
      await this.cdp.connect()

      this.session = new DebuggerSession(this.cdp)
      await this.session.init()

      // Unblock if launched with --inspect-brk
      await this.cdp.send('Runtime.runIfWaitingForDebugger')

      // Give it a moment to hit a pry()/debugger statement
      if (!this.session.currentPause) {
        await Promise.race([
          this.session._waitRawPause(),
          sleep(300),
        ])
      }
      if (this.session.currentPause) {
        await this.session._skipPryFrames()
      }

      // Setup auto-reconnect
      this.setupReconnect(connectHost, port)

      result.backend = { connected: true, target: targets[0].title || targets[0].url }
    } else {
      result.backend = { skipped: true, reason: 'no port given — browser-only mode' }
    }

    // Connect browser if frontend URL given
    if (frontend) {
      this.browserKit = new BrowserToolKit()
      await this.browserKit.call('browser_connect', { headless })
      await this.browserKit.call('browser_run', { script: `goto ${frontend}` })
      result.browser = { connected: true, url: frontend }
      result.syntax_hint = 'Call debugger_snapshot to see the page, then debugger_browse to interact.'
    }

    return this.okJson(result)
  }

  private async handleInject(args: Record<string, unknown>): Promise<ToolResult> {
    const appPort = args.appPort as number | undefined
    const directPid = args.pid as number | undefined
    const frontend = args.frontend as string | undefined
    const headless = (args.headless as boolean) ?? true

    if (!appPort && !directPid) {
      throw new Error('Provide appPort (e.g. 3000) or pid. appPort is recommended.')
    }

    // Step 1: Find PID from app port
    const pid = directPid ?? findPidByPort(appPort!)
    const processInfo = getProcessName(pid)

    // Step 2: Check if port 9229 is free (pure HTTP, cross-platform)
    // _debugProcess always opens on 9229. If it's taken, it silently fails.
    const portsBefore = await scanInspectorPorts()

    if (portsBefore.has(9229)) {
      // Identify who's using it for a helpful error message
      let occupier = 'another process'
      try {
        const targets = await discoverTargets('127.0.0.1', 9229)
        if (targets.length) occupier = `"${targets[0].title}"`
      } catch {}

      throw new Error(
        `Port 9229 is already in use by ${occupier}. ` +
        `inject requires port 9229 to be free.\n\n` +
        `Options:\n` +
        `  1. Start your app with a specific inspector port:\n` +
        `     node --inspect=9230 your-app.js\n` +
        `     Then use: debugger_connect { port: 9230 }\n\n` +
        `  2. Kill the process using port 9229:\n` +
        `     lsof -ti :9229 | xargs kill\n` +
        `     Then retry: debugger_inject { appPort: ${appPort ?? 'PORT'} }`
      )
    }

    // Step 3: Activate V8 inspector on the target process
    // _debugProcess is cross-platform (used internally by `node inspect`)
    try {
      (process as any)._debugProcess(pid)
    } catch (e: any) {
      throw new Error(`Failed to activate inspector on PID ${pid}: ${e.message}`)
    }
    await sleep(800)

    // Step 4: Find the new inspector port (pure HTTP scan)
    const portsAfter = await scanInspectorPorts()
    const newPorts = [...portsAfter].filter(p => !portsBefore.has(p))

    if (newPorts.length === 0) {
      throw new Error(
        `Sent debug signal to PID ${pid} but no inspector port appeared. ` +
        `The process may not be Node.js, or the signal was ignored.`
      )
    }

    const inspectorPort = newPorts[0]

    // Step 5: Connect
    const result = await this.handleConnect({ port: inspectorPort, frontend, headless })
    const data = JSON.parse((result.content as any)[0].text)
    data.injected = { pid, appPort: appPort ?? null, inspectorPort, process: processInfo || undefined }
    return this.okJson(data)
  }

  private async handleState(): Promise<ToolResult> {
    const result: Record<string, unknown> = {}

    // Backend state
    if (this.session) {
      result.backend = await snapshot(this.session)
    } else {
      result.backend = { status: 'disconnected' }
    }

    // Browser state
    if (this.browserKit) {
      try {
        const evalResult = await this.browserKit.call('browser_run', {
          script: 'extract "html" attr "title" as _title',
        })
        const vars = JSON.parse(evalResult.content[0].text)?.vars || {}
        // Just get URL from a simple eval
        const urlResult = await this.browserKit.call('browser_run', {
          script: 'eval "window.location.href" as _url',
        })
        const urlVars = JSON.parse(urlResult.content[0].text)?.vars || {}
        result.browser = {
          url: urlVars._url || 'unknown',
          title: vars._title || 'unknown',
        }
      } catch {
        result.browser = { status: 'connected' }
      }
    }

    return this.okJson(result)
  }

  private async handleBrowse(args: Record<string, unknown>): Promise<ToolResult> {
    if (!this.browserKit) {
      throw new Error('No browser connected. Call debugger_connect with a frontend URL first.')
    }

    const actions = args.actions as BrowserAction[] | undefined
    const script = args.script as string | undefined
    const timeoutMs = (args.timeoutMs as number) || 4000

    if (!actions && !script) {
      throw new Error('Either "actions" (JSON array) or "script" (deprecated DSL string) is required.')
    }

    // Remember if we were already paused
    const wasPaused = !!this.session?.currentPause

    let browserData: Record<string, unknown>

    if (actions) {
      // ── New JSON actions path ──
      const page = this.browserKit.page
      if (!page) throw new Error('No browser page available')
      const actionResult = await runActions(actions, page, timeoutMs)
      browserData = {
        ok: !actionResult.error,
        completed: actionResult.completed,
        total: actionResult.total,
        error: actionResult.error,
        failedAt: actionResult.failedAt,
        needsSnapshot: actionResult.needsSnapshot,
      }
    } else {
      // ── Legacy AgentScript DSL fallback ──
      const browserResult = await this.browserKit.call('browser_run', { script, timeoutMs })
      browserData = JSON.parse(browserResult.content[0].text)
    }

    const result: Record<string, unknown> = { browser: browserData }

    // Check if a backend breakpoint fired during the browser interaction
    if (this.session && !wasPaused) {
      // Wait briefly for a breakpoint to propagate
      const pausePromise = this.session._waitRawPause()
      const raced = await Promise.race([
        pausePromise.then(() => 'paused'),
        sleep(1500).then(() => 'timeout'),
      ])

      if (raced === 'paused' && this.session.currentPause) {
        await this.session._skipPryFrames()
        const state = await snapshot(this.session)
        result.backend = state
      }
    } else if (this.session?.currentPause && !wasPaused) {
      // Already paused during script execution
      const state = await snapshot(this.session)
      result.backend = state
    }

    return this.okJson(result)
  }

  private async handleSnapshot(args: Record<string, unknown>): Promise<ToolResult> {
    if (!this.browserKit) {
      throw new Error('No browser connected. Call debugger_connect with a frontend URL first.')
    }
    const result = await this.browserKit.call('browser_snapshot', {
      scope: args.scope as string | undefined,
    })
    return result
  }

  private async handleEval(args: Record<string, unknown>): Promise<ToolResult> {
    const expr = (args.expr as string) || ''
    const target = (args.target as string) || 'backend'

    // Browser eval — runs in page context via Playwright page.evaluate()
    if (target === 'browser') {
      if (!this.browserKit) {
        throw new Error('No browser connected. Call debugger_connect with a frontend URL first.')
      }
      const page = this.browserKit.page
      if (!page) {
        throw new Error('Browser session not ready. Call debugger_connect with a frontend URL first.')
      }
      try {
        const value = await page.evaluate(expr)
        return this.okJson({ ok: true, target: 'browser', value })
      } catch (e: any) {
        return this.okJson({ ok: false, target: 'browser', error: e.message })
      }
    }

    // Backend eval — runs in Node.js inspector
    const session = this.requireSession()
    const r = await session.evalInFrame(expr) as any
    if (r.exceptionDetails) {
      return this.okJson({
        ok: false,
        target: 'backend',
        error: r.exceptionDetails.text,
        description: r.result?.description,
      })
    }
    return this.okJson({
      ok: true,
      target: 'backend',
      type: r.result.type,
      value: r.result.value !== undefined ? r.result.value : null,
      description: r.result.description ?? null,
    })
  }

  private async handleStep(args: Record<string, unknown>): Promise<ToolResult> {
    const session = this.requireSession()
    const mode = args.mode as string
    if (mode === 'over') await session.stepOver()
    else if (mode === 'into') await session.stepInto()
    else if (mode === 'out') await session.stepOut()
    else throw new Error(`invalid step mode: ${mode}`)

    const frame = session.topFrame()
    if (frame) await session.getSource(frame.location.scriptId)
    const state = await snapshot(session)
    return this.okJson(state)
  }

  private async handleContinue(args: Record<string, unknown> = {}): Promise<ToolResult> {
    const session = this.requireSession()
    const timeoutMs = (args.timeoutMs as number) || 5000
    await session.resume()

    // Wait for next breakpoint (configurable timeout)
    const outcome = await Promise.race([
      session.waitNextPause().then(() => 'paused'),
      this.cdp ? new Promise<string>(r => this.cdp!.onClose(() => r('terminated'))) : sleep(timeoutMs).then(() => 'running'),
      sleep(timeoutMs).then(() => 'running'),
    ])

    if (outcome === 'terminated') {
      return this.okJson({ status: 'terminated' })
    }
    if (outcome === 'paused' && session.currentPause) {
      const frame = session.topFrame()
      if (frame) await session.getSource(frame.location.scriptId)
      return this.okJson(await snapshot(session))
    }
    return this.okJson({ status: 'running' })
  }

  private async handleSetBreakpoint(args: Record<string, unknown>): Promise<ToolResult> {
    const session = this.requireSession()

    // Exception breakpoint mode
    if (args.exception) {
      const state = args.exception as string
      if (!['all', 'uncaught', 'none'].includes(state)) {
        throw new Error('exception must be "all", "uncaught", or "none"')
      }
      await session.exceptions.setMode(state)
      return this.okJson({ ok: true, exception: state })
    }

    // Line breakpoint mode — file and line required
    const file = args.file as string
    const line = args.line as number
    if (!file || !line) {
      throw new Error('Either pass file + line for a line breakpoint, or exception for exception breakpoints')
    }

    // Delegate condition building to BreakpointManager
    const id = await session.breakpoints.set(file, line, {
      condition: args.condition as string | undefined,
      logMessage: args.logMessage as string | undefined,
      hitCount: args.hitCount != null ? String(args.hitCount) : undefined,
    })

    const result: any = { ok: true, id, file, line }
    if (args.logMessage) result.logMessage = args.logMessage
    if (args.hitCount) result.hitCount = args.hitCount
    if (args.condition) result.condition = args.condition
    return this.okJson(result)
  }

  private async handleBreakpoints(args: Record<string, unknown>): Promise<ToolResult> {
    const session = this.requireSession()

    // Remove if requested
    if (args.remove != null) {
      await session.breakpoints.remove(args.remove as number)
    }

    const breakpoints = session.breakpoints.list().map(bp => ({
      id: bp.id,
      file: bp.file,
      line: bp.line,
      condition: bp.condition || null,
    }))

    return this.okJson({ breakpoints, exceptionBreakpoint: session.exceptions.getMode() })
  }

  private async handleDisconnect(): Promise<ToolResult> {
    await this.dispose()
    return this.okJson({ disconnected: true })
  }

  // ── Helpers ──

  private requireSession(): DebuggerSession {
    if (!this.session) {
      throw new Error('No debugger connected. Call debugger_connect first.')
    }
    return this.session
  }

  private setupReconnect(host: string, port: number) {
    if (!this.cdp) return
    this.cdp.onClose(() => {
      if (this._reconnecting || this._disposed) return
      this._reconnecting = true
      const retry = async () => {
        for (let i = 1; i <= 20; i++) {
          await sleep(2000)
          try {
            const targets = await discoverTargets(host, port)
            if (!targets.length) continue
            this.cdp = new CDPClient(targets[0].wsUrl)
            await this.cdp.connect()
            this.session = new DebuggerSession(this.cdp)
            await this.session.init()
            await this.cdp.send('Runtime.runIfWaitingForDebugger')
            this.setupReconnect(host, port)
            this._reconnecting = false
            process.stderr.write(`[mypry] ✅ backend reconnected\n`)
            return
          } catch { /* keep trying */ }
        }
        this._reconnecting = false
        process.stderr.write(`[mypry] gave up reconnecting\n`)
      }
      process.stderr.write(`[mypry] backend disconnected — reconnecting...\n`)
      retry()
    })
  }

  private okJson(data: unknown): ToolResult {
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
  }

  private err(message: string): ToolResult {
    return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

// ── Inject helpers (cross-platform) ────────────────────────────────────

/** Find the PID listening on a given port. One shell command per platform. */
function findPidByPort(port: number): number {
  const cmd = process.platform === 'win32'
    ? `netstat -ano | findstr :${port} | findstr LISTENING`
    : `lsof -i :${port} -sTCP:LISTEN -t`
  try {
    const out = execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
    if (!out) throw new Error(`No process found listening on port ${port}`)
    // Windows: last column is PID. Unix: entire output is PID.
    const line = out.split('\n')[0].trim()
    const pid = process.platform === 'win32'
      ? parseInt(line.split(/\s+/).pop()!, 10)
      : parseInt(line, 10)
    if (isNaN(pid)) throw new Error(`Could not parse PID from: ${line}`)
    return pid
  } catch (e: any) {
    if (e.message?.includes('No process found')) throw e
    throw new Error(`No process found on port ${port}`)
  }
}

/** Get the process command name for display purposes. */
function getProcessName(pid: number): string {
  try {
    const cmd = process.platform === 'win32'
      ? `wmic process where ProcessId=${pid} get CommandLine /value`
      : `ps -p ${pid} -o command=`
    return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  } catch { return '' }
}

/**
 * Scan common inspector ports using pure HTTP (no shell commands).
 * Returns the set of ports that have a V8 inspector responding.
 * Range: 9229-9260 covers default + auto-incremented ports.
 */
async function scanInspectorPorts(): Promise<Set<number>> {
  const found = new Set<number>()
  const checks = []
  for (let port = 9229; port <= 9260; port++) {
    checks.push(
      discoverTargets('127.0.0.1', port)
        .then(targets => { if (targets.length) found.add(port) })
        .catch(() => {})
    )
  }
  await Promise.all(checks)
  return found
}
