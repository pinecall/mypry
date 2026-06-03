# AGENTS.md

Guide for AI agents and developers working on this codebase.

## Project

mypry is a fullstack debugger for AI agents. It's an MCP server (stdio) that gives agents 11 tools to debug Node.js backends and browser frontends in a single session.

## Build

```bash
npm install
npm run build        # tsc → dist/
npm run watch        # tsc --watch
```

Integration tests run against a real Next.js dev server (no mocks):

```bash
npm test                          # build + run integration tests
npm run test:integration          # same
node --test tests/integration/webpack-breakpoints.test.mjs  # direct
```

The test fixture lives in `tests/fixtures/cart-bug/` — a Next.js 14 app with
a planted state-management bug used to verify breakpoint resolution, HMR
survival, conditional breakpoints, eval, step-over, and reconnection.

## Source layout

```
src/
  mcp-bridge.ts          # Entry point — MCP stdio server ("mypry-bridge" binary)
  fullstack-toolkit.ts   # DebuggerToolKit — all 11 tools + MCP instructions
  core/
    cdp-client.ts        # CDP WebSocket client (zero deps, ~80 lines)
    session.ts           # DebuggerSession — breakpoints, eval, step, source maps, Turbopack
    snapshot.ts          # Formats pause state for the agent
    sourcemap.ts         # TS source map resolution (flat + sectioned)
    targets.ts           # V8 inspector target discovery
    index.ts             # Public re-exports (mypry/core)
  browser/
    toolkit.ts           # BrowserToolKit — wraps Playwright for browse/snapshot
    parser.ts            # AgentScript DSL tokenizer
    runtime.ts           # AgentScript verb executor (→ Playwright actions)
    session.ts           # Browser session lifecycle
    connect.ts           # Playwright connection helpers
```

## Key concepts

- **DebuggerToolKit** (`fullstack-toolkit.ts`) — the main class. Exposes `.tools` (JSON Schema) and `.call(name, args)`. The MCP bridge just wires this to stdio.
- **DebuggerSession** (`core/session.ts`) — manages one CDP connection. Handles breakpoint resolution across plain JS, TypeScript (source maps), and Turbopack (offset calculation).
- **BrowserToolKit** (`browser/toolkit.ts`) — internal module. The `debugger_browse` tool delegates to this. Uses AgentScript DSL (parser.ts → runtime.ts → Playwright).
- **AgentScript** — one action per line DSL. Selectors come from ARIA snapshots. See `DEBUGGER_INSTRUCTIONS` in fullstack-toolkit.ts for the reference.

## Breakpoint resolution

This is the most complex part. When `set_breakpoint({ file: "route.ts", line: 9 })` is called:

1. **Plain JS** — direct URL match, set at exact line
2. **TypeScript** — find compiled .js with source map referencing the .ts file, reverse-map the line
3. **Turbopack (Next.js)** — scan consolidated chunks for module declaration, compute offset between compiled and source function positions
4. **Webpack-internal (Next.js 14)** — match `webpack-internal://` scripts by file path, resolve line via inline source map, use `setBreakpointByUrl` for HMR resilience

See [docs/architecture.md](docs/architecture.md) for the full resolution chains.

## MCP tools

| Tool | What it does |
|------|-------------|
| `debugger_connect` | Connect to V8 inspector + optionally launch browser |
| `debugger_disconnect` | Close everything |
| `debugger_state` | Paused/running, file, line, locals, source window |
| `debugger_set_breakpoint` | File + line, optional condition |
| `debugger_breakpoints` | List or remove breakpoints |
| `debugger_eval` | JS expression — backend (default) or browser |
| `debugger_step` | Step over / into / out |
| `debugger_continue` | Resume until next breakpoint |
| `debugger_browse` | Drive the browser via AgentScript |
| `debugger_snapshot` | ARIA accessibility tree of the page |
| `debugger_inject` | Attach to a running process without --inspect |

## Publish

```bash
npm version <patch|minor|prerelease>
npm run build
npm publish --tag beta
```