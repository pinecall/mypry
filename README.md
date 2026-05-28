# mypry

Inline debugger for Node.js and the browser — zero config, zero imports.

Drop a `debugger` statement anywhere. mypry connects via Chrome DevTools Protocol and drops you into a REPL at the exact pause point. Built for **AI pair programming**: agents attach via HTTP, MCP, or JSON to inspect, step, and continue — programmatically.

```
npm install mypry
```

> **📖 [Deep Dive Tutorial](TUTORIAL.md)** — hands-on walkthrough of every feature with a running example.

## Quick Start

### Zero-import mode (recommended)

Just use the native `debugger` statement — no imports needed:

```js
// server.js
function handleRequest(req) {
  const users = db.getUsers()
  debugger  // ← pauses here when mypry is attached
  return users
}
```

```bash
# Start your app with --inspect
node --inspect server.js

# In another terminal:
mypry attach
```

```
─── server.js:4  handleRequest ───
  2 │ function handleRequest(req) {
  3 │   const users = db.getUsers()
► 4 │   debugger
  5 │   return users
  6 │ }

(mypry) users
=> [{"id": 1, "name": "Alice"}, {"id": 2, "name": "Bob"}]
(mypry) continue
```

> **How it works:** `node --inspect` opens the V8 inspector on port 9229. `mypry attach` connects via CDP, enables `Debugger.enable()`, and any `debugger` statement pauses execution. No library import needed.

### pry() mode (standalone scripts)

If your app doesn't start with `--inspect`, use `pry()` to open the inspector dynamically:

```js
const pry = require('mypry')

function handleRequest(req) {
  const users = db.getUsers()
  pry()  // opens inspector AND pauses — blocks until a client connects
  return users
}
```

```bash
node server.js        # no --inspect needed, pry() handles it
mypry attach          # connects to the inspector pry() opened
```

### When to use which

| Mode | Use when | Import needed | App flag needed |
|------|----------|---------------|-----------------|
| `debugger` | App starts with `--inspect` / `--debug` | No | `--inspect` |
| `pry()` | Standalone scripts, no inspector flag | `require('mypry')` | None |

## pry() Options

```js
pry()                                    // default port 9229
pry({ port: 9235 })                      // custom port
pry({ message: 'before DB query' })      // log a label when it pauses
pry({ port: 9235, host: '127.0.0.1' })  // custom host + port
```

## REPL Commands

| Command | Alias | Description |
|---------|-------|-------------|
| `continue` | `c` | Resume execution |
| `next` | `n` | Step over |
| `step` | `s` | Step into |
| `out` | `o` | Step out |
| `list` | `l` | Show source context (wider) |
| `locals` | — | Show all local variables |
| `backtrace` | `bt`, `where` | Show call stack |
| `break file:line` | `b` | Set a breakpoint |
| `breakpoints` | `bl` | List breakpoints |
| `delete N` | `del` | Remove breakpoint |
| `pause` | — | Pause a running target |
| `quit` | `q` | Disconnect |
| *anything else* | — | Evaluate in current frame |

## Frontend Debugging

### 1. Add `debugger` in your component

```tsx
// React
function UserList() {
  const [users, setUsers] = useState([])
  const loadUsers = async () => {
    const data = await fetch('/api/users').then(r => r.json())
    debugger  // ← pauses here when Chrome debug is attached
    setUsers(data)
  }
  return <button onClick={loadUsers}>Load</button>
}
```

```vue
<!-- Vue -->
<script setup>
onMounted(async () => {
  await store.loadUsers()
  debugger  // ← pauses here when Chrome debug is attached
})
</script>
```

### 2. Open Chrome with debug port

```bash
mypry open                          # auto-detect dev server, launch Chrome
mypry open http://localhost:5173    # explicit URL
```

This launches Chrome with `--remote-debugging-port=9222`. Any `debugger` statement in the page will pause when mypry attaches.

### 3. Attach

```bash
mypry attach --chrome    # connects to both backend (9229) and Chrome (9222)
```

When a frontend `debugger` fires, the REPL shows your component code:

