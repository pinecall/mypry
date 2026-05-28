# HTTP API Reference

mypry's daemon is a plain HTTP server. The MCP bridge and `mypry watch` are just thin clients over these endpoints — any script, agent, or tool can use them directly.

## Base URL

```
http://127.0.0.1:3098    # default (mypry serve)
http://127.0.0.1:3099    # Aurora TUI
```

---

## Endpoints

### `GET /health`

Check if the daemon is running and connected to the debugger.

```bash
curl http://localhost:3098/health
```

```json
{ "ok": true, "connected": true, "status": "running" }
```

| Field | Values |
|-------|--------|
| `status` | `"running"` · `"paused"` · `"disconnected"` |

---

### `GET /state`

Current debugger state. If paused, includes file, line, function, locals, and a source window.

```json
{
  "status": "paused",
  "file": "src/auth/auth.service.ts",
  "line": 151,
  "function": "validateUser",
  "source_window": [
    { "line": 149, "text": "    // eslint-disable-next-line no-debugger" },
    { "line": 151, "text": "    debugger;", "current": true },
    { "line": 153, "text": "    return user;" }
  ],
  "locals": { "emailAddress": "admin@test.com", "isMatch": true }
}
```

If running: `{ "status": "running" }`.

---

### `GET /backtrace`

Call stack frames, source-mapped.

```json
{
  "frames": [
    { "function": "validateUser", "file": "src/auth/auth.service.ts", "line": 151 },
    { "function": "LocalStrategy.validate", "file": "src/auth/local.strategy.ts", "line": 22 }
  ]
}
```

---

### `GET /breakpoints`

List all active breakpoints.

```json
{
  "breakpoints": [
    { "id": 1, "file": "auth.service.ts", "line": 151, "condition": "email === 'admin@test.com'" }
  ]
}
```

---

### `GET /workers`

List worker thread sessions.

```json
{
  "workers": [
    { "sessionId": "1", "title": "[worker 1] metrics" }
  ],
  "count": 1
}
```

---

### `GET /traces`

Peek at the trace buffer (if tracing is active).

```json
{
  "tracing": true,
  "count": 3,
  "hits": [
    { "timestamp": 1779919970886, "line": 12, "function": "authenticate", "locals": { "email": "alice@example.com" } }
  ]
}
```

---

### `GET /events`

**Server-Sent Events (SSE)** stream. Connect once, receive events in realtime.

```bash
curl -N http://localhost:3098/events
```

Events emitted:

| Event | When | Data |
|-------|------|------|
| `paused` | Debugger pauses | Full state snapshot (same as `/state`) |
| `resumed` | Debugger resumes | `{ "status": "running" }` |
| `disconnected` | CDP connection lost | `{ "status": "disconnected" }` |
| `op` | Agent sends a command | `{ "op": "eval", "target": "backend", "params": {...} }` |
| `op-result` | Command completes | `{ "op": "eval", "target": "backend", "result": {...} }` |

`mypry watch` consumes this stream.

---

### `POST /command`

Execute a single debugger operation.

```bash
curl -X POST http://localhost:3098/command \
  -H 'Content-Type: application/json' \
  -d '{"op": "eval", "expr": "users.length"}'
```

```json
{ "ok": true, "type": "number", "value": 3, "description": "3" }
```

#### Routing

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `target` | `"backend"` · `"frontend"` | `"backend"` | Route to Node.js or Chrome |
| `worker` | string | — | Route to a worker thread session |

#### Operations

| `op` | Extra params | Returns |
|------|-------------|---------|
| `state` | — | Full state snapshot |
| `eval` | `expr` | `{ ok, type, value, description }` or `{ ok: false, error }` |
| `continue` | — | `{ status: "running" }` (blocks until next pause with `wait: true`) |
| `step_over` | — | New state |
| `step_into` | — | New state |
| `step_out` | — | New state |
| `pause` | — | State at pause point |
| `set_breakpoint` | `file`, `line`, `condition?` | `{ ok, id }` |
| `remove_breakpoint` | `id` | `{ ok }` |
| `breakpoints` | — | Breakpoint list |
| `backtrace` | — | Call stack |
| `source` | `file?` | Source of current/specified file |
| `locals` | — | Frame locals |
| `trace_start` | `maxBuffer?` | `{ ok, tracing }` |
| `trace_stop` | — | `{ ok, count, hits }` |
| `trace_status` | — | `{ tracing, count, hits }` |
| `workers` | — | Worker list |

#### Blocking with `wait: true`

For `continue`, `step_over`, `step_into`, `step_out` — add `"wait": true` to block until the debugger pauses again (30s timeout):

```bash
curl -X POST http://localhost:3098/command \
  -d '{"op": "continue", "wait": true}'
# → blocks until next breakpoint, then returns the paused state
```

---

### `POST /batch`

Execute multiple operations in sequence.

```bash
curl -X POST http://localhost:3098/batch \
  -d '{"ops": [{"op": "eval", "expr": "a"}, {"op": "eval", "expr": "b"}]}'
```

```json
{
  "results": [
    { "ok": true, "value": 1 },
    { "ok": true, "value": 2 }
  ]
}
```

---

## Authentication

Add `--token` to the daemon to require a Bearer token:

```bash
mypry serve --token s3cr3t
```

```bash
curl -H 'Authorization: Bearer s3cr3t' http://localhost:3098/health
```

### Read-write / read-only tokens

Use comma-separated `token:perm` pairs:

```bash
mypry serve --token "admin:rw,viewer:ro"
```

- **rw** tokens can execute any operation
- **ro** tokens can only read state — `state`, `backtrace`, `breakpoints`, `workers`, `traces`, `eval`
- Write ops (`continue`, `step_*`, `set_breakpoint`, `remove_breakpoint`, `trace_start`, `trace_stop`) require an `rw` token

---

## CORS

The daemon allows all origins by default for localhost development tooling. For production/remote use, consider adding `--token` and running behind a reverse proxy with proper CORS headers.
