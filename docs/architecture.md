# Architecture

How mypry works internally: components, transports, and data flow.

---

## Component diagram

```
your app                          mypry daemon
────────                          ────────────────────────────────────
                                  ┌──────────────────────────────────┐
debugger ─ V8 inspector :9229 ─▶  │  DebuggerSession (backend)      │
                                  │   ├─ pause / step / eval          │
pry()    ─ V8 inspector :9229 ─▶  │   ├─ breakpoints (conditional)   │
                                  │   ├─ trace mode (non-blocking)   │
debugger ─ Chrome CDP   :9222 ─▶  │   ├─ source maps (.ts, .vue)    │
                                  │   ├─ Vue/Pinia unwrap            │
workers  ─ V8 inspector       ─▶  │   ├─ worker threads              │
                                  │   └─ auto-reconnect              │
                                  │                                  │
                                  │  DebuggerSession (frontend)      │
                                  │   └─ same API, routed via target │
                                  │                                  │
                                  │  Transports                      │
                                  │   ├─ HTTP + SSE   (daemon)       │
                                  │   ├─ ndjson stdio (embedders)    │
                                  │   ├─ REPL         (interactive)  │
                                  │   └─ MCP bridge   (agents)       │
                                  └──────────────────────────────────┘
```

---

## The two-process model

```
agent ── stdio ──▶ mcp-bridge ── HTTP :3098 ──▶ daemon ── CDP ──▶ app
                   (stateless)                   (stateful)
```

**Why two processes?**

MCP servers start when the agent launches. If the MCP server itself owned the CDP connection, every agent restart would:
- Drop breakpoints
- Lose trace buffers
- Fail the handshake while waiting for CDP reconnect

The **daemon** (`mypry serve`) is long-lived: it owns the CDP connection, survives agent restarts, auto-reconnects on app restarts, and stores breakpoints and trace state.

The **bridge** (`mcp-bridge.js`) is stateless: it starts instantly, translates MCP tool calls to HTTP requests, and forwards them to the daemon. If the agent restarts, the bridge restarts, but the daemon stays up.

---

## Transport layer

mypry supports four transports, all using the same `executeOp` dispatcher:

| Transport | Use case | Protocol |
|-----------|----------|----------|
| **HTTP + SSE** | Daemon mode for agents | `POST /command`, `GET /events` |
| **ndjson** | Embedders, scripts | newline-delimited JSON on stdio |
| **REPL** | Human interactive use | readline on stdin |
| **MCP** | AI agents (via bridge) | JSON-RPC 2.0 on stdio |

All transports call the same `executeOp(session, { op, ...params })` function, so behavior is identical across them.

---

## CDP connection

### CDPClient

A minimal Chrome DevTools Protocol client. Zero dependencies, ~200 lines. Handles:
- WebSocket connection to the inspector
- Request/response correlation (by `id`)
- Event dispatching
- Domain enabling (`Debugger`, `Runtime`)

### Auto-reconnect

When the CDP WebSocket drops (app restart, `nodemon`, NestJS `--watch`):

1. `CDPClient` detects the close
2. `DebuggerSession` emits `disconnected`
3. Reconnect loop: try every 2 seconds, up to 40 seconds
4. On reconnect: re-enable debugger, re-apply breakpoints
5. Emit `reconnected`

The daemon stays up through the entire cycle. Agents just see a brief `"status": "disconnected"` and then it's back.

---

## Source map resolution

When the debugger pauses, V8 reports the **compiled** file (e.g. `dist/auth/auth.service.js:136`). mypry resolves to the **original** source:

1. Read the compiled file from disk (via `Debugger.getScriptSource` or filesystem)
2. Parse the `//# sourceMappingURL` comment
3. Load the `.map` file
4. Map `(compiled_line, column)` → `(original_file, original_line)`
5. Scan columns 0–79 to find mappings (handles indented `debugger;` statements)
6. Return the original file and line in `state`, `backtrace`, and `source`

For Vite frontend files, URL cleanup strips query strings:
```
http://localhost:3001/src/Login.vue?t=12345  →  src/Login.vue
```

---

## Trace mode

Non-blocking observation mode. When tracing is active:

1. Debugger pauses at a breakpoint
2. Instead of waiting for `continue`, mypry:
   - Captures a snapshot (file, line, function, locals, timestamp)
   - Appends to the trace buffer (capped at `maxBuffer`)
   - Immediately resumes execution
3. The app never blocks — requests flow normally
4. Agent calls `trace_stop` to collect all hits

This is implemented as a flag on `DebuggerSession.paused` handler: if `tracing`, auto-resume with snapshot capture.

---

## Worker threads

When `--workers` is enabled (default in `mypry serve`):

1. The daemon listens for `NodeWorker.attachedToWorker` CDP events
2. For each worker, creates a child `DebuggerSession` using `NodeWorker.sendMessageToWorker`
3. Workers are addressable by `sessionId` via the `worker` param on any tool
4. `debugger_workers` lists active worker sessions

Workers share the same HTTP port and daemon — no separate processes.

---

## SSE event stream

`GET /events` provides a Server-Sent Events stream for real-time monitoring:

| Event | Trigger | Data |
|-------|---------|------|
| `paused` | Debugger pauses | Full state snapshot |
| `resumed` | Debugger resumes | `{ status: "running" }` |
| `disconnected` | CDP connection lost | `{ status: "disconnected" }` |
| `op` | Agent sends a command | `{ op, target, params }` |
| `op-result` | Command completes | `{ op, target, result }` |

`mypry watch` and custom TUIs consume this stream.

---

## File structure

```
mypry/
├── src/
│   ├── cli.ts                  # CLI entry: serve, attach, watch, open, inject
│   ├── mcp-bridge.ts           # Stateless MCP → HTTP proxy
│   ├── core/
│   │   ├── cdp.ts              # CDPClient (WebSocket, zero deps)
│   │   ├── session.ts          # DebuggerSession (pause/step/eval/trace)
│   │   ├── snapshot.ts         # Build state snapshots
│   │   ├── ops.ts              # executeOp dispatcher
│   │   ├── targets.ts          # Inspector/Chrome target discovery
│   │   ├── source-map.ts       # Source map resolution
│   │   └── index.ts            # Public API exports
│   └── transports/
│       ├── http.ts             # HTTP + SSE server
│       ├── ndjson.ts           # ndjson stdio transport
│       ├── repl.ts             # Interactive REPL
│       └── mcp.ts              # Direct MCP on stdio
├── docs/                       # Detailed documentation
├── test/                       # Integration tests
├── .agents/skills/SKILL.md     # AI agent instructions
├── TUTORIAL.md                 # Hands-on walkthrough
└── README.md                   # Overview + quickstart
```
