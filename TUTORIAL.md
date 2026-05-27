# mypry Deep Dive Tutorial

> **mypry** is a zero-dependency, zero-config debugger for Node.js and the browser.
> Drop `debugger` in your code. Attach mypry. Step through, eval, inspect — from a REPL, HTTP API, MCP (for Claude/Cursor), or your own tooling.

This tutorial walks through every feature using a single example server.

---

## Setup

```bash
git clone <mypry-repo>
cd mypry
npm install && npm run build
npm link  # makes 'mypry' available globally
```

---

## The Example Server

We'll use `examples/tutorial-server.cjs` — a tiny HTTP API with:

- **5 users** (Alice, Bob, Admin, Diana, Eve)
- **POST /login** — authenticates users (has a `debugger` statement inside)
- **GET /user/:id** — returns a user by ID
- **GET /stats** — request counter
- **2 background workers** (`metrics` and `health-check`) running on intervals

```
┌─────────────────────────────────────┐
│  tutorial-server.cjs                │
│                                     │
│  Main Thread                        │
│  ├── POST /login ←── debugger ✦    │
│  ├── GET /user/:id                  │
│  └── GET /stats                     │
│                                     │
│  Worker: metrics ←── debugger ✦    │
│  Worker: health-check ←── debugger ✦│
└─────────────────────────────────────┘
```

Start the server with `--inspect` so mypry can attach:

```bash
node --inspect=9231 examples/tutorial-server.cjs
```

In a separate terminal, attach mypry with all features enabled:

```bash
mypry attach --http-only --http=3098 --port 9231 --workers \
  --token "admin:rw,viewer:ro"
```

This single command:
- Connects to the V8 inspector on port 9231
- Discovers and attaches to worker threads (`--workers`)
- Starts an HTTP API on port 3098 (`--http=3098`)
- Enables multi-token auth with `admin` (read-write) and `viewer` (read-only)

You should see:

```
Debugger attached.
[mypry] worker attached: [worker 1] WorkerThread (1)
[mypry] worker attached: [worker 2] WorkerThread (2)
[mypry] HTTP server listening on http://127.0.0.1:3098
```

---

## Feature 1: Basic Debugging (debugger Statement)

The simplest way to use mypry. The server's `authenticate()` function has a `debugger` statement:

```javascript
function authenticate(email, password) {
  requestCount++
  const user = users.find(u => u.email === email)
  const isValid = user && password === 'secret'

  debugger  // ← mypry pauses here

  return isValid ? user : null
}
```

### Trigger a pause

```bash
# Login — this will hit the debugger and PAUSE the server
curl -X POST http://localhost:4444/login \
  -d '{"email":"alice@example.com","password":"secret"}'
# ↑ This hangs because the server is paused at the debugger
```

### Inspect the pause

```bash
# Check state (from another terminal)
curl -H "Authorization: Bearer admin" http://localhost:3098/state
```

```json
{
  "status": "paused",
  "file": "/path/to/examples/tutorial-server.cjs",
  "line": 57,
  "function": "authenticate",
  "locals": {
    "email": "alice@example.com",
    "password": "secret",
    "user": { "id": 1, "name": "Alice", ... },
    "isValid": true
  }
}
```

You can see:
- **Where** you're paused (file, line, function)
- **All local variables** with their values
- **Source code** around the current line

### Evaluate expressions

```bash
curl -H "Authorization: Bearer admin" \
  -X POST http://localhost:3098/command \
  -d '{"op":"eval","expr":"user.role"}'
# → {"ok":true, "value":"user"}

curl -H "Authorization: Bearer admin" \
  -X POST http://localhost:3098/command \
  -d '{"op":"eval","expr":"users.filter(u => u.role === \"admin\").length"}'
# → {"ok":true, "value":1}
```

You can evaluate **any JavaScript expression** in the paused scope.

### Step through code

```bash
# Step to next line
curl -H "Authorization: Bearer admin" \
  -X POST http://localhost:3098/command -d '{"op":"step_over"}'

# Step into a function call
curl -H "Authorization: Bearer admin" \
  -X POST http://localhost:3098/command -d '{"op":"step_into"}'

# Step out of current function
curl -H "Authorization: Bearer admin" \
  -X POST http://localhost:3098/command -d '{"op":"step_out"}'
```

