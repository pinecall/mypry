# Skill: mypry Debugger (MCP + HTTP)

> **When to read this file:** Whenever you need to debug a running Node.js process, inspect variables at runtime, set breakpoints, trace execution, or interact with worker threads.

---

## Overview

mypry is an inline debugger for Node.js. It connects via Chrome DevTools Protocol (CDP) to a running process and lets you inspect, eval, step, and continue — all via HTTP API or MCP tools.

**Two ways to use from Antigravity:**

| Method | When | How |
|--------|------|-----|
| **MCP tools** | mypry MCP server is configured | Call `mcp_mypry_*` tools directly |
| **HTTP API** | Process has mypry HTTP on :3099 or :3098 | `curl` commands via `run_command` |

---

## MCP Tools Reference

When the mypry MCP server is active, these tools are available:

### Inspection (safe, read-only)

| Tool | Params | Description |
|------|--------|-------------|
| `mcp_mypry_debugger_state` | — | Current pause state: file, line, function, locals, source window |
| `mcp_mypry_debugger_eval` | `expr`, `worker?` | Evaluate JS expression in current scope |
| `mcp_mypry_debugger_backtrace` | — | Call stack frames |
| `mcp_mypry_debugger_source` | `file?` | Full source code of current file |
| `mcp_mypry_debugger_list_breakpoints` | — | All active breakpoints |
| `mcp_mypry_debugger_trace_status` | — | Peek at trace buffer without stopping |
| `mcp_mypry_debugger_workers` | — | List worker threads |

### Execution Control (mutating)

| Tool | Params | Description |
|------|--------|-------------|
| `mcp_mypry_debugger_continue` | — | Resume execution. **BLOCKS** until next pause or termination |
| `mcp_mypry_debugger_step` | `mode`: over/into/out | Step one line. Returns new state |
| `mcp_mypry_debugger_pause` | — | Force-pause a running process |
| `mcp_mypry_debugger_set_breakpoint` | `file`, `line`, `condition?` | Set breakpoint (optional condition) |
| `mcp_mypry_debugger_remove_breakpoint` | `id` | Remove breakpoint by ID |

### Trace Mode (non-blocking observation)

| Tool | Params | Description |
|------|--------|-------------|
| `mcp_mypry_debugger_trace_start` | `maxBuffer?` | Start trace — auto-resume, collect snapshots |
| `mcp_mypry_debugger_trace_stop` | — | Stop trace, return all hits |
| `mcp_mypry_debugger_trace_status` | — | Peek at buffer without stopping |

---

## Workflows

### 1. Inspect a Paused Debugger

```
1. mcp_mypry_debugger_state
   → see file, line, function, locals, source_window
2. mcp_mypry_debugger_eval {expr: "variableName"}
   → evaluate any expression in the paused scope
3. mcp_mypry_debugger_backtrace
   → see how we got here
```

### 2. Set a Conditional Breakpoint and Wait

```
1. mcp_mypry_debugger_set_breakpoint {
     file: "auth.service.ts",
     line: 151,
     condition: "emailAddress === \"superadmin@test.com\""
   }
2. mcp_mypry_debugger_continue
   → BLOCKS until the condition fires (superadmin logs in)
3. mcp_mypry_debugger_state
   → inspect the paused state
```

### 3. Trace Multiple Executions

```
1. mcp_mypry_debugger_set_breakpoint {file: "auth.service.ts", line: 151}
2. mcp_mypry_debugger_trace_start {maxBuffer: 100}
   → app keeps running, breakpoints auto-resume
3. (trigger actions — run tests, make API calls, etc.)
4. mcp_mypry_debugger_trace_stop
   → returns {count: N, hits: [{timestamp, file, line, function, locals}, ...]}
```

### 4. Debug Worker Threads

```
1. mcp_mypry_debugger_workers
   → [{sessionId: "1", title: "[worker 1] WorkerThread"}, ...]
2. mcp_mypry_debugger_eval {expr: "workerData", worker: "1"}
   → eval in specific worker's scope
```

---

## HTTP API Fallback

When MCP is not available, use HTTP directly:

```bash
# State
curl -s http://localhost:3099/api/debugger/state

# Eval
curl -s -X POST http://localhost:3099/api/debugger/command \
  -H 'Content-Type: application/json' \
  -d '{"op":"eval","expr":"emailAddress"}'

# Set conditional breakpoint
curl -s -X POST http://localhost:3099/api/debugger/command \
  -d '{"op":"set_breakpoint","file":"auth.service.ts","line":151,"condition":"emailAddress === \"superadmin@test.com\""}'

# Trace
curl -s -X POST http://localhost:3099/api/debugger/command -d '{"op":"trace_start"}'
curl -s -X POST http://localhost:3099/api/debugger/command -d '{"op":"trace_stop"}'

# Workers
curl -s http://localhost:3099/workers
curl -s -X POST http://localhost:3099/command -d '{"op":"state","worker":"1"}'

# Continue
curl -s -X POST http://localhost:3099/api/debugger/command -d '{"op":"continue"}'
```

> Note: Aurora's TUI exposes the API at `localhost:3099/api/debugger/*`.
> Standalone mypry HTTP uses `localhost:3098/*` (no `/api/debugger` prefix).

---

## Important Behavior Notes

1. **`debugger_continue` is BLOCKING** — it waits until the next breakpoint fires or the process terminates. Don't call it unless you expect another pause.

2. **Trace mode is non-blocking** — the app runs normally. Use it when you want to observe without interrupting.

3. **Conditional breakpoints are powerful** — `condition: "order.total > 10000"` means you only pause on expensive orders.

4. **Workers don't have separate ports** — they're accessed via the `worker` parameter on eval/state/continue commands.

5. **Source maps work** — breakpoints set on `.ts` files resolve to the correct compiled JS lines.

---

## Configuration

### Antigravity MCP (mcp_config.json)

```json
{
  "mypry": {
    "command": "/Users/berna/.nvm/versions/node/v24.14.0/bin/node",
    "args": [
      "/Users/berna/mypry/dist/cli.js",
      "attach",
      "--mcp",
      "--workers"
    ]
  }
}
```

### Claude Code (~/.claude/mcp.json)

```json
{
  "mcpServers": {
    "mypry": {
      "command": "mypry",
      "args": ["attach", "--mcp", "--workers"]
    }
  }
}
```

### Codex

Codex doesn't support MCP yet. Use the HTTP API:

```bash
# Start mypry HTTP alongside your process
mypry attach --http-only --http=3098 --workers
# Then use curl commands in Codex
```

---

## Prerequisites

- Target process running with `--inspect` (Aurora backend does this automatically)
- mypry installed: `npm link` from `~/mypry`
- For MCP: mypry MCP server configured in agent's MCP config
