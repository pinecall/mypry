# Architecture

How mypry works internally: components, data flow, and breakpoint resolution.

---

## Component diagram

```
your app                          mypry (MCP server, stdio)
────────                          ──────────────────────────────────
                                  ┌────────────────────────────────┐
Node.js ─ V8 inspector :9229 ─▶  │  DebuggerSession (orchestrator)│
                                  │   ├─ BreakpointManager         │
                                  │   │   ├─ BreakpointResolver    │
                                  │   │   └─ Conditions             │
                                  │   │       ├─ Expression         │
                                  │   │       ├─ HitCount           │
                                  │   │       └─ Logpoint           │
                                  │   ├─ ScriptSkipper (blackbox)  │
                                  │   ├─ SmartStepper              │
                                  │   ├─ ExceptionPauseService     │
                                  │   └─ SourceMapResolver         │
                                  │                                │
                                  │  BrowserToolKit (frontend)     │
                                  │   ├─ JSON actions (Playwright)  │
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
  3. DebuggerSession(cdp)            slim orchestrator
     session.init()                  listen for events, apply blackbox patterns
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

## Core architecture (VS Code-inspired)

The core is split into focused modules following patterns from VS Code's
[vscode-js-debug](https://github.com/nicolo-ribaudo/vscode-js-debug):

### DebuggerSession (`core/session.ts`)

Slim orchestrator (~290 lines). Owns CDP events, pause management, stepping,
eval, and locals. Delegates to subsystems:

### BreakpointManager (`core/breakpoints/`)

Owns breakpoint lifecycle: set, remove, list. Coordinates:

- **BreakpointResolver** (`resolver.ts`) — resolves user's file:line into CDP
  locations via a priority chain (source maps → Turbopack → webpack → URL → regex)
- **Conditions** (`conditions/`) — interface `IBreakpointCondition` with three
  implementations:

| Condition | CDP side | Server side |
|-----------|----------|-------------|
| `ExpressionCondition` | Wrapped in try/catch | Always pause |
| `HitCondition` | None (always pause) | `++hits` predicate (=, >, >=, <, <=, %) |
| `LogpointCondition` | `console.log(...), false` | Never pause |

### SourceMapResolver (`core/sources/`)

All source map operations:
- `resolveSourceToCompiled()` — forward: original → generated
- `resolveTypeScriptBreakpoint()` — find .js whose map references a .ts file
- `resolveOriginalPosition()` — reverse: compiled → original (for snapshots)
- **Finders**: `findTurbopackChunk()`, `findWebpackScript()`, `matchScript()`

### ScriptSkipper (`core/skipper/`)

- **ScriptSkipper** — uses V8's `Debugger.setBlackboxPatterns` for native
  script skipping during stepping. Much more efficient than manual stepOut loops.
- **SmartStepper** — stateful auto-step: if stepInto lands in framework code,
  auto-stepOut with a backout threshold (10 steps).
- **ExceptionPauseService** — filters exception pauses from framework code
  (justMyCode). Checks the top frame's URL against `isFrameworkCode()`.

### Key patterns

| Pattern | Example |
|---------|---------|
| Interface-first | `IBreakpointCondition` with `breakCondition` + `shouldStayPaused()` |
| Static factory | `HitCondition.parse("> 5")`, `ExpressionCondition.parse(expr)` |
| Pure functions | `wrapCondition()`, `shouldStepOver()`, `isFrameworkCode()` |
| `const enum` | `BreakpointKind`, `ExceptionBreakMode`, `StepOverReason` |
| Server-side state | Hit counts use `++this.hits` (not CDP globalThis hacks) |

---

## Breakpoint resolution

When you call `set_breakpoint({ file: "route.ts", line: 9 })`, the `BreakpointResolver` tries strategies in priority order:

### 1. TypeScript source map

```
route.ts:9
  │  Find loaded .js scripts whose source map references route.ts
  │  (inline data: URLs for Vite, .map files for tsc)
  ▼  generatedPositionFor(source, line) → compiled line 12
  ▼  setBreakpointByUrl with URL regex (HMR-resilient)
