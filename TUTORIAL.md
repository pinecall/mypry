# mypry — Tutorial

**mypry** is the interactive full-stack debugger for AI agents. You drop a `debugger` statement (or set a breakpoint), and your agent inspects, steps, evaluates, and continues — across your backend **and** frontend, in one session.

This tutorial walks through every feature using **MCP tools only** — exactly the calls your agent (Claude Code, Cursor, Antigravity) makes. No HTTP, no curl against the debugger. The only shell commands you run are to start your app and the daemon.

```
AI agent ── stdio ──▶ mcp-bridge ── HTTP ──▶ mypry daemon ── CDP ──▶ your app
   you talk here          (instant, stateless)        (owns the connection)
```

Everything below uses this notation:

```
→ debugger_state {}          # the tool call your agent makes
← { "status": "paused", ...} # what comes back
```

---

## Setup

### 1. Install

```bash
npm install mypry
```

### 2. Create an app to debug

Save this as `server.js`. Note the `debugger` on **line 12**.

```js
// server.js
const http = require('http')

const users = [
  { id: 1, name: 'Alice', email: 'alice@example.com', role: 'user'  },
  { id: 2, name: 'Admin', email: 'admin@example.com', role: 'admin' },
]

function authenticate(email, password) {
  const user = users.find(u => u.email === email)
  const isValid = user && password === 'secret'
  debugger                                    // ← mypry pauses here
  return isValid ? user : null
}

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/login') {
    let body = ''
    req.on('data', c => (body += c))
    req.on('end', () => {
      const { email, password } = JSON.parse(body)
      const user = authenticate(email, password)
      res.end(JSON.stringify({ ok: !!user, user }))
    })
  } else {
    res.end('ok')
  }
}).listen(4444, () => console.log('listening on :4444'))
```

### 3. Run it with the inspector open

```bash
node --inspect server.js
# Debugger listening on ws://127.0.0.1:9229/...
# listening on :4444
```

### 4. Start the mypry daemon

```bash
mypry serve
```

### 5. Connect your agent

Add mypry to your agent's MCP config. **Claude Code** (`~/.claude/mcp.json`):

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

> **Cursor:** same block in `~/.cursor/mcp.json`.
> **Antigravity:** same block (without the outer `mcpServers`) in `~/.gemini/config/mcp_config.json`.
> Use an **absolute** path to `mcp-bridge.js` if your agent runs from another directory.

Restart your agent. You now have the `debugger_*` tools available.

---

## Feature 1 — Basic interactive debugging

Trigger the breakpoint. From any terminal:

```bash
curl -X POST localhost:4444/login -d '{"email":"alice@example.com","password":"secret"}'
# (this request hangs — the server is paused at line 12)
```

Now the agent inspects. **In one call**, it sees where it stopped, the source, and every local:

```
→ debugger_state {}
← {
    "status": "paused",
    "file": "server.js",
    "line": 12,
    "function": "authenticate",
    "source_window": [
      { "line": 10, "text": "  const user = users.find(u => u.email === email)" },
      { "line": 11, "text": "  const isValid = user && password === 'secret'" },
      { "line": 12, "text": "  debugger", "current": true },
      { "line": 13, "text": "  return isValid ? user : null" }
    ],
    "locals": { "email": "alice@example.com", "password": "secret", "isValid": true }
  }
```

Evaluate any JavaScript in the paused frame:

```
→ debugger_eval { "expr": "user.role" }
← { "ok": true, "type": "string", "value": "user" }

→ debugger_eval { "expr": "users.filter(u => u.role === 'admin').length" }
← { "ok": true, "type": "number", "value": 1 }
```

Step through. Each step returns the new state — no follow-up `debugger_state` needed:

```
→ debugger_step_over {}
← { "status": "paused", "line": 13, "function": "authenticate" }

→ debugger_step_into {}
← { "status": "paused", "function": "Array.find", ... }

→ debugger_step_out {}
← { "status": "paused", "line": 13, ... }
```

