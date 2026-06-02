# Architecture

How mypry works internally: components, data flow, and breakpoint resolution.

---

## Component diagram

```
your app                          mypry (MCP server, stdio)
────────                          ──────────────────────────────────
                                  ┌────────────────────────────────┐
Node.js ─ V8 inspector :9229 ─▶  │  DebuggerSession (backend)     │
                                  │   ├─ pause / step / eval       │
                                  │   ├─ breakpoints (conditional) │
                                  │   ├─ source maps (TS → JS)    │
                                  │   ├─ Turbopack chunk matching  │
                                  │   └─ hot-reload awareness      │
                                  │                                │
                                  │  BrowserToolKit (frontend)     │
                                  │   ├─ AgentScript DSL           │
                                  │   ├─ ARIA snapshots            │
                                  │   └─ page navigation + forms   │
                                  └────────────────────────────────┘
                                         ▲
AI Agent ── stdio ── mypry-bridge ───────┘
```

mypry is a **pure MCP server** — no daemon, no HTTP API. The agent's MCP runtime starts the `mypry-bridge` process directly via stdio. The bridge owns both the CDP connection (backend) and the Playwright browser (frontend).

---

## Connection flow

```
debugger_connect { port: 9229, frontend: "http://localhost:3000" }
        │
        ▼
  1. discoverTargets(host, port)     HTTP GET /json → inspector targets
        │
        ▼
  2. CDPClient(wsUrl)                WebSocket → V8 inspector
     cdp.connect()                   enable Debugger + Runtime domains
        │
        ▼
  3. DebuggerSession(cdp)            high-level API over CDP
     session.init()                  listen for Debugger.paused / resumed
        │
        ▼
  4. BrowserToolKit                  (if frontend URL provided)
     Session.open({ headless })      Playwright chromium.launch()
     page.goto(frontendUrl)          navigate to the app
```

---

## CDP connection

### CDPClient

Minimal Chrome DevTools Protocol client. Zero dependencies, ~80 lines. Handles:
- WebSocket connection to the inspector
- Request/response correlation (by `id`)
- Event dispatching (`Debugger.paused`, `Debugger.resumed`, etc.)
- Domain enabling (`Debugger`, `Runtime`)

Uses Node 22+ global `WebSocket` — no `ws` dependency.

---

## Breakpoint resolution

When you call `set_breakpoint({ file: "route.ts", line: 9 })`, the resolution depends on the bundler:

### Plain Node.js (Express, Fastify)

Direct URL matching — the script URL ends with the filename. Breakpoint set at the exact line via `Debugger.setBreakpointByUrl`.

### TypeScript (tsc / Vite / Remix)

```
route.ts:9
  │
  ▼  Find loaded scripts whose source map references route.ts
  │  (inline data: URLs for Vite, .map files for tsc)
  │
  ▼  Parse the source map (source-map library)
  │
  ▼  Reverse-map: original line 9 → compiled line 12
  │
  ▼  Set breakpoint on compiled .js at line 12
```

mypry finds `.js` scripts whose source maps reference `route.ts`, then uses the `source-map` library to reverse-map the original TypeScript line to the compiled JavaScript line.

### Turbopack (Next.js)

Turbopack is the most complex case. Modules are compiled into consolidated chunks like `[root-of-the-server]__HASH._.js`. The module filename does NOT appear in the chunk URL.

**Resolution chain:**

```
route.ts:9
  │
  ▼  1. Scan chunk source for "[project]/.../route.ts" declaration
  │     (initial load: module name embedded in source)
  │     (hot-reload: module path in URL query param ?id=[project]/...)
  │
  ▼  2. Find first function definition after module start
  │     compiled line 52: async function GET(request) {
  │
  ▼  3. Read user's source file from disk
  │     source line 2: export async function GET(request) {
  │
  ▼  4. Compute offset: compiled_func(52) - source_func(2) = 50
  │     target line: 50 + user_line(9) = 59
  │
  ▼  5. Set breakpoint via Debugger.setBreakpoint (by scriptId + line)
  │     Exact: no regex, no guessing
  │
  ▼  6. After hot-reload: prefer highest scriptId (most recent chunk)
```

