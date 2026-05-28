# MCP Setup Guide

Connect your AI agent to mypry. The architecture: a **stateless MCP bridge** on stdio talks to the **mypry daemon** over HTTP. The daemon owns the CDP connection to your app.

```
Agent ── stdio ──▶ mcp-bridge.js ── HTTP ──▶ mypry daemon ── CDP ──▶ your app
                   (starts instantly)         (mypry serve)
```

---

## Step 1: Start the daemon

```bash
mypry serve                                          # backend only
mypry serve --frontend http://localhost:3001          # + frontend
```

Or use a [`.mypry.json`](../README.md#project-config-mypryconfig) in your project root for zero-flag startup.

---

## Step 2: Configure your agent

### Claude Code

`~/.claude/mcp.json`:

```json
{
  "mcpServers": {
    "mypry": {
      "command": "node",
      "args": ["/absolute/path/to/mypry/dist/mcp-bridge.js"],
      "env": { "MYPRY_URL": "http://127.0.0.1:3098" }
    }
  }
}
```

### Cursor

`~/.cursor/mcp.json`: same `mcpServers` block as Claude Code.

### Antigravity

`~/.gemini/config/mcp_config.json` (no outer `mcpServers` wrapper):

```json
{
  "mypry": {
    "command": "/path/to/node",
    "args": ["/absolute/path/to/mypry/dist/mcp-bridge.js"],
    "env": { "MYPRY_URL": "http://127.0.0.1:3098" }
  }
}
```

> Antigravity may need the full path to `node` (e.g. from `which node`).

### Codex / OpenAI

Codex doesn't support MCP. Use the HTTP API directly:

```bash
mypry serve
curl -X POST http://localhost:3098/command -d '{"op":"state"}'
```

See [`docs/http-api.md`](http-api.md) for the full reference.

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MYPRY_URL` | `http://127.0.0.1:3098` | Daemon URL. Change for remote servers or custom ports. |

Examples:

```bash
MYPRY_URL=http://127.0.0.1:3098              # default
MYPRY_URL=http://127.0.0.1:3099/api/debugger # Aurora TUI
MYPRY_URL=http://staging-server:3098          # remote server
```

---

## Verify it works

After restarting your agent, ask it:

```
You: What debugger tools do you have?
```

It should list `debugger_state`, `debugger_eval`, etc. If not:

1. Is the daemon running? → `curl http://localhost:3098/health`
2. Is the bridge path correct? → Check `args` in your MCP config
3. Is Node found? → Antigravity may need the absolute path

---

## Available MCP tools

All tools accept optional `target` (`"frontend"` / `"backend"`) and `worker` params.

| Tool | Blocks? | Description |
|------|:------:|-------------|
| `debugger_state` | no | Current pause: file, line, function, locals, source window |
| `debugger_eval` | no | Evaluate JS — paused: frame scope; running: global scope |
| `debugger_continue` | **yes** | Resume until next breakpoint (30s timeout) |
| `debugger_step_over` / `_into` / `_out` | no | Step; returns new state |
| `debugger_pause` | no | Force-pause a running process |
| `debugger_set_breakpoint` | no | `file`, `line`, optional `condition` |
| `debugger_remove_breakpoint` / `_list_breakpoints` | no | Manage breakpoints |
| `debugger_backtrace` / `_source` | no | Call stack / full source (source-mapped) |
| `debugger_trace_start` / `_stop` / `_status` | no | Non-blocking trace mode |
| `debugger_workers` | no | List worker-thread sessions |