Resume. This is the one tool that **blocks** — it returns when the next breakpoint hits (30s timeout):

```
→ debugger_continue {}
← { "status": "running" }
```

The hanging `curl` now completes.

---

## Feature 2 — Conditional breakpoints

The `debugger` on line 12 fires on **every** login. To pause only for a specific case, set a conditional breakpoint instead.

```
→ debugger_set_breakpoint {
    "file": "server.js",
    "line": 12,
    "condition": "email === 'admin@example.com'"
  }
← { "ok": true, "id": 1 }
```

Now test both:

```bash
curl -X POST localhost:4444/login -d '{"email":"alice@example.com","password":"secret"}'
# → instant response (condition false, no pause)

curl -X POST localhost:4444/login -d '{"email":"admin@example.com","password":"secret"}'
# → hangs (condition true, paused)
```

```
→ debugger_state {}
← { "status": "paused", "line": 12, "locals": { "email": "admin@example.com", "isValid": true } }

→ debugger_list_breakpoints {}
← { "breakpoints": [ { "id": 1, "file": "server.js", "line": 12, "condition": "email === 'admin@example.com'" } ] }

→ debugger_continue {}
→ debugger_remove_breakpoint { "id": 1 }
← { "ok": true }
```

Useful conditions: `isValid === false` (failed logins), `user?.role === 'admin'`, `requestCount > 100`, `password.length < 8`.

---

## Feature 3 — Trace mode (non-blocking)

When you want to observe a *pattern* across many executions without freezing the app, use trace mode. mypry auto-resumes at each hit and silently records a snapshot.

```
→ debugger_set_breakpoint { "file": "server.js", "line": 12 }
← { "ok": true, "id": 2 }

→ debugger_trace_start { "maxBuffer": 100 }
← { "ok": true, "tracing": true }
```

The app keeps running. Trigger a few logins — **all return instantly**:

```bash
curl -X POST localhost:4444/login -d '{"email":"alice@example.com","password":"secret"}'
curl -X POST localhost:4444/login -d '{"email":"bob@example.com","password":"secret"}'
curl -X POST localhost:4444/login -d '{"email":"admin@example.com","password":"wrong"}'
```

Peek without stopping, or stop and collect everything:

```
→ debugger_trace_status {}
← {
    "tracing": true,
    "count": 3,
    "hits": [
      { "timestamp": 1779919970886, "line": 12, "function": "authenticate", "locals": { "email": "alice@example.com", "isValid": true } },
      { "timestamp": 1779919971102, "line": 12, "function": "authenticate", "locals": { "email": "bob@example.com",   "isValid": true } },
      { "timestamp": 1779919971340, "line": 12, "function": "authenticate", "locals": { "email": "admin@example.com", "isValid": false } }
    ]
  }

→ debugger_trace_stop {}
← { "ok": true, "tracing": false, "count": 3, "hits": [ ... ] }
```

The agent now has the full picture: who logged in, with what inputs, which ones failed — and the app never stopped serving.

> **Interactive vs trace:** breakpoints to inspect **one** execution deeply; trace to watch **many** without pausing. Combine them — a conditional breakpoint + trace collects only the interesting hits (e.g. just the failed logins).

---

## Feature 4 — Full-stack in one session

This is what nothing else does: follow a single request from the **browser** into the **backend**, pausing on both sides, in one session.

Start one daemon that owns both targets:

```bash
mypry serve --frontend http://localhost:5173
```

Every tool takes a `target`: `"frontend"` routes to Chrome, `"backend"` (default) routes to Node.