### Resume execution

```bash
curl -H "Authorization: Bearer admin" \
  -X POST http://localhost:3098/command -d '{"op":"continue"}'
# → {"status":"running"}
```

The paused `curl` request from above now completes and returns the login response.

---

## Feature 2: Conditional Breakpoints

**Problem:** The `debugger` statement pauses for every login — but what if you only care about admin logins?

**Solution:** Set a breakpoint with a condition expression. The debugger only pauses when the condition is `true`.

### Remove the always-on debugger pause first

You can set breakpoints *without* modifying source code. First, let the server continue past any `debugger` hits, then set a conditional breakpoint:

```bash
# Set breakpoint with condition: only pause for admin
curl -H "Authorization: Bearer admin" \
  -X POST http://localhost:3098/command -d '{
    "op": "set_breakpoint",
    "file": "tutorial-server.cjs",
    "line": 57,
    "condition": "email === \"admin@example.com\""
  }'
# → {"ok":true, "id":1, "condition":"email === \"admin@example.com\""}
```

### Test it

```bash
# Alice logs in — NO pause, returns immediately
curl -X POST http://localhost:4444/login \
  -d '{"email":"alice@example.com","password":"secret"}'
# → {"ok":true,"user":{"id":1,"name":"Alice",...}}  (instant)

# Bob logs in — NO pause
curl -X POST http://localhost:4444/login \
  -d '{"email":"bob@example.com","password":"secret"}'
# → {"ok":true,"user":{"id":2,"name":"Bob",...}}  (instant)

# Admin logs in — PAUSED!
curl -X POST http://localhost:4444/login \
  -d '{"email":"admin@example.com","password":"secret"}'
# ↑ Hangs — the server is paused because condition matched
```

### Why this matters

- **Debug specific users** without disrupting others
- **Filter by error conditions**: `condition: "statusCode >= 500"`
- **Target specific data**: `condition: "order.total > 10000"`
- No code changes needed — set/remove breakpoints via API

### Manage breakpoints

```bash
# List all breakpoints
curl -H "Authorization: Bearer admin" http://localhost:3098/breakpoints
# → {"breakpoints":[{"id":1,"file":"tutorial-server.cjs","line":57}]}

# Remove a breakpoint
curl -H "Authorization: Bearer admin" \
  -X POST http://localhost:3098/command -d '{"op":"remove_breakpoint","id":"1"}'
```

---

## Feature 3: Trace Mode (Non-Blocking Observation)

**Problem:** You want to observe what happens at a breakpoint across many requests, but you don't want to pause the server every time. Think of it as "logging on steroids".

**Solution:** Trace mode. When enabled, mypry auto-resumes on every pause and silently collects snapshots (file, line, locals, timestamp). Your app keeps running at full speed.

### Start a trace

```bash
# 1. Set a breakpoint (unconditional this time)
curl -H "Authorization: Bearer admin" \
  -X POST http://localhost:3098/command -d '{
    "op": "set_breakpoint",
    "file": "tutorial-server.cjs",
    "line": 57
  }'

# 2. Enable trace mode
curl -H "Authorization: Bearer admin" \
  -X POST http://localhost:3098/command -d '{"op":"trace_start","maxBuffer":100}'
# → {"ok":true, "tracing":true, "maxBuffer":100}
```

### Generate traffic (nothing pauses!)

```bash
# All 5 users log in — none of them pause the server
for user in alice bob admin diana eve; do
  curl -s -X POST http://localhost:4444/login \
    -d "{\"email\":\"${user}@example.com\",\"password\":\"secret\"}"
  echo ""
done
# All 5 return instantly with tokens
```

### Collect the trace

```bash
# Stop trace and get all captured snapshots
curl -H "Authorization: Bearer admin" \
  -X POST http://localhost:3098/command -d '{"op":"trace_stop"}'
```