```
━━━ FRONTEND ━━━
─── Dashboard.vue:78  onMounted ───
  76 │   await store.loadData()
  77 │   const debugInfo = { user: authStore.user }
► 78 │   debugger
  79 │   renderDashboard()

(mypry|frontend) debugInfo
=> {"user": {"name": "Alice", "role": "admin"}}
(mypry|frontend) continue
```

### Vue / Pinia Smart Serialization

mypry automatically handles Vue reactive objects and Pinia stores:

| Object Type | What mypry does |
|-------------|-----------------|
| Vue `ref()` | Auto-unwraps `.value` |
| Pinia store | Auto-extracts `.$state` |
| `reactive()` proxy | Unwraps via `__v_raw` |
| Circular refs | Marked as `[Circular]` |
| Functions | Shown as `[Function: name]` |

This works for **any framework** — the Vue/Pinia checks are harmless no-ops for React/Angular/vanilla JS.

### Fullstack (backend + frontend in one REPL)

```bash
mypry attach --chrome
```

Click a button → backend pauses → inspect → `continue` → frontend pauses → inspect → `continue`. The REPL labels each pause:

```
━━━ BACKEND ━━━
─── auth.service.ts:152  validateUser ───
► 152 │   debugger

(mypry|backend) user.emailAddress
=> "alice@example.com"
(mypry|backend) continue

━━━ FRONTEND ━━━
─── Dashboard.vue:78  onMounted ───
► 78 │   debugger

(mypry|frontend) authStore
=> {"user": {"name": "Alice"}, "isAdmin": true}
(mypry|frontend) continue
```

## Auto-Reconnect

mypry survives process restarts. When the backend restarts (nodemon, NestJS `--watch`, ts-node-dev), the CDP WebSocket closes and mypry automatically reconnects:

```
[mypry] backend disconnected — reconnecting...
[mypry] ✅ backend reconnected
```

No manual intervention needed. Retries every 2s for up to 20 attempts (40s window). Works for all modes: REPL, JSON, MCP, HTTP.

### Debugger Detection (No-Attach Warning)

Use the timing trick to warn when no debugger is attached:

```js
const _t = performance.now()
debugger
if (performance.now() - _t < 50) {
  console.warn('debugger skipped — no CDP debugger attached')
}
```

If Chrome was launched without `--remote-debugging-port`, the `debugger` statement is a no-op (takes <1ms). The timing check detects this and logs a warning.

## Conditional Breakpoints

Set breakpoints that only pause when a condition is true:

```bash
curl -X POST localhost:3099/command -d '{
  "op": "set_breakpoint",
  "file": "auth.service.ts",
  "line": 136,
  "condition": "emailAddress === \"admin@test.com\""
}'
# Only pauses when emailAddress is admin — other logins continue uninterrupted
```

In the REPL:
```
(mypry) break auth.service.ts:136 emailAddress === "admin@test.com"
```

## Trace Mode (Non-Blocking Observation)

Observe breakpoint hits without interrupting execution. The app keeps running while mypry silently collects snapshots.

```bash
# 1. Set breakpoints on the code you want to observe
curl -X POST localhost:3099/command -d '{"op":"set_breakpoint","file":"auth.service.ts","line":136}'

# 2. Start tracing
curl -X POST localhost:3099/command -d '{"op":"trace_start","maxBuffer":100}'

# 3. Let the app run normally... users keep logging in...

# 4. Stop and collect results
curl -X POST localhost:3099/command -d '{"op":"trace_stop"}'
# → {"ok":true, "count":5, "hits":[
#     {"timestamp":1779905774582, "file":"auth.service.ts", "line":136,
#      "function":"validateUser", "locals":{"emailAddress":"alice@test.com","isMatch":true}},
#     {"timestamp":1779905774588, "file":"auth.service.ts", "line":136,
#      "function":"validateUser", "locals":{"emailAddress":"bob@test.com","isMatch":false}},
#     ...
#   ]}
```

SSE clients receive `trace` events in real-time during tracing:
```
event: trace
data: {"timestamp":1779905774582,"file":"auth.service.ts","line":136,...}
```