```
# 1. Frontend — pause as the request leaves the browser
→ debugger_state { "target": "frontend" }
← { "status": "paused", "function": "handleLogin", "file": "Login.vue",
    "locals": { "body": "{\"email\":\"admin@example.com\",\"password\":\"secret\"}" } }

→ debugger_eval { "target": "frontend", "expr": "authStore" }
← { "ok": true, "value": { "token": null, "isAuthenticated": false } }
                          ↑ Pinia $state auto-unwrapped

→ debugger_continue { "target": "frontend" }    # request flies to the backend

# 2. Backend — catch the SAME request (same daemon, no target = backend)
→ debugger_state {}
← { "status": "paused", "file": "auth.service.ts", "line": 151, "function": "validateUser" }
                          ↑ source-mapped from dist/*.js

→ debugger_eval { "expr": "user.role?.name" }
← { "ok": true, "value": "viewer" }

→ debugger_backtrace {}
← { "frames": [ { "function": "validateUser", "file": "auth.service.ts", "line": 151 } ] }

→ debugger_continue {}
```

The agent just diagnosed a bug that spans both sides — the frontend sent the right payload, but the backend resolved the wrong role — without ever leaving the conversation or switching tools.

### Vue/Pinia state inspection

When paused inside a Vue component, reactive state is auto-unwrapped:

```
→ debugger_eval { "target": "frontend", "expr": "authStore" }
← { "ok": true, "value": { "token": null, "loading": false, "isAuthenticated": false } }
                          ↑ Pinia $state auto-unwrapped

→ debugger_eval { "target": "frontend", "expr": "devLoginLoading" }
← { "ok": true, "value": "superadmin" }
                          ↑ Vue ref() auto-unwrapped
```

No `.__v_raw`, no `.value`, no `.$state` — mypry handles it.

---

## Feature 5 — Worker threads

Start the daemon and debug `worker_threads` alongside the main thread.

```
→ debugger_workers {}
← { "count": 2, "workers": [
      { "sessionId": "1", "title": "[worker 1] metrics" },
      { "sessionId": "2", "title": "[worker 2] health-check" }
  ]}

→ debugger_eval { "expr": "workerData.type", "worker": "1" }
← { "ok": true, "value": "metrics" }

→ debugger_eval { "expr": "queue.length", "worker": "1" }
← { "ok": true, "value": 7 }
```

Workers share the parent session — no separate ports, no extra daemon. `mypry serve` enables `--workers` by default.

---

## Feature 6 — Force pause (no breakpoints)

The app is running and you need to inspect it **now** — stuck process, slow request, memory leak.

```
→ debugger_pause {}
← { "status": "paused", "file": "node:internal/timers", "function": "processTimers" }

→ debugger_eval { "expr": "process.memoryUsage().heapUsed / 1e6" }
← { "ok": true, "value": 184.2 }

→ debugger_continue {}
```

Pauses wherever execution happens to be — no `debugger` statement required.

---

## Feature 7 — Source maps

If your project compiles TypeScript (NestJS, Next.js) or serves Vue through Vite, `state`, `backtrace`, and `source` show your **original** file and line — never the compiled `dist/*.js`. Without this, an agent gets `dist/auth/auth.service.js:136` and can't propose a real code edit.

```
→ debugger_state {}
← { "file": "src/auth/auth.service.ts", "line": 151, ... }   # not dist/*.js

→ debugger_backtrace {}
← { "frames": [{ "function": "validateUser", "file": "src/auth/auth.service.ts", "line": 151 }] }
                                                                ↑ source-mapped
```

Frontend Vite URLs are also resolved:
```
http://localhost:3001/src/auth/Login.vue?t=12345  →  src/auth/Login.vue
```

**Requirements:** backend needs `"sourceMap": true` in `tsconfig.json` (and `.js.map` files alongside the compiled output). Vite dev mode emits inline maps automatically, so frontend works out of the box.

---

## Feature 8 — Project config (`.mypry.json`)

Drop a `.mypry.json` in your project root and `mypry serve` picks it up — zero flags needed.

```json
{
  "port": 3098,
  "inspect": 9229,
  "frontend": "http://localhost:3001"
}
```