```json
{
  "ok": true,
  "tracing": false,
  "count": 5,
  "hits": [
    {
      "timestamp": 1779905774582,
      "file": "tutorial-server.cjs",
      "line": 57,
      "function": "authenticate",
      "locals": {
        "email": "alice@example.com",
        "isValid": true,
        "user": { "id": 1, "name": "Alice" }
      }
    },
    {
      "timestamp": 1779905774620,
      "file": "tutorial-server.cjs",
      "line": 57,
      "function": "authenticate",
      "locals": {
        "email": "bob@example.com",
        "isValid": true,
        "user": { "id": 2, "name": "Bob" }
      }
    },
    // ... 3 more hits
  ]
}
```

### Check trace without stopping

```bash
# Peek at current buffer without ending the trace
curl -H "Authorization: Bearer admin" \
  -X POST http://localhost:3098/command -d '{"op":"trace_status"}'
# → {"tracing":true, "count":5, "hits":[...]}
```

### Real-time via SSE

If you connect to the SSE stream, you get trace events in real-time:

```bash
curl -N -H "Authorization: Bearer admin" http://localhost:3098/events
```

```
event: trace
data: {"timestamp":1779905774582,"file":"tutorial-server.cjs","line":57,...}

event: trace
data: {"timestamp":1779905774620,"file":"tutorial-server.cjs","line":57,...}
```

### Why this matters

- **Observe production-like behavior** without interrupting
- **Collect data across many requests** — then analyze patterns
- **Performance profiling**: how many times does this line hit? With what values?
- **Agent workflows**: start trace → run automated tests → stop trace → analyze

---

## Feature 4: Granular Auth (Multi-Token ro/rw)

**Problem:** You want to share the debugger API with a team or agent, but not everyone should be able to `continue` or `step` — that could break a debugging session.

**Solution:** Multi-token auth with read-only (`ro`) and read-write (`rw`) permissions.

### Configuration

When starting mypry, pass a token string:

```bash
mypry attach --http-only --token "admin:rw,viewer:ro"
```

This creates two tokens:
- `admin` → full access (read + write)
- `viewer` → read-only access

### What each role can do

| Operation | `rw` (admin) | `ro` (viewer) |
|-----------|:---:|:---:|
| `state` | ✅ | ✅ |
| `eval` | ✅ | ✅ |
| `locals` | ✅ | ✅ |
| `backtrace` | ✅ | ✅ |
| `source` | ✅ | ✅ |
| `breakpoints` | ✅ | ✅ |
| `trace_status` | ✅ | ✅ |
| `continue` | ✅ | ❌ 403 |
| `step_over` | ✅ | ❌ 403 |
| `step_into` | ✅ | ❌ 403 |
| `step_out` | ✅ | ❌ 403 |
| `set_breakpoint` | ✅ | ❌ 403 |
| `remove_breakpoint` | ✅ | ❌ 403 |
| `pause` | ✅ | ❌ 403 |
| `trace_start` | ✅ | ❌ 403 |
| `trace_stop` | ✅ | ❌ 403 |

### Test it

```bash
# Viewer CAN read state
curl -H "Authorization: Bearer viewer" http://localhost:3098/state
# → {"status":"running"}  ✅

# Viewer CAN eval (when paused)
curl -H "Authorization: Bearer viewer" \
  -X POST http://localhost:3098/command -d '{"op":"eval","expr":"users.length"}'
# → {"ok":true,"value":5}  ✅

# Viewer CANNOT set breakpoints
curl -H "Authorization: Bearer viewer" \
  -X POST http://localhost:3098/command -d '{"op":"set_breakpoint","file":"x","line":1}'
# → {"error":"Forbidden — 'set_breakpoint' requires rw token"}  ❌ 403

# No token = rejected
curl http://localhost:3098/health
# → {"error":"Unauthorized — Bearer token required"}  ❌ 401
```

### Why this matters

- **Shared environments**: give agents read-only access
- **Safety**: prevent accidental `continue` during a debug session
- **Audit**: know which token performed which action
- **Single token mode**: `--token mysecret` (no colon) = single rw token

---

## Feature 5: Worker Threads

**Problem:** Your Node.js app uses `worker_threads` for background processing. You can't debug them with Chrome DevTools — workers don't get their own inspector port.

**Solution:** mypry discovers workers via the `NodeWorker` CDP domain and creates proxy sessions. You can debug workers alongside the main thread.

### How it works

