# mypry

Inline debugger for Node.js and the browser. Drop `pry()` anywhere — execution pauses and waits for you.

Built for **AI pair programming**: your agent attaches via MCP or JSON, inspects variables, steps through code, and continues — programmatically.

```
npm install mypry
```

## Quick Start

### 1. Drop `pry()` in your code

```js
const pry = require('mypry')

function handleRequest(req) {
  const users = db.getUsers()
  pry()  // ← execution pauses here, waiting for a client
  return users
}
```

### 2. Attach the debugger

```bash
# Run your app — it blocks at pry()
node server.js

# In another terminal:
mypry attach
```

```
─── server.js:5  handleRequest ───
  3 │ function handleRequest(req) {
  4 │   const users = db.getUsers()
  5 │   pry()
► 6 │   return users
  7 │ }

(mypry) users
=> [{"id": 1, "name": "Alice"}, {"id": 2, "name": "Bob"}]
(mypry) continue
```

That's it. `pry()` opens the V8 inspector and blocks. `mypry attach` connects via CDP and drops you into a REPL at the exact line where `pry()` was called.

## pry() Options

```js
pry()                                    // default port 9229
pry({ port: 9235 })                      // custom port
pry({ message: 'before DB query' })      // log a label when it pauses
pry({ port: 9235, host: '127.0.0.1' })  // custom host + port
```

If you use a custom port, pass `--port` to the CLI:

```bash
mypry attach --port 9235
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

### 1. Add `debugger` in your React / Vue / Svelte code

```tsx
// React
function UserList() {
  const [users, setUsers] = useState([])
  const loadUsers = async () => {
    const data = await fetch('/api/users').then(r => r.json())
    debugger  // ← pauses here when mypry is attached
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
  debugger  // ← pauses here when mypry is attached
})
</script>
```

### 2. Attach with `--chrome`

```bash
mypry attach --chrome                        # auto-detect dev server
mypry attach --chrome http://localhost:5173   # explicit URL
```

Without a URL, mypry scans common dev ports (3000, 5173–5180, 8080, 4200) and opens the first one it finds. If you have multiple servers running, it prompts you to pick.

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

This works for **any framework** — the Vue checks are no-ops for React/Angular/vanilla.

### Fullstack (backend + frontend in one REPL)

If your backend also uses `pry()`, both pause in the same session:

```bash
mypry attach --port 9229 --chrome
```

Click a button → backend pauses → inspect → `continue` → frontend pauses → inspect → `continue`. The REPL labels each pause:

```
━━━ BACKEND ━━━
─── server.js:12  <anon> ───
► 12 │   res.json({ users: result })

(mypry|backend) continue

━━━ FRONTEND ━━━
─── App.tsx:55  loadUsers ───
► 55 │     setUsers(data.users)

(mypry|frontend) continue
```

### Debugger Detection (No-Attach Warning)

Use the timing trick to warn users when no debugger is attached:

```js
const _t = performance.now()
debugger
if (performance.now() - _t < 50) {
  console.warn('[mypry] debugger skipped — no CDP debugger attached')
}
```

If Chrome was launched without `--remote-debugging-port`, the `debugger` statement is a no-op. The timing check detects this and logs a helpful warning.

## Programmatic API (HTTP)

### Start the HTTP server

```bash
# Alongside REPL
mypry attach --http

# Standalone (no REPL, just API)
mypry attach --http-only

# Custom port (default: 3099)
mypry attach --http=4000
```

### Endpoints

#### `GET /health`

```bash
curl http://localhost:3099/health
```
```json
{"ok": true, "connected": true, "status": "paused"}
```

#### `GET /state`

Returns current debugger state — pause location, source context, locals.

```bash
curl http://localhost:3099/state
```
```json
{
  "status": "paused",
  "file": "src/auth/auth.service.ts",
  "line": 152,
  "function": "validateUser",
  "source": "...",
  "locals": {"emailAddress": "alice@example.com", "user": {...}}
}
```

#### `GET /backtrace`

```bash
curl http://localhost:3099/backtrace
```
```json
{
  "frames": [
    {"function": "validateUser", "file": "auth.service.ts", "line": 152},
    {"function": "login", "file": "auth.controller.ts", "line": 34}
  ]
}
```

#### `GET /breakpoints`

```bash
curl http://localhost:3099/breakpoints
```
```json
{
  "breakpoints": [
    {"id": "1", "file": "auth.service.ts", "line": 88}
  ]
}
```

#### `POST /command`

Execute any debugger operation. This is the universal endpoint.

```bash
# Evaluate an expression
curl -X POST http://localhost:3099/command \
  -d '{"op": "eval", "expr": "users.length"}'