## Worker Threads

Debug `worker_threads` alongside the main thread:

```bash
mypry attach --workers --http-only   # discover and attach to all workers
```

```bash
# List workers
curl localhost:3099/workers
# → {"workers":[{"sessionId":"1","title":"[worker 1] WorkerThread"}], "count":1}

# Command a specific worker
curl -X POST localhost:3099/command -d '{"op":"state","worker":"1"}'
curl -X POST localhost:3099/command -d '{"op":"eval","expr":"workerData","worker":"1"}'
curl -X POST localhost:3099/command -d '{"op":"continue","worker":"1"}'
```

Workers use the `NodeWorker` CDP domain — they don't get separate ports. mypry creates a `WorkerCDPProxy` that routes commands through the parent session transparently.

## Inject PID

Attach to a running Node.js process that wasn't started with `--inspect`:

```bash
# Your app is running without --inspect
node server.js  # PID 12345

# Enable inspector via SIGUSR1 and attach
mypry inject 12345
```

This sends `SIGUSR1` to the process, which enables the V8 inspector on port 9229. Then mypry auto-attaches.

## HTTP API

Start with any transport or standalone:

```bash
mypry attach --http              # alongside REPL
mypry attach --http-only         # standalone API (no REPL)
mypry attach --http=4000         # custom port (default: 3099)
mypry attach --http --token s3cr3t  # with bearer auth
```

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | `{ok, connected, status}` |
| GET | `/state` | Full paused state snapshot |
| GET | `/backtrace` | Call stack frames |
| GET | `/breakpoints` | Active breakpoints |
| GET | `/workers` | List worker thread sessions |
| GET | `/traces` | Current trace buffer |
| GET | `/events` | **SSE stream** — real-time events (no polling) |
| POST | `/command` | Single op: `{op, ...params}` (optional `worker` field to target worker) |
| POST | `/batch` | Multiple ops: `{ops: [{op, ...}, ...]}` → `{results: [...]}` |

### Endpoint Examples

#### `GET /health`

```json
{"ok": true, "connected": true, "status": "paused"}
```

#### `GET /state`

```json
{
  "status": "paused",
  "file": "auth.service.ts",
  "line": 152,
  "function": "validateUser",
  "source_window": [
    {"line": 150, "text": "  const user = await this.usersService.findOne(email)", "current": false},
    {"line": 151, "text": "  const isMatch = await bcrypt.compare(pass, user.password)", "current": false},
    {"line": 152, "text": "  debugger", "current": true},
    {"line": 153, "text": "  return user", "current": false}
  ],
  "locals": {"emailAddress": "alice@test.com", "isMatch": true, "user": "User"}
}
```

#### `POST /command`

```bash
# Evaluate
curl -X POST localhost:3099/command -d '{"op":"eval","expr":"users.length"}'
# → {"ok":true,"type":"number","value":3}

# Continue (returns immediately — non-blocking)
curl -X POST localhost:3099/command -d '{"op":"continue"}'
# → {"status":"running"}

# Step over / into / out
curl -X POST localhost:3099/command -d '{"op":"step_over"}'
curl -X POST localhost:3099/command -d '{"op":"step_into"}'
curl -X POST localhost:3099/command -d '{"op":"step_out"}'

# Locals / Backtrace
curl -X POST localhost:3099/command -d '{"op":"locals"}'
curl -X POST localhost:3099/command -d '{"op":"backtrace"}'

# Breakpoints
curl -X POST localhost:3099/command -d '{"op":"set_breakpoint","file":"auth.service.ts","line":88}'
curl -X POST localhost:3099/command -d '{"op":"remove_breakpoint","id":"1"}'
curl -X POST localhost:3099/command -d '{"op":"breakpoints"}'
```

#### `POST /batch` — Multiple ops in one call

```bash
curl -X POST localhost:3099/batch -d '{
  "ops": [
    {"op": "eval", "expr": "user.email"},
    {"op": "eval", "expr": "user.role"},
    {"op": "eval", "expr": "request.body"},
    {"op": "locals"},
    {"op": "continue"}
  ]
}'
# → {"results": [
#     {"ok":true,"value":"alice@test.com"},
#     {"ok":true,"value":"admin"},
#     {"ok":true,"value":{"action":"login"}},
#     {"locals":{"email":"alice@test.com","isMatch":true}},
#     {"status":"running"}
#   ]}
```