```
   Main Thread (port 9231)
   │
   ├── CDPClient (WebSocket)
   │   ├── Debugger.* → main DebuggerSession
   │   └── NodeWorker.* → worker discovery
   │
   ├── Worker 1: "metrics"
   │   └── WorkerCDPProxy (session "1")
   │       └── DebuggerSession (transparent)
   │
   └── Worker 2: "health-check"
       └── WorkerCDPProxy (session "2")
           └── DebuggerSession (transparent)
```

Workers don't get separate WebSocket ports. Instead, mypry uses `NodeWorker.sendMessageToWorker` to route CDP commands through the parent session. `WorkerCDPProxy` implements the same interface as `CDPClient`, so `DebuggerSession` works transparently.

### Discover workers

```bash
curl -H "Authorization: Bearer admin" http://localhost:3098/workers
```

```json
{
  "workers": [
    {
      "sessionId": "1",
      "title": "[worker 1] WorkerThread",
      "url": "file:///path/to/examples/tutorial-server.cjs"
    },
    {
      "sessionId": "2",
      "title": "[worker 2] WorkerThread",
      "url": "file:///path/to/examples/tutorial-server.cjs"
    }
  ],
  "count": 2
}
```

### Debug a specific worker

Add the `"worker"` field to any `/command` request:

```bash
# Get worker 1's state
curl -H "Authorization: Bearer admin" \
  -X POST http://localhost:3098/command \
  -d '{"op":"state","worker":"1"}'
```

```json
{
  "status": "paused",
  "file": "tutorial-server.cjs",
  "line": 33,
  "function": "<anon>",
  "locals": {
    "name": "metrics",
    "tickCount": 1,
    "memMB": "7.3"
  }
}
```

### Eval in a worker

```bash
# What's this worker's name?
curl -H "Authorization: Bearer admin" \
  -X POST http://localhost:3098/command \
  -d '{"op":"eval","expr":"name","worker":"1"}'
# → {"ok":true, "value":"metrics"}

# Memory usage?
curl -H "Authorization: Bearer admin" \
  -X POST http://localhost:3098/command \
  -d '{"op":"eval","expr":"memMB","worker":"1"}'
# → {"ok":true, "value":"7.3"}
```

### Continue a worker

```bash
curl -H "Authorization: Bearer admin" \
  -X POST http://localhost:3098/command \
  -d '{"op":"continue","worker":"1"}'
# → {"status":"running"}
```

### Why this matters

- **Debug background jobs** without special tooling
- **Inspect worker memory** usage and state
- **Set breakpoints in workers** to catch specific conditions
- **All existing ops work**: eval, step, backtrace, breakpoints — just add `"worker":"<id>"`

---

## Feature 6: Inject PID

**Problem:** Your process is already running without `--inspect`. You can't restart it — it's handling live traffic or has state you can't reproduce.

**Solution:** `mypry inject <PID>` sends `SIGUSR1` to the process, which enables the V8 inspector. Then mypry auto-attaches.

### How it works

```
1. node server.js  (no --inspect, PID 12345)
2. mypry inject 12345
   └── kill -USR1 12345      ← enables inspector on port 9229
   └── mypry attach --port 9229  ← auto-attaches
3. Debugger connected!
```

### Demo

Terminal 1 — start a plain server:
```bash
node -e "
const http = require('http')
let counter = 0
http.createServer((req, res) => {
  counter++
  debugger  // will pause once inspector is enabled
  res.end('hello ' + counter)
}).listen(5555, () => console.log('PID:', process.pid))
"
# → PID: 12345
```

Terminal 2 — inject and attach:
```bash
mypry inject 12345
```

```
[mypry] sending SIGUSR1 to PID 12345 to enable inspector...
Debugger listening on ws://127.0.0.1:9229/...
[mypry] inspector should be active on port 9229
Debugger attached.
```

Terminal 3 — trigger a request:
```bash
curl http://localhost:5555/
# ↑ Hangs — the debugger paused
```

Now you're debugging a process that was never started with `--inspect`!

### Why this matters

- **Debug running production processes** without restarting
- **Catch bugs in long-running services** that took hours to reach a state
- **Zero downtime** — SIGUSR1 has no side effects except enabling the inspector
- **Combine with trace**: inject → set breakpoints → trace → collect data