### Sectioned source maps

Most bundlers emit **flat** source maps:

```json
{ "sources": ["route.ts"], "mappings": "AAAA..." }
```

Turbopack emits **indexed/sectioned** source maps:

```json
{
  "sections": [
    { "offset": { "line": 11, "column": 0 },
      "map": { "sources": ["route.ts"], "mappings": "AAAA..." } }
  ]
}
```

The root-level `sources` is empty — all source info is inside `sections[].map`. mypry detects this and iterates through sections to find the correct inner map.

---

## Inject flow

`debugger_inject` attaches the V8 inspector to a running process that wasn't started with `--inspect`.

```
debugger_inject { appPort: 3000 }
        │
  ┌─────▼──────────────────────────────────────────────┐
  │  1. findPidByPort(3000)          lsof / netstat    │
  │  2. scanInspectorPorts()         HTTP probe 9229+  │
  │  3. if 9229 occupied → ERROR     (actionable msg)  │
  │  4. _debugProcess(pid)           sends SIGUSR1     │
  │  5. scanInspectorPorts()         diff → new port   │
  │  6. connect(inspectorPort)       CDP WebSocket     │
  └────────────────────────────────────────────────────┘
```

Port 9229 conflicts are detected **before** sending the signal. If another Node process already occupies 9229, mypry returns an error with concrete options (restart with a different port, or kill the occupying process).

---

## AgentScript pipeline

AgentScript is the built-in DSL for `debugger_browse`. It drives the browser via Playwright — one action per line.

```
debugger_browse({ script: "fill \"textbox Email\" \"alice\"\nclick \"button Sign in\"" })
        │
        ▼
  parser.ts          tokenize each line → Step[] (verb + args)
        │
        ▼
  runtime.ts         map each Step → Playwright action
        │
        ▼
  page.getByRole()   resolve ARIA selector → locator
  page.fill()        Playwright executes
  page.click()
```

### Selector resolution (runtime.ts)

In order of precedence:
1. **ARIA role + name** from snapshot → `page.getByRole('button', { name: 'Sign In' })`
2. **Label shorthand** `"label:Email"` → `page.getByLabel('Email')`
3. **Placeholder shorthand** `"placeholder:Search"` → `page.getByPlaceholder('Search')`
4. **CSS selector** `"#email"`, `".btn"` → `page.locator(...)`

---

## File structure

```
src/
  mcp-bridge.ts         # MCP stdio server entry — the "mypry-bridge" binary
  fullstack-toolkit.ts  # DebuggerToolKit — 11 MCP tools, inject logic, MCP instructions
  core/
    cdp-client.ts       # Chrome DevTools Protocol client (WebSocket, zero deps)
    session.ts          # Debugger session: breakpoints, eval, stepping, Turbopack
    snapshot.ts         # Pause state formatting (file, line, locals, source window)
    sourcemap.ts        # TypeScript source map resolution (flat + sectioned)
    targets.ts          # Inspector target discovery (HTTP probe)
    index.ts            # Public re-exports for mypry/core
  browser/
    toolkit.ts          # BrowserToolKit — browse, snapshot, DSL runner
    parser.ts           # AgentScript parser (tokenizer → Step[])
    runtime.ts          # AgentScript step executor (verb → Playwright action)
    session.ts          # Browser session (launch / connect / close)
    connect.ts          # Playwright connection helpers
```

---

## Eval targets

| Target | Scope | Mechanism |
|--------|-------|-----------|
| `"backend"` (default) | Node.js — frame scope when paused, global when running | `Debugger.evaluateOnCallFrame` / `Runtime.evaluate` |
| `"browser"` | Playwright page context — `window`, `document` | `page.evaluate(expr)` |