#### `GET /events` — SSE (Server-Sent Events)

Real-time stream. No polling. On connect, sends current state immediately:

```bash
curl -N localhost:3099/events
# event: paused
# data: {"status":"paused","file":"auth.service.ts","line":136,...}
#
# event: resumed
# data: {"status":"running"}
#
# event: disconnected
# data: {"status":"disconnected"}
```

### Authentication

When `--token` is set, all requests require `Authorization: Bearer <token>`:

```bash
# No token → 401
curl localhost:3099/health
# → {"error":"Unauthorized — Bearer token required"}

# With token → 200
curl -H "Authorization: Bearer s3cr3t" localhost:3099/health
# → {"ok":true,"connected":true,"status":"paused"}
```

### Operations Reference

| Op | Params | Description |
|----|--------|-------------|
| `state` | — | Current pause location, source, locals |
| `eval` | `expr` | Evaluate expression in paused frame |
| `continue` | — | Resume execution (returns immediately) |
| `step_over` | — | Step to next line |
| `step_into` | — | Step into function call |
| `step_out` | — | Step out of current function |
| `locals` | — | All local variables |
| `backtrace` | — | Call stack frames |
| `source` | — | Current file source + line |
| `set_breakpoint` | `file`, `line`, `condition?` | Set breakpoint (with optional condition expression) |
| `remove_breakpoint` | `id` | Remove by ID |
| `breakpoints` | — | List active breakpoints |
| `pause` | — | Force pause on running target |
| `trace_start` | `maxBuffer?` | Start trace mode — auto-resume and collect snapshots |
| `trace_stop` | — | Stop trace, return all collected hits |
| `trace_status` | — | Current trace buffer without stopping |
| `quit` | — | Disconnect |

### Agent Integration Example

```typescript
const BASE = 'http://localhost:3099'
const headers = { 'Authorization': 'Bearer s3cr3t' }

// Option A: Poll health
const health = await fetch(`${BASE}/health`, { headers }).then(r => r.json())

// Option B: SSE (no polling)
const events = new EventSource(`${BASE}/events`)
events.addEventListener('paused', (e) => {
  const state = JSON.parse(e.data)
  console.log(`Paused at ${state.file}:${state.line}`)
})

// Option C: Batch — eval + continue in one call
const { results } = await fetch(`${BASE}/batch`, {
  method: 'POST',
  headers: { ...headers, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    ops: [
      { op: 'eval', expr: 'user.emailAddress' },
      { op: 'eval', expr: 'request.body' },
      { op: 'locals' },
      { op: 'continue' },
    ]
  }),
}).then(r => r.json())
```

## Programmatic API (Core Exports)

mypry exports its internals for embedders — build your own debugger UI, TUI, or agent integration:

```typescript
import {
  CDPClient,
  DebuggerSession,
  snapshot,
  discoverTargets,
  matchTarget,
  executeOp,
} from 'mypry/core'
```

### CDPClient

Minimal Chrome DevTools Protocol client over WebSocket. Zero dependencies.

```typescript
const cdp = new CDPClient('ws://127.0.0.1:9229/...')
await cdp.connect()

// Send CDP commands
await cdp.send('Debugger.enable')
await cdp.send('Debugger.resume')

// Listen for events
cdp.on('Debugger.paused', (params) => { /* ... */ })
cdp.on('Debugger.resumed', () => { /* ... */ })
cdp.onClose(() => { /* reconnect logic */ })
```

### DebuggerSession

Manages a CDP debugging session — pause, step, eval, breakpoints.