```bash
cd ~/my-project
mypry serve            # reads .mypry.json, launches Chrome, connects both
```

CLI flags always override the config file. Supported keys: `port`, `inspect`, `frontend`, `token`, `host`, `workers`.

---

## Feature 9 — Live monitor (`mypry watch`)

Open a second terminal to see what your agent is doing:

```bash
mypry watch
```

```
10:21:03 → frontend eval expr="document.title"
10:21:03 ← frontend = "ServiceHub"
10:21:04 → backend  state
10:21:04 ← backend  running
10:21:05 ⏸  paused at validateUser auth.service.ts:151
            locals: emailAddress="admin@test.com", isMatch=true
10:21:06 ▶  resumed
```

Color-coded, timestamped, shows `frontend` vs `backend`. Connects to the daemon's SSE stream — read-only, zero overhead.

---

## Agent workflow patterns

### Debug one specific request

```
1. debugger_set_breakpoint { file: "auth.service.ts", line: 151, condition: "email === 'admin@example.com'" }
2. (trigger the request)
3. debugger_state {}                     → where we paused
4. debugger_eval { expr: "user" }        → inspect
5. debugger_step_over {}                 → next line
6. debugger_eval { expr: "result" }      → see the result
7. debugger_continue {}
8. debugger_remove_breakpoint { id: 1 }
```

### Observe a flow across many requests

```
1. debugger_set_breakpoint { file: "handler.ts", line: 42 }
2. debugger_trace_start { maxBuffer: 50 }
3. (run your test suite / hit the endpoint repeatedly)
4. debugger_trace_stop {}                → all hits with locals; analyze the pattern
5. debugger_remove_breakpoint { id: 1 }
```

### Frontend → backend handoff

```
1. debugger_state    { target: "frontend" }   → paused as the request leaves the browser
2. debugger_eval     { target: "frontend", expr: "JSON.parse(body)" }
3. debugger_continue { target: "frontend" }    → request flies to the backend
4. debugger_state    {}                        → paused in the backend handler
5. debugger_eval     { expr: "user.role" }
6. debugger_continue {}
```

### Live inspection of a stuck process

```
1. debugger_pause {}
2. debugger_state {}
3. debugger_eval { expr: "global.connectionPool.size" }
4. debugger_continue {}
```

---

## MCP tools quick reference

All tools accept an optional `target` (`"frontend"` / `"backend"`, default backend) and `worker`.

| Tool | Params | Blocks? | Description |
|------|--------|:------:|-------------|
| `debugger_state` | — | no | Pause location, source window, locals |
| `debugger_eval` | `expr` | no | Evaluate JS — paused: frame scope; running: global scope |
| `debugger_continue` | — | **yes** | Resume until next breakpoint (30s timeout) |
| `debugger_step_over` | — | no | Next line, returns new state |
| `debugger_step_into` | — | no | Enter function, returns new state |
| `debugger_step_out` | — | no | Exit function, returns new state |
| `debugger_pause` | — | no | Force-pause a running process |
| `debugger_set_breakpoint` | `file`, `line`, `condition?` | no | Set a breakpoint (optionally conditional) |
| `debugger_remove_breakpoint` | `id` | no | Remove a breakpoint |
| `debugger_list_breakpoints` | — | no | List active breakpoints |
| `debugger_backtrace` | — | no | Call stack (source-mapped) |
| `debugger_source` | `file?` | no | Full source of the current file (source-mapped) |
| `debugger_trace_start` | `maxBuffer?` | no | Start non-blocking trace mode |
| `debugger_trace_stop` | — | no | Stop trace, return all hits |
| `debugger_trace_status` | — | no | Peek at the trace buffer |
| `debugger_workers` | — | no | List worker-thread sessions |

That's every feature. For the API reference, HTTP endpoints, and the programmatic core, see the [README](README.md).
