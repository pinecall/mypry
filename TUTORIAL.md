# mypry — AI Agent Debugging Tutorial

> **mypry** is a zero-config debugger for Node.js built for AI agents.
> Drop `debugger` in your code. Your agent inspects, steps, evals, and continues — via MCP tools.

This tutorial shows every feature using MCP tool calls, exactly how an AI agent (Claude Code, Antigravity, Cursor) would use them.

---

## Architecture

```
┌──────────┐  stdio   ┌───────────┐  HTTP   ┌────────────┐   CDP    ┌─────────┐
│ AI Agent │─────────│ MCP Bridge │────────│ mypry      │────────│ Node.js │
│          │          │ (instant)  │ :3098  │ daemon     │ :9229  │ process │
└──────────┘          └───────────┘         └────────────┘        └─────────┘
```

The MCP bridge starts instantly (never blocks). It proxies tool calls to the mypry HTTP daemon, which manages the CDP connection to Node.js.

---

## Setup

```bash
cd mypry
npm install && npm run build && npm link
```

### Start the example server

```bash
node --inspect examples/tutorial-server.cjs
```

### Start the daemon

```bash
mypry attach --http-only --http=3098 --workers
```

You should see:

```
Debugger attached.
[mypry] worker attached: [worker 1] WorkerThread (1)
[mypry] worker attached: [worker 2] WorkerThread (2)
[mypry] HTTP server listening on http://127.0.0.1:3098
```

### Configure your agent's MCP

**Antigravity** (`~/.gemini/config/mcp_config.json`):
```json
{ "mypry": { "command": "node", "args": ["/path/to/mypry/dist/mcp-bridge.js"] } }
```

**Claude Code** (`~/.claude/mcp.json`):
```json
{ "mcpServers": { "mypry": { "command": "node", "args": ["/path/to/mypry/dist/mcp-bridge.js"] } } }
```

**Aurora TUI** (debugger already on :3099):
```json
{ "mypry": { "command": "node", "args": ["mcp-bridge.js"], "env": { "MYPRY_URL": "http://127.0.0.1:3099/api/debugger" } } }
```

---

## The Example Server

`examples/tutorial-server.cjs` — a tiny HTTP API:

```
┌─────────────────────────────────────┐
│  tutorial-server.cjs  :4444         │
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

The `authenticate()` function has a `debugger` statement that pauses on every login.

---

## Feature 1: Basic Debugging

### Trigger a pause

```bash
# From a terminal — this hangs because the server pauses
curl -X POST http://localhost:4444/login \
  -d '{"email":"alice@example.com","password":"secret"}'
```

### Agent inspects the pause

```
→ debugger_state {}
```

```json
{
  "status": "paused",
  "file": "/path/to/examples/tutorial-server.cjs",
  "line": 57,
  "function": "authenticate",
  "source_window": [
    {"line": 54, "text": "  const user = users.find(u => u.email === email)", "current": false},
    {"line": 55, "text": "  const isValid = user && password === 'secret'", "current": false},
    {"line": 56, "text": "", "current": false},
    {"line": 57, "text": "  debugger  // ← auth breakpoint", "current": true},
    {"line": 58, "text": "", "current": false},
    {"line": 59, "text": "  return isValid ? user : null", "current": false}
  ],
  "locals": {
    "email": "alice@example.com",
    "password": "secret",
    "user": "Object",
    "isValid": true
  }
}
```

In one call, the agent sees: where execution stopped, the source code, and all local variables.

### Evaluate expressions

```
→ debugger_eval {"expr": "user.role"}
← {"ok": true, "type": "string", "value": "user"}

→ debugger_eval {"expr": "users.filter(u => u.role === 'admin').length"}
← {"ok": true, "type": "number", "value": 1}

→ debugger_eval {"expr": "JSON.stringify(user)"}
← {"ok": true, "value": "{\"id\":1,\"name\":\"Alice\",\"email\":\"alice@example.com\",\"role\":\"user\"}"}
```

Any valid JavaScript expression works — you have full access to the paused scope.

### Step through code

```
→ debugger_step_over {}
← {"status": "paused", "line": 59, "function": "authenticate", "locals": {...}}

→ debugger_step_into {}
← {"status": "paused", "line": 12, "function": "Array.find", ...}