# => {"ok": true, "type": "number", "value": 3}

# Continue execution
curl -X POST http://localhost:3099/command \
  -d '{"op": "continue"}'
# => {"status": "paused", "file": "next-file.ts", ...}

# Step over
curl -X POST http://localhost:3099/command \
  -d '{"op": "step_over"}'

# Step into / out
curl -X POST http://localhost:3099/command \
  -d '{"op": "step_into"}'
curl -X POST http://localhost:3099/command \
  -d '{"op": "step_out"}'

# Get locals
curl -X POST http://localhost:3099/command \
  -d '{"op": "locals"}'
# => {"locals": {"req": {...}, "users": [...]}}

# Set a breakpoint
curl -X POST http://localhost:3099/command \
  -d '{"op": "set_breakpoint", "file": "auth.service.ts", "line": 88}'
# => {"ok": true, "id": "1", "file": "auth.service.ts", "line": 88}

# Remove a breakpoint
curl -X POST http://localhost:3099/command \
  -d '{"op": "remove_breakpoint", "id": "1"}'

# Pause a running target
curl -X POST http://localhost:3099/command \
  -d '{"op": "pause"}'

# Get full state
curl -X POST http://localhost:3099/command \
  -d '{"op": "state"}'
```

### Available Operations

| Op | Params | Description |
|----|--------|-------------|
| `state` | — | Current pause location, source, locals |
| `eval` | `expr` | Evaluate expression in paused frame |
| `continue` | — | Resume, returns next pause or `terminated` |
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

### Integration Example (AI Agent)

```typescript
// Agent workflow: inspect a paused backend
const BASE = 'http://localhost:3099'

// 1. Check if paused
const health = await fetch(`${BASE}/health`).then(r => r.json())
if (health.status !== 'paused') {
  console.log('Not paused, nothing to inspect')
  return
}

// 2. Get current state
const state = await fetch(`${BASE}/state`).then(r => r.json())
console.log(`Paused at ${state.file}:${state.line} in ${state.function}`)

// 3. Evaluate variables
const result = await fetch(`${BASE}/command`, {
  method: 'POST',
  body: JSON.stringify({ op: 'eval', expr: 'user.emailAddress' }),
}).then(r => r.json())
console.log(`User: ${result.value}`)

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

Newline-delimited JSON on stdin/stdout. For embedding in AI tools.

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
mypry attach [options]

Connection:
  --port PORT        V8 inspector port (default: 9229)
  --host HOST        Inspector host (default: 127.0.0.1)
  --url WS_URL       Direct WebSocket URL

Transport:
  (default)          Human REPL
  --json             ndjson stdio
  --mcp              MCP server on stdio

Side transport:
  --http[=PORT]      HTTP API server (default: 3099)
  --http-only        HTTP only, no stdio transport

Frontend:
  --chrome [URL]     Launch Chrome with CDP (auto-detects dev server)

  -h, --help         Show help
```

## Architecture

```
Your Code                    mypry CLI
─────────                    ─────────
                             ┌──────────────────┐
  pry()  ─── V8 Inspector ──→│  DebuggerSession  │
  (Node)     (CDP)           │                    │
                             │  ┌──── REPL        │
  debugger ─ Chrome CDP ────→│  ├──── JSON        │
  (Browser)                  │  ├──── MCP         │
                             │  └──── HTTP API    │
                             └──────────────────┘
```

| Module | Purpose |
|--------|---------|
| `src/pry.ts` | Node.js `pry()` — opens inspector, fires `debugger` |
| `src/browser.ts` | Browser `pry()` — fires `debugger` for Chrome CDP |
| `src/core/session.ts` | Debugger session — pause, step, eval, breakpoints |
| `src/core/cdp-client.ts` | Raw WebSocket CDP client |
| `src/core/ops.ts` | Shared operation dispatch (used by all transports) |
| `src/core/targets.ts` | Target discovery |
| `src/core/snapshot.ts` | State snapshot builder |
| `src/transports/repl.ts` | Human REPL |
| `src/transports/ndjson.ts` | JSON stdio transport |
| `src/transports/mcp.ts` | MCP server transport |
| `src/transports/http.ts` | HTTP REST API transport |
| `src/cli.ts` | CLI entry point |

## Requirements

- Node.js ≥ 22
- Chrome (for `--chrome`)

## License

MIT