```

### 2. Turbopack chunk (Next.js)

```
route.ts:9
  │  Find Turbopack chunks (.next/server/chunks/_HASH._.js)
  │  whose URL or source references the module
  ▼  Parse sectioned source map → generatedPositionFor()
  ▼  setBreakpointByUrl with URL regex
```

### 3. webpack-internal (Next.js 14)

```
route.ts:9
  │  Find webpack-internal:///(rsc)/./app/.../route.ts scripts
  ▼  Parse inline source map → generatedPositionFor()
  ▼  setBreakpointByUrl with URL regex (survives HMR)
```

### 4. Direct URL match

```
route.ts:9
  │  Match script URL by full path or basename
  ▼  If source map: forward-map line
  ▼  setBreakpoint by scriptId
```

### 5. urlRegex fallback

```
route.ts:9
  ▼  setBreakpointByUrl with escaped file pattern
     CDP binds lazily when a matching script loads
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

The root-level `sources` is empty — all source info is inside `sections[].map`. The `source-map` library's `SourceMapConsumer` handles both formats.

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

## Browser actions pipeline

`debugger_browse` accepts a JSON actions array. Each action maps to a Playwright call — one action per object.

```
debugger_browse({ actions: [
  { "fill": ["textbox Email", "alice"] },
  { "click": "button Sign in" }
]})
        │
        ▼
  actions.ts         parse each action object → Playwright call
        │
        ▼
  resolveSelector()  resolve ARIA/CSS selector → locator
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
  mcp-bridge.ts              # Entry point — MCP stdio server ("mypry-bridge" binary)
  fullstack-toolkit.ts       # DebuggerToolKit — all 11 tools + MCP instructions
  core/
    types.ts                 # Shared interfaces (IScriptEntry, IBreakpointEntry, etc.)
    session.ts               # DebuggerSession — slim orchestrator (~290 lines)
    cdp-client.ts            # CDP WebSocket client (zero deps, ~80 lines)
    snapshot.ts              # Formats pause state for the agent
    sourcemap.ts             # Compiled→original position resolution (for snapshots)
    targets.ts               # V8 inspector target discovery
    index.ts                 # Public re-exports (mypry/core)

    breakpoints/
      index.ts               # BreakpointManager — lifecycle + CDP communication
      resolver.ts            # BreakpointResolver — resolution chain
      conditions/
        index.ts             # IBreakpointCondition interface + factory
        expression.ts        # Conditional BPs — try/catch wrapped for safety
        hit-count.ts         # Server-side hit counting (= > >= < <= %)
        logpoint.ts          # Logpoints — console.log + continue

    sources/
      index.ts               # Source map resolution (source→compiled + compiled→source)
      script-matcher.ts      # URL matching with priority (full path > basename)
      turbopack.ts           # Turbopack chunk finder
      webpack.ts             # webpack-internal:// script finder

    skipper/
      index.ts               # ScriptSkipper — V8 Debugger.setBlackboxPatterns
      smart-stepping.ts      # SmartStepper — auto-step through framework code
      exception-pause.ts     # ExceptionPauseService — exception filtering
      patterns.ts            # Blackbox pattern definitions + isFrameworkCode()

  browser/
    toolkit.ts               # BrowserToolKit — wraps Playwright for browse/snapshot
    actions.ts               # JSON action runner (click, fill, goto → Playwright)
    parser.ts                # AgentScript DSL tokenizer (deprecated, kept for compat)
    runtime.ts               # AgentScript verb executor (deprecated, kept for compat)
    session.ts               # Browser session lifecycle
    connect.ts               # Playwright connection helpers
```

---

## Eval targets

| Target | Scope | Mechanism |
|--------|-------|-----------|
| `"backend"` (default) | Node.js — frame scope when paused, global when running | `Debugger.evaluateOnCallFrame` / `Runtime.evaluate` |
| `"browser"` | Playwright page context — `window`, `document` | `page.evaluate(expr)` |