---

## Batch Operations

Execute multiple ops in a single HTTP call:

```bash
curl -H "Authorization: Bearer admin" \
  -X POST http://localhost:3098/batch -d '{
    "ops": [
      {"op": "eval", "expr": "requestCount"},
      {"op": "eval", "expr": "users.length"},
      {"op": "eval", "expr": "process.uptime()"}
    ]
  }'
```

```json
{
  "results": [
    {"ok": true, "value": 12},
    {"ok": true, "value": 5},
    {"ok": true, "value": 45.2}
  ]
}
```

---

## SSE (Server-Sent Events)

Connect to the event stream for real-time notifications:

```bash
curl -N -H "Authorization: Bearer admin" http://localhost:3098/events
```

Events you'll receive:

| Event | When | Data |
|-------|------|------|
| `state` | Sent immediately on connect | Current debugger state |
| `paused` | Debugger hits a breakpoint | Full pause state |
| `resumed` | Execution continues | `{}` |
| `trace` | During trace mode, each hit | Snapshot data |

---

## Programmatic API

Import mypry's core for custom integrations:

```typescript
import {
  CDPClient,
  DebuggerSession,
  WorkerCDPProxy,
  discoverWorkers,
  discoverTargets,
  matchTarget,
  executeOp,
  snapshot,
} from 'mypry/core'

// Connect to a running process
const targets = await discoverTargets(9229)
const target = matchTarget(targets)
const cdp = new CDPClient(target.webSocketDebuggerUrl)
await cdp.connect()

const session = new DebuggerSession(cdp)
await session.init()

// Wait for a pause
session.on('paused', async () => {
  const state = await executeOp(session, 'state')
  console.log('Paused at:', state.file, state.line)
  console.log('Locals:', state.locals)

  // Evaluate something
  const result = await executeOp(session, 'eval', { expr: 'user.email' })
  console.log('Email:', result.value)

  // Continue
  await executeOp(session, 'continue')
})

// Discover workers
const workers = await discoverWorkers(cdp)
for (const info of workers) {
  const proxy = new WorkerCDPProxy(cdp, info.sessionId)
  const workerSession = new DebuggerSession(proxy)
  await workerSession.init()
  // ... debug the worker just like main thread
}
```

---

## Transport Comparison

| Transport | Use Case | Command |
|-----------|----------|---------|
| **REPL** | Human interactive debugging | `mypry attach` |
| **HTTP** | Agent/API integration | `mypry attach --http-only` |
| **MCP** | Claude Code / Cursor | `mypry attach --mcp` |
| **NDJSON** | Custom tool embedding | `mypry attach --json` |

All transports share the same `executeOp` core — same operations, same behavior.

---

## Quick Reference

```bash
# Basic attach (REPL)
mypry attach

# HTTP API only
mypry attach --http-only

# With auth
mypry attach --http-only --token "admin:rw,viewer:ro"

# With workers
mypry attach --http-only --workers

# Inject into running process
mypry inject <PID>

# MCP for Claude Code
mypry attach --mcp

# Full-stack (backend + Chrome frontend)
mypry attach --chrome

# Launch Chrome for frontend debugging
mypry open http://localhost:5173
```

### Operations

| Op | Params | Description |
|----|--------|-------------|
| `state` | — | Current pause: file, line, function, locals, source |
| `eval` | `expr` | Evaluate any JavaScript expression in scope |
| `continue` | — | Resume execution |
| `step_over` | — | Next line |
| `step_into` | — | Into function call |
| `step_out` | — | Out of current function |
| `locals` | — | All local variables |
| `backtrace` | — | Call stack |
| `source` | — | Current file source |
| `set_breakpoint` | `file`, `line`, `condition?` | Set breakpoint |
| `remove_breakpoint` | `id` | Remove breakpoint |
| `breakpoints` | — | List active breakpoints |
| `pause` | — | Force pause |
| `trace_start` | `maxBuffer?` | Start trace (auto-resume, collect) |
| `trace_stop` | — | Stop trace, return hits |
| `trace_status` | — | Peek at trace buffer |
| `quit` | — | Disconnect |
