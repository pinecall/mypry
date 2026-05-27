# mypry

Inline debugger for Node.js and the browser — zero config, zero imports.

Drop a `debugger` statement anywhere. mypry connects via Chrome DevTools Protocol and drops you into a REPL at the exact pause point. Built for **AI pair programming**: agents attach via HTTP, MCP, or JSON to inspect, step, and continue — programmatically.

```
npm install mypry
```

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

## Programmatic API (HTTP)

### Start the HTTP server

```bash
mypry attach --http              # alongside REPL
mypry attach --http-only         # standalone API (no REPL)
mypry attach --http=4000         # custom port (default: 3099)
```

### Endpoints

#### `GET /health`

```bash
curl localhost:3099/health
```
```json
{"ok": true, "connected": true, "status": "paused"}
```

#### `GET /state`

```bash
curl localhost:3099/state
```
```json
{
  "status": "paused",
  "file": "auth.service.ts",
  "line": 152,
  "function": "validateUser",
  "locals": {"emailAddress": "alice@example.com", "user": {...}}
}
```

#### `GET /backtrace`

```json
{
  "frames": [
    {"function": "validateUser", "file": "auth.service.ts", "line": 152},
    {"function": "login", "file": "auth.controller.ts", "line": 34}
  ]
}
```

#### `POST /command`

Universal endpoint for all debugger operations:

```bash
# Evaluate
curl -X POST localhost:3099/command -d '{"op":"eval","expr":"users.length"}'
# => {"ok":true,"value":3}

# Continue
curl -X POST localhost:3099/command -d '{"op":"continue"}'

# Step over / into / out
curl -X POST localhost:3099/command -d '{"op":"step_over"}'
curl -X POST localhost:3099/command -d '{"op":"step_into"}'
curl -X POST localhost:3099/command -d '{"op":"step_out"}'

# Locals
curl -X POST localhost:3099/command -d '{"op":"locals"}'

# Breakpoints
curl -X POST localhost:3099/command \
  -d '{"op":"set_breakpoint","file":"auth.service.ts","line":88}'
curl -X POST localhost:3099/command -d '{"op":"remove_breakpoint","id":"1"}'
curl -X POST localhost:3099/command -d '{"op":"breakpoints"}'

# Pause / State
curl -X POST localhost:3099/command -d '{"op":"pause"}'
curl -X POST localhost:3099/command -d '{"op":"state"}'
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
| `set_breakpoint` | `file`, `line`, `condition?` | Set breakpoint |
| `remove_breakpoint` | `id` | Remove by ID |
| `breakpoints` | — | List active breakpoints |
| `pause` | — | Force pause on running target |
| `quit` | — | Disconnect |

### Agent Integration Example

```typescript
const BASE = 'http://localhost:3099'

// 1. Check if paused
const health = await fetch(`${BASE}/health`).then(r => r.json())
if (health.status !== 'paused') return

// 2. Inspect
const state = await fetch(`${BASE}/state`).then(r => r.json())
console.log(`Paused at ${state.file}:${state.line}`)

// 3. Evaluate
const result = await fetch(`${BASE}/command`, {
  method: 'POST',
  body: JSON.stringify({ op: 'eval', expr: 'user.emailAddress' }),
}).then(r => r.json())

// 4. Continue
await fetch(`${BASE}/command`, {
  method: 'POST',
  body: JSON.stringify({ op: 'continue' }),
})
```

## AI Agent Modes

### JSON (ndjson stdio)

```bash
mypry attach --json
```

Newline-delimited JSON on stdin/stdout:

```json
→ {"action":"eval","expression":"users.length"}
← {"ok":true,"value":3}

→ {"action":"continue"}
← {"ok":true,"running":true}
```

### MCP (Model Context Protocol)

```bash
mypry attach --mcp
```

MCP server on stdio — plug into Claude Code, Cursor, or any MCP client.

| Tool | Description |
|------|-------------|
| `get_state` | Current pause location, source, and locals |
| `eval` | Evaluate expression in current frame |
| `step_over` / `step_into` / `step_out` | Stepping |
| `continue` | Resume |
| `set_breakpoint` / `remove_breakpoint` | Breakpoint management |
| `get_snapshot` | Full state snapshot |

## CLI Reference

```
mypry - inline debugger for Node.js and the browser

Commands:
  mypry attach [options]   Attach to a running process
  mypry open [URL]         Launch Chrome with debugger port

Attach options:
  --port PORT        V8 inspector port (default: 9229)
  --host HOST        Inspector host (default: 127.0.0.1)
  --url WS_URL       Direct WebSocket URL
  --json             ndjson stdio transport
  --mcp              MCP server on stdio
  --http[=PORT]      HTTP API server (default: 3099)
  --http-only        HTTP only, no stdio transport
  --chrome           Also launch Chrome for frontend debugging

Examples:
  mypry open                                  # launch Chrome debug
  mypry open http://localhost:5173            # explicit dev server
  mypry attach                               # backend REPL
  mypry attach --chrome                      # backend + frontend
  mypry attach --json                        # ndjson for embedders
  mypry attach --mcp                         # MCP for Claude Code
  mypry attach --http-only                   # headless API
```

## Architecture

```
Your Code                    mypry CLI
─────────                    ─────────
                             ┌──────────────────────┐
  debugger ── V8 Inspector ──→│                      │
  (Node)      (port 9229)    │   DebuggerSession     │
                             │                      │
  debugger ── Chrome CDP ───→│   ┌──── REPL          │
  (Browser)   (port 9222)    │   ├──── JSON (ndjson) │
                             │   ├──── MCP           │
  pry()  ─── V8 Inspector ──→│   └──── HTTP API      │
  (standalone)               │                      │
                             │   Auto-reconnect ♻️    │
                             └──────────────────────┘
```

| Module | Purpose |
|--------|---------|
| `src/pry.ts` | `pry()` — opens inspector dynamically, fires `debugger` |
| `src/browser.ts` | Browser `pry()` — fires `debugger` for Chrome CDP |
| `src/core/session.ts` | Debugger session — pause, step, eval, smart serialization |
| `src/core/cdp-client.ts` | Raw WebSocket CDP client |
| `src/core/ops.ts` | Shared operation dispatch (used by all transports) |
| `src/core/targets.ts` | Target discovery (Node inspector + Chrome tabs) |
| `src/core/snapshot.ts` | State snapshot builder |
| `src/transports/repl.ts` | Human REPL with ANSI colors |
| `src/transports/ndjson.ts` | JSON stdio transport |
| `src/transports/mcp.ts` | MCP server transport |
| `src/transports/http.ts` | HTTP REST API transport |
| `src/cli.ts` | CLI entry — `attach`, `open`, auto-reconnect |

## Requirements

- Node.js ≥ 22
- Chrome or Chromium (for `--chrome` / `open`)

## License

MIT
