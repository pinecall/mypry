# Skill: mypry — Interactive Debugger for AI Agents

> **When to read this:** Whenever you need to debug a running Node.js process, set breakpoints, inspect variables at runtime, step through code, trace execution, or debug frontend (Chrome CDP).

---

## Setup

### 1. Install

```bash
npm install -g mypry     # installs: mypry (CLI) + mypry-bridge (MCP)
```

### 2. Start your app with inspector

```bash
node --inspect server.js           # backend on :9229 (default)
node --inspect=9230 server.js      # custom port
```

### 3. Start the daemon

```bash
mypry serve                        # connects to :9229, HTTP on :3098
```

> `mypry serve` also shows **live watch output** — you see every pause, eval, step, and continue in realtime. No separate `mypry watch` needed.

### 4. Configure your AI agent

Add to your MCP config:

```json
{
  "mypry": {
    "command": "mypry-bridge"
  }
}
```

That's it. Defaults to `http://127.0.0.1:3098`.

**Config file locations by agent:**

| Agent | Config file |
|-------|-------------|
| Antigravity (Gemini) | `~/.gemini/config/mcp_config.json` → `mcpServers` |
| Claude Code | `~/.claude/settings.json` → `mcpServers` |
| Cursor | `.cursor/mcp.json` → `mcpServers` |
| Codex (OpenAI) | `codex.json` → `mcpServers` |

If the daemon runs on a **non-default port** or behind a **TUI proxy**, set the URL:

```json
{
  "mypry": {
    "command": "mypry-bridge",
    "env": { "MYPRY_URL": "http://127.0.0.1:3099" }
  }
}
```

> **TUI proxy users:** If your project uses a TUI that embeds mypry (e.g. a startup script that manages the CDP connection), you **must** set `MYPRY_URL` to the TUI's debugger endpoint. The default `:3098` won't reach it.

---

## MCP Tools

### Inspection (safe, read-only)

| Tool | Params | Description |
|------|--------|-------------|
| `debugger_state` | — | Current pause: file, line, function, locals, source window |
| `debugger_eval` | `expr` | Evaluate JS — paused: frame scope; running: global scope |
| `debugger_backtrace` | — | Call stack frames |
| `debugger_source` | `file?` | Full source (source-mapped) |
| `debugger_list_breakpoints` | — | All active breakpoints |
| `debugger_trace_status` | — | Peek at trace buffer |
| `debugger_workers` | — | List worker threads |

### Execution Control

| Tool | Params | Blocks? | Description |
|------|--------|:------:|-------------|
| `debugger_continue` | — | **yes** | Resume until next breakpoint (30s timeout) |
| `debugger_step_over` | — | no | Next line |
| `debugger_step_into` | — | no | Into function |
| `debugger_step_out` | — | no | Out of function |
| `debugger_pause` | — | no | Force-pause running process |
| `debugger_set_breakpoint` | `file`, `line`, `condition?` | no | Set breakpoint (supports .ts via source maps) |
| `debugger_remove_breakpoint` | `id` | no | Remove by ID |

### Trace Mode (non-blocking)

| Tool | Params | Description |
|------|--------|-------------|
| `debugger_trace_start` | `maxBuffer?` | Auto-resume + collect snapshots |
| `debugger_trace_stop` | — | Stop, return all hits |
| `debugger_trace_status` | — | Peek without stopping |

---

## Debugging Workflows

### Best practice: dynamic breakpoints (no code changes)

**Prefer `debugger_set_breakpoint` over `debugger;` statements.** This way you never modify source code to debug.

```
→ debugger_set_breakpoint { file: "auth.service.ts", line: 147 }
← { ok: true, id: 1 }

(trigger the code path — e.g. curl, browser click)

→ debugger_state
← {
    status: "paused",
    file: "src/auth/auth.service.ts",
    line: 147,
    function: "validateUser",
    locals: { emailAddress: "alice@test.com", isMatch: true }
  }

→ debugger_eval { expr: "user.role.slug" }
← { ok: true, value: "admin" }

→ debugger_continue
← { status: "running" }
```

> **TypeScript supported:** `set_breakpoint("file.ts", line)` automatically resolves to the compiled `.js` via source maps. Works with `tsc`, NestJS, Vite, etc.

### Conditional breakpoints

```
→ debugger_set_breakpoint {
    file: "auth.service.ts",
    line: 147,
    condition: "emailAddress === \"admin@test.com\""
  }
```

Only pauses when the condition is truthy. Other requests pass through.

### Trace mode (observe without blocking)

```
→ debugger_set_breakpoint { file: "handler.ts", line: 42 }
→ debugger_trace_start { maxBuffer: 50 }

(app keeps running, breakpoints auto-resume and capture snapshots)

→ debugger_trace_stop
← { count: 12, hits: [...] }
```

### Frontend debugging

Works with **any framework** — React, Vue, Angular, Svelte, plain JS. Anything running in Chrome.

```
→ debugger_eval { target: "frontend", expr: "document.title" }
→ debugger_eval { target: "frontend", expr: "document.querySelector('#app').textContent" }
→ debugger_set_breakpoint { target: "frontend", file: "Login.tsx", line: 42 }
```

> Vue `ref()` and Pinia `$state` are auto-unwrapped. React/Angular/vanilla objects returned as-is.

Requires Chrome with `--remote-debugging-port=9222`. Start with `mypry open <url>`.

---

## Important Behavior

1. **`debugger_continue` BLOCKS** — waits up to 30s for next pause. Don't call unless you expect a breakpoint to fire.
2. **Trace mode is non-blocking** — app runs normally, breakpoints auto-resume.
3. **Source maps are automatic** — TypeScript paths shown in state, backtrace, source.
4. **Global eval when not paused** — `debugger_eval` falls back to `Runtime.evaluate` (global scope).
5. **Auto-reconnect** — survives process restarts (nodemon, NestJS `--watch`). Breakpoints are re-set.

---

## CLI Quick Reference

```bash
mypry serve                                    # daemon on :3098 (+ live watch)
mypry serve --frontend http://localhost:3001   # + Chrome CDP
mypry serve --port 3099 --inspect 9230         # custom ports
mypry watch                                    # remote monitor (SSE)
mypry open http://localhost:3001               # launch debug Chrome
mypry attach                                   # interactive REPL
mypry inject <PID>                             # enable inspector on running PID
```

---

## Installing this Skill in Your Project

Copy this file to your project and reference it from your agent's config:

**Antigravity:** Copy to `.agents/skills/debugger/SKILL.md`

**Claude Code:** Add to your `CLAUDE.md`:
```
For runtime debugging, read skills/SKILL.md
```

**Codex:** Add to your `AGENTS.md`:
```
For runtime debugging, read skills/SKILL.md
```