```typescript
const session = new DebuggerSession(cdp)
await session.init()

// Evaluate in the paused frame (handles Vue/Pinia reactive objects)
const result = await session.evalInFrame('user.emailAddress')
// → { result: { type: 'string', value: 'alice@test.com' } }

// Get all local variables
const locals = await session.getLocals()
// → { emailAddress: 'alice@test.com', isMatch: true }

// Stepping
await session.stepOver()
await session.stepInto()
await session.stepOut()

// Resume (returns immediately — non-blocking)
await session.resume()

// Set/remove breakpoints
const bpId = await session.setBreakpoint('auth.service.ts', 42)
await session.removeBreakpoint(bpId)

// Wait for next pause
await session.waitNextPause()

// Pause a running target
await session.pause()
```

**Smart serialization:** `evalInFrame` auto-unwraps Vue `ref()`, Pinia `$state`,
and `reactive()` proxies. Handles circular references safely.

### Target Discovery

```typescript
// Find Node.js inspector targets
const nodeTargets = await discoverTargets('127.0.0.1', 9229)
// → [{ kind: 'node', wsUrl: 'ws://...', title: 'server.js' }]

// Find Chrome tabs
const chromeTargets = await discoverTargets('127.0.0.1', 9222)
// → [{ kind: 'chrome', wsUrl: 'ws://...', title: 'MyApp', url: 'http://localhost:3001' }]

// Match by tab title or URL
const tab = matchTarget(chromeTargets, { tabUrl: 'localhost:3001' })
```

### executeOp

Shared operation dispatch — same ops used by all transports:

```typescript
const result = await executeOp(session, 'eval', { expr: 'users.length' })
// → { ok: true, type: 'number', value: 42 }

await executeOp(session, 'continue')
// → { status: 'running' }

await executeOp(session, 'step_over')
// → { status: 'paused', file: '...', line: 43, ... }
```

All ops: `state`, `eval`, `continue`, `step_over`, `step_into`, `step_out`,
`locals`, `backtrace`, `source`, `set_breakpoint`, `remove_breakpoint`,
`breakpoints`, `pause`, `quit`.

### snapshot

Build a full state snapshot from a session:

```typescript
const snap = await snapshot(session)
// When paused:
// → { status: 'paused', file: 'auth.service.ts', line: 152,
//     function: 'validateUser', source_window: [...], locals: {...} }
// When running:
// → { status: 'running' }
```

### Multi-Session Example (Backend + Frontend)

```typescript
import { CDPClient, DebuggerSession, discoverTargets, snapshot } from 'mypry/core'

// Connect backend (Node.js inspector)
const backendTargets = await discoverTargets('127.0.0.1', 9229)
const backendCdp = new CDPClient(backendTargets[0].wsUrl)
await backendCdp.connect()
const backend = new DebuggerSession(backendCdp)
await backend.init()

// Connect frontend (Chrome CDP)
const chromeTargets = await discoverTargets('127.0.0.1', 9222)
const chromeCdp = new CDPClient(chromeTargets[0].wsUrl)
await chromeCdp.connect()
const frontend = new DebuggerSession(chromeCdp)
await frontend.init()

// Listen for pauses on either side
let activeSession = backend

backendCdp.on('Debugger.paused', async () => {
  activeSession = backend
  console.log('BACKEND paused:', await snapshot(backend))
})

chromeCdp.on('Debugger.paused', async () => {
  activeSession = frontend
  console.log('FRONTEND paused:', await snapshot(frontend))
})

// Auto-reconnect backend on restart
backendCdp.onClose(() => {
  console.log('Backend disconnected — reconnecting...')
  // ... retry logic
})
```

## AI Agent Modes

### JSON (ndjson stdio)

```bash
mypry attach --json
```

Newline-delimited JSON on stdin/stdout:

```json
→ {"op":"eval","expr":"users.length"}
← {"ok":true,"type":"number","value":3}

→ {"op":"continue"}
← {"status":"running"}

→ {"op":"state"}
← {"status":"paused","file":"server.js","line":42,"locals":{...}}
```

### MCP (Model Context Protocol)

mypry uses a **daemon + bridge** architecture for MCP:

```
AI Agent → (stdio) → MCP Bridge → (HTTP) → mypry daemon → (CDP) → Node.js
```

