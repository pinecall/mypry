# AGENTS.md

Guide for AI agents and developers working on this codebase.

## Project

mypry is a fullstack debugger for AI agents. It's an MCP server (stdio) that gives agents 11 tools to debug Node.js backends and browser frontends in a single session.

## Build

```bash
npm install
npm run build        # clean dist/ + tsc → dist/
npm run watch        # tsc --watch
npm link             # ← REQUIRED for local dev (see below)
```

**`npm link` is required for local dev.** The MCP host runs the global
`mypry-bridge` binary. Without `npm link`, that global can silently be a stale
real install pointing at old code (this once served a long-dead API and hid
`debugger_inject`). `npm link` repoints the global bin at this working tree, so
a `npm run build` here is what the agent actually runs. `build` cleans `dist/`
first, so removed source never lingers as an orphan `.js`.

Tests (CI runs all of these as separate jobs — see `.github/workflows/ci.yml`):

```bash
npm test               # build + fast unit/e2e (serializer, bounded state, tool shapes) — release gate
npm run test:inject    # debugger_inject into a plain Node process (no --inspect)
npm run test:fullstack # browser click → backend pause (needs Playwright chromium)
npm run test:nextjs    # real Next.js: webpack + turbopack breakpoint resolution
npm run test:integration  # all of the integration suites above
```

- `tests/serialize.test.mjs` — the bounded serializer (limits, redaction,
  framework summary) + the injected-string path.
- `tests/state-locals.test.mjs` — end-to-end through real CDP: a plain `http`
  server pauses and the snapshot is bounded/redacted/justMyCode.
- `tests/tool-output.test.mjs` — each tool's response shape via the real toolkit.
- `tests/integration/inject.test.mjs` — the `debugger_inject` attach path.
- `tests/integration/fullstack.test.mjs` — connect+frontend, snapshot, browse →
  auto-attached backend pause, `eval target:browser` (drives the
  [`examples/login-bug`](examples/login-bug) app).
- `tests/integration/{webpack,turbopack}-breakpoints.test.mjs` — run against the
  `tests/fixtures/cart-bug/` Next.js 14 app (planted bug) to verify breakpoint
  resolution, HMR survival, conditional breakpoints, eval, step-over, reconnection.

## Source layout

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

## Architecture (VS Code-inspired)

The core is split into focused modules following patterns from VS Code's
[vscode-js-debug](https://github.com/nicolo-ribaudo/vscode-js-debug):

- **DebuggerSession** (`core/session.ts`) — slim orchestrator. Owns CDP events,
  pause management, stepping, eval, locals. Delegates to subsystems below.

- **BreakpointManager** (`core/breakpoints/`) — owns breakpoint lifecycle.
  Uses `BreakpointResolver` for resolution and `IBreakpointCondition` for
  conditions. Conditions are wrapped in try/catch (like VS Code) to prevent
  debugger crashes from bad expressions.

- **SourceMapResolver** (`core/sources/`) — all source map operations.
  Handles inline data: URIs, external .map files, standard maps, and
  sectioned/indexed maps (Turbopack). Separate finders for Turbopack chunks
  and webpack-internal scripts.

- **ScriptSkipper** (`core/skipper/`) — uses V8's `Debugger.setBlackboxPatterns`
  for native script skipping during stepping. `SmartStepper` handles the
  stepInto→auto-stepOut loop with a backout threshold.
  `ExceptionPauseService` filters exception pauses from framework code.

- **BrowserToolKit** (`browser/toolkit.ts`) — internal module. The
  `debugger_browse` tool delegates here. Uses JSON actions (`actions.ts`)
  with deprecated DSL fallback.

### Key patterns

| Pattern | Example |
|---------|---------|
| Interface-first | `IBreakpointCondition` with `breakCondition` + `shouldStayPaused()` |
| Static factory | `HitCondition.parse("> 5")`, `ExpressionCondition.parse(expr)` |
| Pure functions | `wrapCondition()`, `shouldStepOver()`, `isFrameworkCode()` |
| `const enum` | `BreakpointKind`, `ExceptionBreakMode`, `StepOverReason` |
| Server-side state | Hit counts use `++this.hits` (not CDP globalThis hacks) |

## Breakpoint resolution

Resolution chain in `BreakpointResolver` (ordered by priority):

1. **TypeScript source map** — find .js whose source map references the .ts, reverse-map line
2. **Turbopack chunk** — sectioned source map `generatedPositionFor()`
3. **webpack-internal** — inline source map + `setBreakpointByUrl` for HMR resilience
4. **Direct URL match** — with or without source map
5. **urlRegex fallback** — deferred binding for lazy-loaded scripts

## MCP tools

| Tool | What it does |
|------|-------------|
| `debugger_connect` | Connect to V8 inspector + optionally launch browser |
| `debugger_disconnect` | Close everything |
| `debugger_state` | Paused/running, file, line, locals (deep-serialized), closure vars, call stack, return value, TS source window |
| `debugger_set_breakpoint` | File + line (optional condition), exception breakpoints (`all`/`uncaught`/`none`), logpoints (`logMessage`), hit count (`hitCount`) |
| `debugger_breakpoints` | List or remove breakpoints (includes exception breakpoint state) |
| `debugger_eval` | JS expression — backend (default) or browser |
| `debugger_step` | Step over / into (smart — skips `node_modules`) / out |
| `debugger_continue` | Resume until next breakpoint (configurable `timeoutMs`, default 5s) |
| `debugger_browse` | Drive the browser via JSON actions (click, fill, goto → Playwright) |
| `debugger_snapshot` | ARIA accessibility tree of the page |
| `debugger_inject` | Attach to a running process without `--inspect` |

## Publish

```bash
npm version <patch|minor|prerelease>
npm run build
npm publish --tag beta
```