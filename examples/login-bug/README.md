# Debugging a real bug with mypry — a live agent session

> A complete, **unedited transcript** of an AI agent finding a backend bug by
> driving the browser and pausing the server **in a single session** — no
> `console.log`, no restarts, no guessing. Every output block below is real
> `mypry` output, exactly what the agent receives over MCP.
>
> The app under test is [`server.cjs`](./server.cjs) in this folder.

---

## The bug

Acme's admin login returns **`403 — forbidden: admins only`** for Alice, who *is*
an admin. The password is right (she doesn't get a 401), so something in the
handler is wrong. The agent has never seen this code before.

```js
const user = sanitizeUser(dbUser)
if (user.role !== 'admin') {            // ← returns 403 for everyone
  res.writeHead(403); res.end('forbidden: admins only'); return
}
```

Let's watch the agent find it.

---

## The session

### 1 · Attach to both sides — `debugger_inject`

The agent attaches to the **already-running** server (no `--inspect`, no restart)
and opens a headless browser pointed at the same app — one call, both sides.

```jsonc
// → debugger_inject { appPort: 3060, frontend: "http://127.0.0.1:3060" }
{
  "backend":  { "connected": true, "target": "examples/login-bug/server.cjs" },
  "browser":  { "connected": true, "url": "http://127.0.0.1:3060" },
  "injected": { "pid": 94084, "inspectorPort": 9229, "appPort": 3060, "program": "server.cjs" }
}
```

> Backend **and** browser connected. No loader soup — just `pid`, port, and the
> program name. (Already running with `--inspect`? Use `debugger_connect { port }`
> instead — same shape, minus the `injected` block.)

### 2 · See the page — `debugger_snapshot`

Before touching the UI, the agent reads the accessibility tree to learn the
selectors — never guess them.

```yaml
# → debugger_snapshot
- heading "Admin sign in" [level=1]
- textbox "Email"
- textbox "Password"
- button "Sign in"
- paragraph
```

> Now it knows the handles: `textbox Email`, `textbox Password`, `button Sign in`.

### 3 · Set the trap — `debugger_set_breakpoint`

```jsonc
// → debugger_set_breakpoint { file: "server.cjs", line: 62 }
{ "ok": true, "id": 1, "file": "server.cjs", "line": 62 }
```

### 4 · Reproduce from the UI — `debugger_browse`  ⭐

The agent fills the form and clicks **Sign in**. The click hits the backend, the
breakpoint fires mid-request — and the pause comes back **attached to the same
response**. One call drives the UI *and* catches the server.

```jsonc
// → debugger_browse { actions: [
//     { "fill": ["textbox Email", "alice@corp.com"] },
//     { "fill": ["textbox Password", "hunter2"] },
//     { "click": "button Sign in" }
//   ] }
{
  "browser": { "ok": true, "completed": 3, "total": 3, "needsSnapshot": false },
  "backend": {
    "status": "paused",
    "file": "examples/login-bug/server.cjs",
    "line": 62,
    "function": "<anon>",
    "reason": "other",
    "source_window": [
      { "line": 61, "text": "      const user = sanitizeUser(dbUser)", "current": false },
      { "line": 62, "text": "      if (user.role !== 'admin') {            // ← the admin gate", "current": true },
      { "line": 63, "text": "        res.writeHead(403); res.end('forbidden: admins only'); return", "current": false }
    ],
    "locals": {
      "email": "alice@corp.com",
      "password": "[redacted]",
      "dbUser": { "id": 1, "email": "alice@corp.com", "password": "[redacted]", "role": "admin" },
      "user":   { "id": 1, "email": "alice@corp.com" },
      "__closure__": {
        "res": { "@": "ServerResponse", "statusCode": 200, "headersSent": false, "finished": false },
        "sanitizeUser": "[Function: function sanitizeUser]",
        "USERS": { "alice@corp.com": { "id": 1, "email": "alice@corp.com", "password": "[redacted]", "role": "admin" } }
      }
    },
    "call_stack": [
      { "function": "<anon>", "file": "examples/login-bug/server.cjs", "line": 62 }
    ]
  }
}
```

> **There it is.** `dbUser.role` is `"admin"`, but `user` — the value the check
> actually reads — **has no `role` at all**. Something between the DB row and the
> gate dropped it.
>
> Notice the output is already clean: passwords are `[redacted]`, `res` collapses
> to one line instead of a 500-line socket graph, and the call stack is **just our
> code** — no `node:http` / `node_modules` frames. The whole pause reads in one
> screen.

### 5 · Confirm the culprit — `debugger_eval`

`debugger_eval` is the **unbounded escape hatch**: it returns full values and is
never redacted, so the agent can drill in once it knows what it wants.

```jsonc
// → debugger_eval { expr: "user" }                  the value the gate reads
{ "ok": true, "target": "backend", "value": { "id": 1, "email": "alice@corp.com" } }

// → debugger_eval { expr: "dbUser.role" }           the DB had it all along
{ "ok": true, "target": "backend", "value": "admin", "type": "string" }

// → debugger_eval { expr: "sanitizeUser(dbUser)" }  call the suspect, live
{ "ok": true, "target": "backend", "value": { "id": 1, "email": "alice@corp.com" } }
```

> Calling `sanitizeUser(dbUser)` right at the pause returns `{ id, email }` — it
> **silently drops `role`**. That's the bug, proven by execution, not by reading.

The agent can hop to the **frontend** in the same breath:

```jsonc
// → debugger_eval { expr: "document.title", target: "browser" }
{ "ok": true, "target": "browser", "value": "Acme Admin" }
```

### 6 · Watch it take the wrong branch — `debugger_step`

```jsonc
// → debugger_step { mode: "over" }
{ "status": "paused", "file": "examples/login-bug/server.cjs", "line": 63,
  "function": "<anon>", "reason": "step",
  "source_window": [
    { "line": 62, "text": "      if (user.role !== 'admin') {", "current": false },
    { "line": 63, "text": "        res.writeHead(403); res.end('forbidden: admins only'); return", "current": true }
  ],
  "locals": { "email": "alice@corp.com", "user": { "id": 1, "email": "alice@corp.com" } },
  "call_stack": [ { "function": "<anon>", "file": "examples/login-bug/server.cjs", "line": 63 } ]
}
```

> Stepping over the `if` lands on **line 63 — the 403** — confirming the gate
> rejects a real admin.

### 7 · See what's armed — `debugger_breakpoints`

```jsonc
// → debugger_breakpoints
{ "breakpoints": [ { "id": 1, "file": "server.cjs", "line": 62, "kind": "breakpoint" } ],
  "exceptionBreakpoint": "none" }
```

### 8 · Resume — `debugger_continue`

```jsonc
// → debugger_continue
{ "status": "running" }
```

### 9 · Confirm the symptom on the frontend — `debugger_eval` (browser)

After resuming, the request completes and the page renders the result. The agent
reads it straight from the DOM:

```jsonc
// → debugger_eval { expr: "document.querySelector('#result').textContent", target: "browser" }
{ "ok": true, "target": "browser", "value": "403 — forbidden: admins only" }
```

> Full circle: the UI shows exactly the 403 the breakpoint predicted.

### 10 · More ways to catch it — exception + logpoints

Don't know *where* something throws? Break on every exception. Want a trace
without pausing? Drop a logpoint.

```jsonc
// → debugger_set_breakpoint { exception: "all" }
{ "ok": true, "exception": "all" }

// → debugger_set_breakpoint { file: "server.cjs", line: 61, logMessage: "role={user.role}" }
{ "ok": true, "id": 2, "file": "server.cjs", "line": 61, "logMessage": "role={user.role}" }

// → debugger_breakpoints
{ "breakpoints": [
    { "id": 1, "file": "server.cjs", "line": 62, "kind": "breakpoint" },
    { "id": 2, "file": "server.cjs", "line": 61, "kind": "logpoint", "condition": "role={user.role}" }
  ],
  "exceptionBreakpoint": "all" }
```

### 11 · Done — `debugger_disconnect`

```jsonc
// → debugger_disconnect
{ "disconnected": true }
```

---

## The fix

`sanitizeUser` strips the field the gate depends on. Carry it through:

```diff
 function sanitizeUser(u) {
-  return { id: u.id, email: u.email }
+  return { id: u.id, email: u.email, role: u.role }
 }
```

The agent never added a print statement, never restarted the server, and saw the
DB value, the sanitized value, and the live function result side by side.

---

## How to read mypry output (the part agents should internalize)

mypry treats your context window as the scarce resource. Every pause is **bounded
and summarized by default**, with a deterministic escape hatch when you need more:

| Default behavior | Why | How to get the raw thing |
|---|---|---|
| `req`/`res`/sockets/streams → one-line summary | a real `req` is hundreds of lines | `debugger_eval { expr: "req.headers" }` |
| objects capped at depth 4, arrays at 100, strings at 1024 | avoid multi-thousand-line dumps | `debugger_state { depth: 8 }` or `{ expand: "path.to.value" }` |
| secret-looking keys (`password`, `token`, `cookie`, …) → `[redacted]` | don't leak creds into the transcript | `debugger_eval { expr: "token" }` — eval is **never** redacted |
| call stack hides `node_modules`/internal frames | show *your* code | `debugger_state { fullStack: true }` |
| `[unset]`/empty locals dropped | pure noise | — |

**Rule of thumb:** `debugger_state` to orient cheaply → `debugger_eval` / `expand`
to drill into exactly the value you care about.

---

## Every tool, at a glance

| Tool | What it does |
|---|---|
| `debugger_inject` | Attach to a running Node process by app port (no `--inspect`); optional `frontend` opens a browser |
| `debugger_connect` | Same, for an app already started with `--inspect` (`{ port }`) |
| `debugger_snapshot` | ARIA tree of the page — discover selectors |
| `debugger_set_breakpoint` | Line, `condition`, `logMessage` (logpoint), `hitCount`, or `exception: all\|uncaught\|none` |
| `debugger_browse` | Drive the UI with JSON actions; auto-attaches the backend pause if one fires |
| `debugger_state` | Bounded/redacted pause snapshot (`expand`, `depth`, `fullStack` to widen) |
| `debugger_eval` | Evaluate anything — `target: "backend"` (frame scope) or `"browser"` (DOM); unbounded |
| `debugger_step` | `over` / `into` (auto-skips framework) / `out` |
| `debugger_continue` | Resume to the next breakpoint (`timeoutMs` to wait longer) |
| `debugger_breakpoints` | List / remove breakpoints (`{ remove: id }`) |
| `debugger_disconnect` | Tear down the session and browser |

---

## Run it yourself

```bash
# 1. start the buggy app (no inspector flag — mypry injects one)
node examples/login-bug/server.cjs        # http://127.0.0.1:3060

# 2. from your agent, reproduce the session above:
debugger_inject { appPort: 3060, frontend: "http://127.0.0.1:3060" }
debugger_snapshot
debugger_set_breakpoint { file: "server.cjs", line: 62 }
debugger_browse { actions: [
  { "fill": ["textbox Email", "alice@corp.com"] },
  { "fill": ["textbox Password", "hunter2"] },
  { "click": "button Sign in" }
]}
# → backend pauses at line 62; debugger_state shows user has no role.
```