- **MCP Bridge** (`mcp-bridge.js`) — stateless proxy, starts instantly, never blocks
- **mypry daemon** (`mypry attach --http-only`) — connects to V8 inspector, manages CDP

#### 1. Start the daemon

```bash
# Standalone (default port 3098)
mypry attach --http-only --port 9229 --http=3098 --workers

# For Aurora TUI (already runs on :3099)
# No extra daemon needed — set MYPRY_URL instead
```

#### 2. Configure the bridge

**Antigravity** (`~/.gemini/config/mcp_config.json`):
```json
{
  "mypry": {
    "command": "node",
    "args": ["/path/to/mypry/dist/mcp-bridge.js"]
  }
}
```

**Claude Code** (`~/.claude/mcp.json`):
```json
{
  "mcpServers": {
    "mypry": {
      "command": "node",
      "args": ["/path/to/mypry/dist/mcp-bridge.js"]
    }
  }
}
```

**Aurora TUI** — set `MYPRY_URL` to point at Aurora's API:
```json
{
  "mypry": {
    "command": "node",
    "args": ["/path/to/mypry/dist/mcp-bridge.js"],
    "env": { "MYPRY_URL": "http://127.0.0.1:3099/api/debugger" }
  }
}
```

#### MCP Tools

| Tool | Description |
|------|-------------|
| `debugger_state` | Current pause: file (.ts via source maps), line, function, locals, source window |
| `debugger_eval` | Evaluate JS — paused: frame scope; running: global scope |
| `debugger_continue` | Resume — **blocks** until next breakpoint |
| `debugger_step_over` | Step to next line, returns new state |
| `debugger_step_into` | Step into function call |
| `debugger_step_out` | Step out of current function |
| `debugger_pause` | Force-pause a running process |
| `debugger_set_breakpoint` | Set breakpoint with optional `condition` expression |
| `debugger_remove_breakpoint` | Remove breakpoint by ID |
| `debugger_list_breakpoints` | List all active breakpoints |
| `debugger_backtrace` | Call stack frames |
| `debugger_source` | Full source of current file |
| `debugger_trace_start` | Start trace mode — auto-resume, collect snapshots |
| `debugger_trace_stop` | Stop trace, return all collected hits |
| `debugger_trace_status` | Peek at trace buffer without stopping |
| `debugger_workers` | List worker threads with session IDs |

### Web UI

A ready-to-use web debugger UI is included:

```bash
# 1. Start target
node --inspect examples/tutorial-server.cjs

# 2. Start daemon
mypry attach --http-only --http=3098 --workers

# 3. Open the UI
open examples/web-debugger.html
```

The web UI connects to the daemon's HTTP API and SSE stream. Use it as a starting point for building custom debugger UIs (like Aurora's TUI, but for the browser).

Features: source view with current-line highlighting, locals panel, call stack, breakpoint management, step/continue/pause controls, eval bar, and live SSE updates.

### Source Maps

mypry automatically resolves source maps for TypeScript projects:

- `dist/auth/auth.service.js:136` → `src/auth/auth.service.ts:151`
- Source window shows original TypeScript source, not compiled JS
- Requires `"sourceMap": true` in `tsconfig.json`

### Frontend Debugging (Chrome CDP)

```bash
# Start Chrome with debug port
mypry open http://localhost:3001

# Start daemon pointing to Chrome
mypry attach --http-only --port 9222 --http=3097
```

`debugger_eval` works without pausing (uses `Runtime.evaluate`):
```
→ debugger_eval {"expr": "document.title"}
← {"ok": true, "value": "MyApp"}
```

Install interceptors to catch specific requests:
```
→ debugger_eval {"expr": "...XMLHttpRequest.prototype.send = function(body) { if (this._url.includes('/auth/')) { debugger; } ... }"}
→ (user clicks login)
→ debugger_state {} → paused at XMLHttpRequest.send, locals: {body: '{"email":"..."}' }
```


## CLI Reference

