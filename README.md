<div align="center">

# mypry

**The interactive full-stack debugger for AI agents.**

Pause, step, and inspect live state across your **Node.js backend and browser frontend — in a single session** — and hand it all to your AI agent over MCP.

[![npm](https://img.shields.io/npm/v/mypry.svg)](https://www.npmjs.com/package/mypry)
[![node](https://img.shields.io/badge/node-%E2%89%A522-43853d.svg)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](#license)

```bash
npm install mypry
```

</div>

---

## Why mypry

AI coding agents are great at reading code and guessing. They're blind at runtime. Most tools that try to fix this either:

- **only see the browser** (Chrome DevTools-style MCP servers) — great for the DOM, but they can't set a breakpoint in your Node service and step through it, or
- **only see the backend** (Node inspector MCP servers) — they pause your server, but they have no idea what the frontend sent.

A real bug lives in *both*: the button click, the request payload, the handler, the DB call. mypry is the only debugger that lets an agent **follow one request from the browser click into the backend handler — pausing, stepping and evaluating live on both sides — inside a single session.**

It also ships with a **non-blocking trace mode**, so your agent can observe many executions without ever freezing the app.

---

## Quick start (with an AI agent, 60 seconds)

**1. Run your app with the inspector open.**

```bash
node --inspect server.js        # backend on :9229
```

**2. Start the mypry daemon.**

```bash
mypry serve                     # HTTP daemon on :3098
```

**3. Point your agent at it.** Add mypry to your agent's MCP config (Claude Code shown — see [MCP setup](#mcp-setup) for Cursor / Antigravity):

```json
{
  "mcpServers": {
    "mypry": {
      "command": "node",
      "args": ["./node_modules/mypry/dist/mcp-bridge.js"],
      "env": { "MYPRY_URL": "http://127.0.0.1:3098" }
    }
  }
}
```

**4. Drop a `debugger` in your code and trigger it.** Your agent now has live tools:

```
You:    Why is the admin login returning a 403?
Agent:  [debugger_set_breakpoint] auth.service.ts:151  condition: email === "admin@test.com"
        [debugger_state]   → paused, locals: { user, isMatch: false }
        [debugger_eval]    → user.role  →  "viewer"
        The role is "viewer", not "admin" — bcrypt matched but the role check fails.
```

> 📖 **New here? Start with the [hands-on TUTORIAL](TUTORIAL.md)** — every feature, one running example, pure MCP.

---

## The one idea that matters: one session, both sides

Run a single daemon that owns **both** the Node inspector (`:9229`) and a Chrome tab (`:9222`). Every tool takes an optional `target` — `"backend"` (default) or `"frontend"` — so your agent walks a request end to end without switching tools or processes.

```bash
mypry serve --frontend http://localhost:5173
```

```
# Frontend: catch the outgoing request
debugger_state   { target: "frontend" }   → paused in Login.vue, locals: { body: '{"email":"admin@test.com"}' }
debugger_continue{ target: "frontend" }    → request flies to the backend

# Backend: catch the same request (same session, no target = backend)
debugger_state   {}                        → paused at auth.service.ts:151  (source-mapped from dist/)
debugger_eval    { expr: "user.role" }     → "viewer"
```

No other maintained tool does interactive step-debugging on **both** the frontend and the backend in one session. That's the whole point.

---

## Two ways to debug

mypry gives your agent two complementary modes. Pick per situation:

| Mode | What it does | Use when |
|------|--------------|----------|
| **Interactive** | Pause at a breakpoint; step, eval, inspect the live frame. Blocks until you continue. | You need to deeply inspect **one** execution. |
| **Trace** | Auto-resume at each hit and silently collect a snapshot (file, line, function, locals). The app never pauses. | You want to observe a pattern across **many** executions, or you don't want to freeze a live system. |

```
# Interactive
debugger_set_breakpoint { file: "auth.service.ts", line: 151 }
debugger_state {}                          → paused, full frame
debugger_step_over {}                      → next line, new state
debugger_continue {}

# Trace (non-blocking)
debugger_trace_start { maxBuffer: 100 }    → app keeps running
... 50 requests happen ...
debugger_trace_stop {}                     → { count: 50, hits: [ {locals, timestamp}, ... ] }
```

---

## Feature tour

### Conditional breakpoints

Only pause when it matters — every other execution runs uninterrupted.

```
debugger_set_breakpoint {
  file: "auth.service.ts",
  line: 151,
  condition: "email === 'admin@test.com'"
}
```

### Source maps (TypeScript & Vue), automatically

`state`, `backtrace`, and `source` always show your **original** source, never compiled `dist/*.js`.

| Pipeline | Without mypry | With mypry |
|----------|---------------|------------|
| **tsc** (NestJS) | `dist/auth/auth.service.js:136` | `src/auth/auth.service.ts:151` |
| **Vite** (Vue) | `http://localhost:5173/src/Login.vue?t=123` | `src/Login.vue` |

> Backend needs `"sourceMap": true` in `tsconfig.json`. Vite dev mode emits inline maps automatically.

### Framework-aware values

`eval` returns clean data, not proxy soup:

| Type | What you get back |
|------|-------------------|
| Vue `ref()` | auto-unwrapped `.value` |
| Pinia store | auto-extracted `.$state` |
| `reactive()` proxy | unwrapped via `__v_raw` |
| Circular refs | `[Circular]` (no crash) |

These checks are harmless no-ops for React / Angular / vanilla JS.

### Worker threads

Debug `worker_threads` alongside the main thread — no separate ports, no separate daemons.

```
debugger_workers {}                        → [{ sessionId: "1", title: "metrics" }, ...]
debugger_eval { expr: "workerData", worker: "1" }
```

> `mypry serve` enables `--workers` by default.

### Auto-reconnect

Survives `nodemon`, NestJS `--watch`, and `ts-node-dev` restarts. The CDP socket drops, mypry reconnects (every 2s, up to 40s), and your breakpoints come back. Works across every transport.

### Attach to anything

| Situation | Command |
|-----------|---------|
| App started with `--inspect` | `mypry serve` |
| Standalone script, no flag | `require('mypry')` then call `pry()` |
| Already-running process, no flag | `mypry inject <PID>` (sends `SIGUSR1`) |

---

## Project config (`.mypry.json`)

Drop a `.mypry.json` in your project root. Then `mypry serve` picks it up automatically — zero flags.

```json
{
  "port": 3098,
  "inspect": 9229,
  "frontend": "http://localhost:3001"
}
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `port` | number | `3098` | HTTP API port |
| `inspect` | number | `9229` | Backend V8 inspector port |
| `frontend` | string | — | URL to open in debug Chrome (enables fullstack) |
| `token` | string | — | Bearer token for HTTP auth |
| `workers` | boolean | `true` | Discover worker threads |
| `host` | string | `127.0.0.1` | Inspector host |

CLI flags always take priority over the config file.

```bash
cd ~/my-project        # has .mypry.json with frontend set
mypry serve            # loads config, launches Chrome, connects both
```

---

## MCP setup

Start the daemon once, then add the bridge to your agent. The bridge is a stateless proxy that starts instantly and never blocks the agent's handshake — it talks to the daemon, which owns the CDP connection.

```
AI Agent ── stdio ──▶ mcp-bridge.js ── HTTP ──▶ mypry daemon ── CDP ──▶ your app
```

**Daemon:**

```bash
mypry serve                                          # backend only
mypry serve --frontend http://localhost:5173          # + frontend
mypry serve --port 3099 --inspect 9230               # custom ports
```

**Claude Code** — `~/.claude/mcp.json`:

```json
{
  "mcpServers": {
    "mypry": {
      "command": "node",
      "args": ["./node_modules/mypry/dist/mcp-bridge.js"],
      "env": { "MYPRY_URL": "http://127.0.0.1:3098" }
    }
  }
}
```

**Cursor** — `~/.cursor/mcp.json`: same `mcpServers` block as above.

**Antigravity** — `~/.gemini/config/mcp_config.json`:

```json
{
  "mypry": {
    "command": "node",
    "args": ["./node_modules/mypry/dist/mcp-bridge.js"],
    "env": { "MYPRY_URL": "http://127.0.0.1:3098" }
  }
}
```

> Use an **absolute** path to `mcp-bridge.js` if your agent launches from a different working directory.

### MCP tools

All tools accept an optional `target` (`"frontend"` / `"backend"`) and `worker`.

| Tool | Blocks? | Description |
|------|:------:|-------------|
| `debugger_state` | no | Current pause: file, line, function, locals, source window |
| `debugger_eval` | no | Evaluate JS — paused: frame scope; running: global scope |
| `debugger_continue` | **yes** | Resume until the next breakpoint (30s timeout) |
| `debugger_step_over` / `_into` / `_out` | no | Step; returns the new state |
| `debugger_pause` | no | Force-pause a running process |
| `debugger_set_breakpoint` | no | `file`, `line`, optional `condition` |
| `debugger_remove_breakpoint` / `_list_breakpoints` | no | Manage breakpoints |
| `debugger_backtrace` / `_source` | no | Call stack / full source (source-mapped) |
| `debugger_trace_start` / `_stop` / `_status` | no | Non-blocking trace mode |
| `debugger_workers` | no | List worker-thread sessions |

---

## `mypry watch` — live agent monitor

Open a second terminal to see what your agent is doing in realtime:

```bash
mypry watch
```

```
10:21:03 → frontend eval expr="document.title"
10:21:03 ← frontend = "ServiceHub"
10:21:04 → backend  state
10:21:04 ← backend  running
10:21:04 → backend  eval expr="process.version"
10:21:04 ← backend  = "v24.14.0"
10:21:05 ⏸  paused at validateUser auth.service.ts:151
            locals: emailAddress="admin@test.com", isMatch=true
10:21:06 ▶  resumed
```

Color-coded, timestamped, shows `frontend` vs `backend`. Connects to the daemon's SSE stream — read-only, zero overhead.

---

## HTTP API (for non-MCP agents)

The daemon is plain HTTP under the hood, so any agent or script can drive it directly. The MCP bridge is just a thin proxy over these endpoints.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | `{ ok, connected, status }` |
| `GET` | `/state` · `/backtrace` · `/breakpoints` · `/workers` · `/traces` | Snapshots |
| `GET` | `/events` | **SSE** stream of `paused` / `resumed` / `op` / `op-result` events |
| `POST` | `/command` | One op: `{ op, ...params, target?, worker? }` |
| `POST` | `/batch` | Many ops: `{ ops: [...] }` → `{ results: [...] }` |

```bash
curl -X POST localhost:3098/command -d '{"op":"eval","expr":"users.length"}'
# → {"ok":true,"type":"number","value":3}
```

Add `--token <secret>` to require `Authorization: Bearer <secret>` on every request.

---

## Programmatic API

mypry exports its internals so you can build your own UI, TUI, or integration:

```ts
import {
  CDPClient,        // minimal CDP client over WebSocket, zero deps
  DebuggerSession,  // pause / step / eval / breakpoints / trace
  discoverTargets,  // find Node inspector + Chrome tabs
  matchTarget,
  snapshot,         // build a full state snapshot
  executeOp,        // the shared op dispatch used by every transport
} from 'mypry/core'

const [target] = await discoverTargets('127.0.0.1', 9229)
const cdp = new CDPClient(target.wsUrl)
await cdp.connect()

const session = new DebuggerSession(cdp)
await session.init()

await session.setBreakpoint('auth.service.ts', 151)
await session.waitNextPause()
const locals = await session.getLocals()   // { email, isMatch, ... }
await session.resume()
```

`evalInFrame` auto-unwraps Vue/Pinia reactive objects and handles circular refs.

---

## CLI reference

```
mypry — the interactive full-stack debugger for AI agents

Commands:
  mypry serve [options]   HTTP daemon for AI agents (recommended)
  mypry attach [options]  Interactive REPL debugger
  mypry watch [--port]    Monitor agent activity in realtime
  mypry open [URL]        Launch Chrome with debugger port
  mypry inject <PID>      Enable inspector on a running Node.js process

Serve options (daemon mode):
  --port PORT             HTTP API port (default: 3098)
  --inspect PORT          Backend inspector port (default: 9229)
  --frontend URL          Connect Chrome to URL for fullstack debugging
  --token TOKEN           Bearer token for HTTP auth

Attach options (interactive REPL):
  --port PORT             V8 inspector port (default: 9229)
  --host HOST             Inspector host (default: 127.0.0.1)
  --url WS_URL            Direct WebSocket URL
  --json                  ndjson stdio transport (for embedders)
  --mcp                   Direct MCP on stdio (prefer the daemon + bridge instead)
  --frontend URL          Also launch Chrome for frontend debugging

Config file (.mypry.json in project root):
  {"port": 3098, "frontend": "http://localhost:3001"}

Examples:
  mypry serve                                    # backend daemon on :3098
  mypry serve --frontend http://localhost:3001    # fullstack daemon
  mypry serve --port 3099 --inspect 9229         # custom ports
  mypry watch                                    # monitor agent ops in realtime
  mypry attach                                   # backend REPL
  mypry attach --frontend http://localhost:3001   # REPL + frontend
  mypry open http://localhost:5173                # launch Chrome for debugging
  mypry inject 12345                              # enable inspector on PID
```

---

## Architecture

```
your app                          mypry daemon
────────                          ────────────────────────────────
debugger ─ V8 inspector :9229 ─▶  ┌──────────────────────────────┐
debugger ─ Chrome CDP   :9222 ─▶  │  DebuggerSession             │
pry()    ─ V8 inspector :9229 ─▶  │   ├─ pause / step / eval      │
                                  │   ├─ trace mode (non-block)   │
                                  │   ├─ conditional breakpoints  │
                                  │   ├─ worker threads           │
                                  │   ├─ source maps (.ts/.vue)   │
                                  │   └─ auto-reconnect           │
                                  │                              │
                                  │  Transports: REPL · ndjson ·  │
                                  │  HTTP+SSE · MCP bridge        │
                                  └──────────────────────────────┘

agent ── stdio ──▶ mcp-bridge ── HTTP :3098 ──▶ daemon ── CDP ──▶ app
```

---

## Requirements

- **Node.js ≥ 22**
- **Chrome / Chromium** (only for `--frontend` and `mypry open`)

## License

MIT
