# Skill: mypry — Interactive Debugger for AI Agents

> **When to read this file:** Whenever you need to debug a running Node.js process, inspect variables at runtime, set breakpoints, trace execution, debug frontend (Chrome CDP), or test remote debugging.

---

## Overview

mypry is an inline debugger for Node.js and the browser. It connects via CDP to a running process and exposes MCP tools and an HTTP API for inspecting, evaluating, stepping, and continuing.

**Architecture:**

```
Agent ── stdio ──▶ mypry-bridge ── HTTP ──▶ mypry daemon ── CDP ──▶ Node.js (:9229)
                   (bin, instant)            (mypry serve)          Chrome  (:9222)
```

**Two binaries:**
- `mypry` — CLI: `serve`, `watch`, `attach`, `open`, `inject`
- `mypry-bridge` — MCP bridge (stateless proxy, what agents run)

Both installed via `npm install -g mypry` or `npm link` from `~/mypry`.

---

## MCP Setup

### Standalone (default port 3098)

```json
{
  "mypry": {
    "command": "mypry-bridge"
  }
}
```

No env needed — defaults to `http://127.0.0.1:3098`.

### Aurora TUI (port 3099)

```json
{
  "mypry": {
    "command": "mypry-bridge",
    "env": { "MYPRY_URL": "http://127.0.0.1:3099/api/debugger" }
  }
}
```

### Remote (via SSH tunnel)

```json
{
  "mypry": {
    "command": "mypry-bridge",
    "env": { "MYPRY_URL": "http://127.0.0.1:3099" }
  }
}
```

With SSH tunnel: `ssh -L 3099:localhost:3099 user@server`

---

## MCP Tools

All tools accept optional `target` (`"frontend"` / `"backend"`) and `worker` params.

### Inspection (safe, read-only)

| Tool | Params | Description |
|------|--------|-------------|
| `debugger_state` | — | Current pause: file, line, function, locals, source window |
| `debugger_eval` | `expr` | Evaluate JS — paused: frame scope; running: global scope |
| `debugger_backtrace` | — | Call stack frames |
| `debugger_source` | `file?` | Full source (source-mapped) |
| `debugger_list_breakpoints` | — | All active breakpoints |
| `debugger_trace_status` | — | Peek at trace buffer |
| `debugger_workers` | — | List worker threads |

### Execution Control

| Tool | Params | Blocks? | Description |
|------|--------|:------:|-------------|
| `debugger_continue` | — | **yes** | Resume until next breakpoint (30s timeout) |
| `debugger_step_over` | — | no | Next line |
| `debugger_step_into` | — | no | Into function |
| `debugger_step_out` | — | no | Out of function |
| `debugger_pause` | — | no | Force-pause running process |
| `debugger_set_breakpoint` | `file`, `line`, `condition?` | no | Set breakpoint |
| `debugger_remove_breakpoint` | `id` | no | Remove by ID |

### Trace Mode

| Tool | Params | Description |
|------|--------|-------------|
| `debugger_trace_start` | `maxBuffer?` | Auto-resume + collect snapshots |
| `debugger_trace_stop` | — | Stop, return all hits |
| `debugger_trace_status` | — | Peek without stopping |

---

## CLI Commands

```bash
mypry serve                                    # daemon on :3098
mypry serve --frontend http://localhost:3001   # + Chrome CDP
mypry serve --port 3099 --inspect 9230         # custom ports
mypry serve --host 0.0.0.0 --token s3cr3t     # remote + auth

mypry watch                                    # live monitor (SSE)
mypry watch --host staging --port 3099         # remote monitor

mypry open http://localhost:3001               # launch debug Chrome
mypry attach                                   # interactive REPL
mypry inject <PID>                             # enable inspector on running process
```

## Project Config (`.mypry.json`)

```json
{
  "port": 3098,
  "inspect": 9229,
  "frontend": "http://localhost:3001",
  "chromeHost": "staging:9222",
  "token": "s3cr3t",
  "host": "127.0.0.1",
  "workers": true
}
```

CLI flags override config. Place in project root.

---

## Building & Testing

```bash
cd ~/mypry
npm run build              # tsc → dist/
npm run test               # contract + suite tests
npm run test:suite         # just the NDJSON contract tests
npm link                   # makes mypry + mypry-bridge available globally
```

### Test structure

```
test/
  ndjson-contract.test.ts  — main test suite (16 tests)
test-aurora-contract.cjs   — Aurora TUI contract tests
```

### Verified features

All these have been tested end-to-end:

- ✅ Backend breakpoints (debugger; + set_breakpoint)
- ✅ Conditional breakpoints
- ✅ Eval in paused frame + running global
- ✅ Step over/into/out
- ✅ Backtrace with source maps (tsc + Vite)
- ✅ Trace mode (non-blocking)
- ✅ Worker threads
- ✅ Frontend debugging (Chrome CDP + Vue/Pinia unwrapping)
- ✅ Fullstack handoff (frontend → backend in one session)
- ✅ Remote debugging (Mac → SSH tunnel → GCP server)
- ✅ Auto-reconnect (nodemon, NestJS --watch)
- ✅ `mypry watch` live monitor (local + remote)
- ✅ Token auth (Bearer token)

---

## Key Source Files

| File | Purpose |
|------|---------|
| `src/cli.ts` | CLI entry: serve, watch, attach, open, inject |
| `src/mcp-bridge.ts` | MCP bridge (stateless stdio proxy → HTTP) |
| `src/core/session.ts` | DebuggerSession — CDP wrapper, breakpoints, eval |
| `src/core/ops.ts` | Operation dispatcher (eval, state, step, etc.) |
| `src/core/snapshot.ts` | Snapshot builder (locals, source window, source maps) |
| `src/core/targets.ts` | Target discovery (inspector, Chrome CDP) |
| `src/transports/http.ts` | HTTP server (REST + SSE) |
| `src/transports/mcp.ts` | MCP server (tools → ops) |
| `src/browser.ts` | Chrome launch + CDP connect |

---

## Important Behavior Notes

1. **`debugger_continue` BLOCKS** — waits up to 30s for next pause. Don't call unless you expect a breakpoint.
2. **Trace mode is non-blocking** — app runs normally, snapshots collected automatically.
3. **Source maps are automatic** — TypeScript paths shown in state, backtrace, source.
4. **Global eval when not paused** — falls back to `Runtime.evaluate` (global scope).
5. **Vue/Pinia auto-unwrapping** — `ref()` and Pinia `$state` automatically unwrapped in eval results.
6. **Auto-reconnect** — survives process restarts (every 2s, up to 40s).
7. **`--host` binds HTTP too** — `--host 0.0.0.0` makes both inspector and HTTP daemon listen on all interfaces.