```
mypry - inline debugger for Node.js and the browser

Commands:
  mypry attach [options]   Attach to a running process
  mypry open [URL]         Launch Chrome with debugger port
  mypry inject <PID>       Enable inspector on running Node.js process

Attach options:
  --port PORT        V8 inspector port (default: 9229)
  --host HOST        Inspector host (default: 127.0.0.1)
  --url WS_URL       Direct WebSocket URL
  --json             ndjson stdio transport
  --mcp              MCP server on stdio (direct, blocks on connect)
  --http[=PORT]      HTTP API server (default: 3099)
  --http-only        HTTP only, no stdio transport (daemon mode)
  --token TOKEN      Bearer token for HTTP auth (or 'tok1:rw,tok2:ro')
  --workers          Discover and attach to worker threads
  --chrome           Also launch Chrome for frontend debugging

Examples:
  mypry open                                  # launch Chrome debug
  mypry open http://localhost:5173            # explicit dev server
  mypry attach                               # backend REPL
  mypry attach --chrome                      # backend + frontend
  mypry attach --json                        # ndjson for embedders
  mypry attach --http-only --http=3098       # daemon mode (for MCP bridge)
  mypry attach --http-only --workers         # daemon + workers
  mypry attach --http --token admin:rw,ro:ro # multi-token auth
  mypry inject 12345                         # inject into running process
```

## Architecture

```
Your Code                    mypry
─────────                    ─────
                             ┌──────────────────────────────┐
  debugger ── V8 Inspector ──│                              │
  (Node)      (port 9229)   │   DebuggerSession             │
                             │   ├── pause/step/eval         │
  debugger ── Chrome CDP ───│   ├── trace mode (non-block)   │
  (Browser)   (port 9222)   │   ├── conditional breakpoints  │
                             │   ├── worker thread debugging  │
  pry()  ─── V8 Inspector ──│   └── auto-reconnect ♻️       │
  (standalone)               │                              │
                             │   Transports:                 │
                             │   ├── REPL (terminal)         │
                             │   ├── JSON (ndjson stdio)     │
                             │   ├── HTTP (REST + SSE)       │
                             │   └── MCP Bridge → HTTP       │
                             │                              │
                             │   Core (importable):          │
                             │   ├── CDPClient               │
                             │   ├── DebuggerSession          │
                             │   ├── snapshot / executeOp     │
                             │   └── discoverTargets          │
                             └──────────────────────────────┘

AI Agent Integration:
  ┌──────────┐  stdio   ┌───────────┐  HTTP   ┌────────────┐   CDP    ┌─────────┐
  │ Claude   │─────────│ MCP Bridge │────────│ mypry      │────────│ Node.js │
  │ Antigrav │          │ (instant)  │ :3098  │ daemon     │ :9229  │ process │
  │ Cursor   │          │ stateless  │        │ --http-only│        │ --inspect│
  └──────────┘          └───────────┘         └────────────┘        └─────────┘
```

| Module | Purpose |
|--------|---------|
| `src/pry.ts` | `pry()` — opens inspector dynamically, fires `debugger` |
| `src/browser.ts` | Browser `pry()` — fires `debugger` for Chrome CDP |
| `src/core/session.ts` | Debugger session — pause, step, eval, trace, serialization |
| `src/core/cdp-client.ts` | Raw WebSocket CDP client + `WorkerCDPProxy` |
| `src/core/ops.ts` | Shared operation dispatch (used by all transports) |
| `src/core/targets.ts` | Target discovery (Node inspector + Chrome tabs) |
| `src/core/snapshot.ts` | State snapshot builder |
| `src/core/sourcemap.ts` | Source map resolution for TypeScript |
| `src/transports/repl.ts` | Human REPL with ANSI colors |
| `src/transports/ndjson.ts` | JSON stdio transport |
| `src/transports/mcp.ts` | MCP server (direct, for `--mcp` flag) |
| `src/transports/http.ts` | HTTP REST API + SSE + batch + auth + workers |
| `src/mcp-bridge.ts` | Stateless MCP→HTTP bridge (for daemon architecture) |
| `src/cli.ts` | CLI entry — `attach`, `open`, `inject`, auto-reconnect |

## Requirements

- Node.js ≥ 22
- Chrome or Chromium (for `--chrome` / `open`)

## License

MIT