→ debugger_step_out {}
← {"status": "paused", "line": 59, ...}
```

Each step returns the new state — no need to call `debugger_state` after.

### Resume execution

```
→ debugger_continue {}
← {"status": "running", "wait_timeout": true}
```

The paused curl request completes. `debugger_continue` **blocks** until the next breakpoint (30s timeout).

---

## Feature 2: Conditional Breakpoints

**Problem:** The `debugger` statement pauses on every login.
**Solution:** Set a breakpoint with a condition — only pause when it's true.

### Set a conditional breakpoint

```
→ debugger_set_breakpoint {
    "file": "tutorial-server.cjs",
    "line": 57,
    "condition": "email === \"admin@example.com\""
  }
← {"ok": true, "id": 1, "file": "tutorial-server.cjs", "line": 57, "condition": "email === \"admin@example.com\""}
```

### Test it

```bash
# Alice — NO pause (condition is false)
curl -X POST http://localhost:4444/login -d '{"email":"alice@example.com","password":"secret"}'
# → Instant response

# Admin — PAUSES (condition is true)
curl -X POST http://localhost:4444/login -d '{"email":"admin@example.com","password":"secret"}'
# → Hangs (paused)
```

```
→ debugger_state {}
← {"status": "paused", "line": 57, "locals": {"email": "admin@example.com", "isValid": true}}
```

### Manage breakpoints

```
→ debugger_list_breakpoints {}
← {"breakpoints": [{"id": 1, "file": "tutorial-server.cjs", "line": 57, "condition": "email === \"admin@example.com\""}]}

→ debugger_remove_breakpoint {"id": 1}
← {"ok": true}
```

### Condition expression examples

| Condition | When it fires |
|-----------|---------------|
| `email === "admin@example.com"` | Specific user |
| `isValid === false` | Failed login attempts |
| `user?.role === "admin"` | Admin users only |
| `requestCount > 100` | After 100 requests |
| `password.length < 8` | Weak passwords |

---

## Feature 3: Trace Mode (Non-Blocking Observation)

**Problem:** You want to observe multiple logins without pausing the app.
**Solution:** Trace mode auto-resumes breakpoints and silently collects snapshots.

### Start tracing

```
→ debugger_set_breakpoint {"file": "tutorial-server.cjs", "line": 57}
← {"ok": true, "id": 2}

→ debugger_trace_start {"maxBuffer": 100}
← {"ok": true, "tracing": true, "maxBuffer": 100}
```

The app is now running normally. Every time it hits line 57, mypry captures a snapshot and auto-resumes.

### Trigger some logins

```bash
curl -X POST http://localhost:4444/login -d '{"email":"alice@example.com","password":"secret"}'
curl -X POST http://localhost:4444/login -d '{"email":"bob@example.com","password":"secret"}'
curl -X POST http://localhost:4444/login -d '{"email":"admin@example.com","password":"wrong"}'
```

All three return instantly — the server never paused.

### Peek at the trace

```
→ debugger_trace_status {}
← {
    "tracing": true,
    "count": 3,
    "hits": [
      {"timestamp": 1779919970886, "file": ".../tutorial-server.cjs", "line": 57, "function": "authenticate", "locals": {"email": "alice@example.com", "isValid": true}},
      {"timestamp": 1779919971102, "file": ".../tutorial-server.cjs", "line": 57, "function": "authenticate", "locals": {"email": "bob@example.com", "isValid": true}},
      {"timestamp": 1779919971340, "file": ".../tutorial-server.cjs", "line": 57, "function": "authenticate", "locals": {"email": "admin@example.com", "isValid": false}}
    ]
  }
```

### Stop tracing and collect results

```
→ debugger_trace_stop {}
← {"ok": true, "tracing": false, "count": 3, "hits": [...]}
```

### When to use trace vs. breakpoints

| Use | When |
|-----|------|
| **Breakpoints** | You need to pause and deeply inspect one execution |
| **Trace mode** | You want to observe patterns across many executions |
| **Conditional BP + Trace** | Collect only the interesting hits (e.g. failed logins) |

---

## Feature 4: Worker Thread Debugging

### Discover workers

```
→ debugger_workers {}
← {
    "workers": [
      {"sessionId": "1", "title": "[worker 1] WorkerThread", "url": ".../tutorial-server.cjs"},
      {"sessionId": "2", "title": "[worker 2] WorkerThread", "url": ".../tutorial-server.cjs"}
    ],
    "count": 2
  }
```

### Eval in a specific worker

```
→ debugger_eval {"expr": "workerData.type", "worker": "1"}
← {"ok": true, "value": "metrics"}

→ debugger_eval {"expr": "workerData.type", "worker": "2"}
← {"ok": true, "value": "health-check"}
```

The `worker` param routes the eval to that worker's scope.

---

## Feature 5: Backtrace and Source

### Call stack

```
→ debugger_backtrace {}
← {
    "frames": [
      {"function": "authenticate", "file": "tutorial-server.cjs", "line": 57},
      {"function": "Server.<anonymous>", "file": "tutorial-server.cjs", "line": 68},
      {"function": "emit", "file": "node:events", "line": 519}
    ]
  }
```

### Full source

```
→ debugger_source {}
← {
    "file": "tutorial-server.cjs",
    "current_line": 57,
    "source": "const http = require('http')\n..."
  }
```

---

## Feature 6: Force Pause

Your app is running and you need to inspect it NOW — without any breakpoints or debugger statements.

```
→ debugger_pause {}
← {"status": "paused", "file": "node:internal/timers", "line": 527, "function": "processTimers", ...}
```

Pauses wherever execution happens to be. Useful for inspecting stuck or slow processes.

---

## Feature 7: Source Map Resolution (TypeScript)

mypry automatically resolves source maps. If your project compiles TypeScript to JavaScript (NestJS, Next.js, etc.), the debugger shows the **original .ts file** and line numbers, not the compiled `dist/*.js`.

### Example: NestJS auth service

```
→ debugger_state {}
← {
    "status": "paused",
    "file": "/project/src/auth/auth.service.ts",    ← original TypeScript
    "line": 151,                                      ← correct .ts line number
    "function": "validateUser",
    "source_window": [
      {"line": 147, "text": "    this.logger.debug(`Password matches for ${emailAddress}`);"},
      {"line": 149, "text": "    // eslint-disable-next-line no-debugger"},
      {"line": 151, "text": "    debugger;", "current": true},
      {"line": 153, "text": "    return user;"}
    ]
  }
```

Without source maps, the same pause would show `dist/auth/auth.service.js:136` with compiled JavaScript — useless for an agent trying to propose code edits.

**Requirements:** Your `tsconfig.json` must have `"sourceMap": true` and the `.js.map` files must exist alongside the compiled `.js` files.

---

## Feature 8: Frontend Debugging (Chrome CDP)

mypry connects to Chrome's DevTools Protocol for frontend debugging — same tools, same API.

### Setup

```bash
# Start Chrome with debugging port
mypry open http://localhost:3001

# Start daemon pointing to Chrome
mypry attach --http-only --port 9222 --http=3097
```

### Global eval (no pause needed)

When the process is running, `debugger_eval` uses `Runtime.evaluate` for global scope access:

```
→ debugger_eval {"expr": "document.title"}
← {"ok": true, "value": "ServiceHub"}

→ debugger_eval {"expr": "window.location.href"}
← {"ok": true, "value": "http://localhost:3001/login"}

→ debugger_eval {"expr": "document.querySelectorAll('input').length"}
← {"ok": true, "value": 3}
```

### Install an XHR/fetch interceptor

```
→ debugger_eval {"expr": "var _origSend = XMLHttpRequest.prototype.send; XMLHttpRequest.prototype.send = function(body) { if (this._mypryUrl) { debugger; } return _origSend.apply(this, arguments); }; 'interceptor installed'"}
← {"ok": true, "value": "interceptor installed"}
```

### Catch a login request

```
→ debugger_eval {"expr": "document.querySelector('#login-btn')?.click()"}

(page pauses at XMLHttpRequest.send)

→ debugger_state {}
← {
    "status": "paused",
    "function": "XMLHttpRequest.send",
    "locals": {
      "body": "{\"emailAddress\":\"admin@test.com\",\"password\":\"secret\"}"
    }
  }

→ debugger_eval {"expr": "JSON.parse(body)"}
← {"ok": true, "value": {"emailAddress": "admin@test.com", "password": "secret"}}

→ debugger_continue {}
```

---

## Agent Workflow Patterns

### Pattern 1: Debug a specific request

```
1. debugger_set_breakpoint {file: "auth.service.ts", line: 151, condition: "email === 'admin@test.com'"}
2. (trigger the request)
3. debugger_state {}                     → see where we paused
4. debugger_eval {expr: "user"}          → inspect the user object
5. debugger_eval {expr: "req.headers"}   → check request headers
6. debugger_step_over {}                 → next line
7. debugger_eval {expr: "result"}        → see the result
8. debugger_continue {}                  → resume
9. debugger_remove_breakpoint {id: 1}    → cleanup
```

### Pattern 2: Observe a flow across many requests

```
1. debugger_set_breakpoint {file: "handler.ts", line: 42}
2. debugger_trace_start {maxBuffer: 50}
3. (run tests, trigger actions, wait)
4. debugger_trace_stop {}                → get all hits with locals
5. (analyze: which requests failed? what were the inputs?)
6. debugger_remove_breakpoint {id: 1}
```

### Pattern 3: Investigate a worker thread

```
1. debugger_workers {}                   → find worker IDs
2. debugger_eval {expr: "state", worker: "1"}
3. debugger_eval {expr: "queue.length", worker: "1"}
```

### Pattern 4: Live inspection (no breakpoints)

```
1. debugger_pause {}                     → freeze the process
2. debugger_state {}                     → see where we are
3. debugger_eval {expr: "process.memoryUsage()"}
4. debugger_eval {expr: "global.connectionPool.size"}
5. debugger_continue {}                  → resume
```

### Pattern 5: Frontend → Backend handoff (ONE daemon, `target` param)

```bash
# Setup: single daemon with --chrome
mypry attach --http-only --port 9229 --http=3098 --chrome http://localhost:3001
```

```
# Frontend: intercept the API call
1. debugger_eval {target: "frontend", expr: "install XHR interceptor with debugger;"}
2. debugger_eval {target: "frontend", expr: "document.querySelector('#login-btn')?.click()"}
   → page pauses at XMLHttpRequest.send
3. debugger_state {target: "frontend"}   → paused, locals: {body: '{"email":"..."}'}
4. debugger_eval {target: "frontend", expr: "JSON.parse(body)"}
5. debugger_continue {target: "frontend"} → request flies to backend

# Backend: catch the same request (same daemon, no target = backend default)
6. debugger_state {}                     → paused at auth.service.ts:151 (source-mapped!)
7. debugger_eval {expr: "user.role?.name"} → "Superadmin"
8. debugger_backtrace {}                 → auth.service.ts:151 (source-mapped!)
9. debugger_continue {}
```

---

## MCP Tools Quick Reference

| Tool | Params | Blocks? | Description |
|------|--------|---------|-------------|
| `debugger_state` | — | No | Current pause: file, line, function, locals, source |
| `debugger_eval` | `expr`, `worker?` | No | Evaluate JS — paused: frame scope; running: global scope |
| `debugger_continue` | — | **Yes** | Resume until next breakpoint (30s timeout) |
| `debugger_step_over` | — | No | Next line, returns new state |
| `debugger_step_into` | — | No | Enter function, returns new state |
| `debugger_step_out` | — | No | Exit function, returns new state |
| `debugger_pause` | — | No | Force-pause a running process |
| `debugger_set_breakpoint` | `file`, `line`, `condition?` | No | Set BP (optional condition) |
| `debugger_remove_breakpoint` | `id` | No | Remove BP by ID |
| `debugger_list_breakpoints` | — | No | List all active BPs |
| `debugger_backtrace` | — | No | Call stack frames |
| `debugger_source` | `file?` | No | Full source of current file |
| `debugger_trace_start` | `maxBuffer?` | No | Start trace (auto-resume) |
| `debugger_trace_stop` | — | No | Stop trace, return hits |
| `debugger_trace_status` | — | No | Peek at trace buffer |
| `debugger_workers` | — | No | List worker threads |

> **All tools** accept an optional `target` param: `"frontend"` routes to Chrome CDP, `"backend"` (default) routes to Node.js. Requires `mypry attach --chrome`.

---

## HTTP API (for non-MCP agents)

Everything above works via HTTP too. The MCP bridge is just a proxy:

```bash
# State
curl http://localhost:3098/command -d '{"op":"state"}'

# Eval
curl http://localhost:3098/command -d '{"op":"eval","expr":"user.role"}'

# Continue (blocking)
curl http://localhost:3098/command -d '{"op":"continue","wait":true}'

# Set conditional breakpoint
curl http://localhost:3098/command -d '{"op":"set_breakpoint","file":"auth.ts","line":42,"condition":"role===\"admin\""}'

# Trace
curl http://localhost:3098/command -d '{"op":"trace_start","maxBuffer":50}'
curl http://localhost:3098/command -d '{"op":"trace_stop"}'

# Workers
curl http://localhost:3098/command -d '{"op":"workers"}'
```

For Aurora TUI, prefix with `/api/debugger`:
```bash
curl http://localhost:3099/api/debugger/command -d '{"op":"state"}'
```

---

## Web UI

A ready-to-use web debugger is included at `examples/web-debugger.html`:

```bash
open examples/web-debugger.html
```

It connects to the same HTTP API and provides: source view, locals panel, call stack, breakpoint management, step/continue controls, eval bar, and live SSE updates. Use it as a starting point for custom debugger UIs.
