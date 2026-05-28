# MCP Setup Guide

Connect your AI agent to mypry. The architecture: a **stateless MCP bridge** on stdio talks to the **mypry daemon** over HTTP. The daemon owns the CDP connection to your app.

```
Agent ── stdio ──▶ mypry-bridge ── HTTP ──▶ mypry daemon ── CDP ──▶ your app
                   (starts instantly)        (mypry serve)
```

---

## Step 1: Install

```bash
npm install -g mypry
```

This gives you two commands:
- `mypry` — CLI (daemon, watch, attach, inject)
- `mypry-bridge` — MCP bridge (what your agent runs)

---

## Step 2: Start the daemon

```bash
mypry serve                                          # backend only
mypry serve --frontend http://localhost:3001          # + frontend
```

Or use a [`.mypry.json`](../README.md#project-config-mypryconfig) in your project root for zero-flag startup.

---

## Step 3: Configure your agent

### Claude Code

`~/.claude/mcp.json`:

```json
{
  "mcpServers": {
    "mypry": {
      "command": "mypry-bridge"
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
    "command": "mypry-bridge"
  }
}
```

### Project-local install (no global)

If you prefer `npm install mypry` (local), use `npx`:

```json
{
  "mcpServers": {
    "mypry": {
      "command": "npx",
      "args": ["mypry-bridge"]
    }
  }
}
```

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
| `MYPRY_URL` | `http://127.0.0.1:3098` | Daemon URL. Only set when using a custom port or remote server. |

```bash
# Default — no env needed
mypry-bridge

# Custom port
MYPRY_URL=http://127.0.0.1:3099

# Aurora TUI
MYPRY_URL=http://127.0.0.1:3099/api/debugger

# Remote server (via SSH tunnel)
MYPRY_URL=http://127.0.0.1:3099
```

For remote, add the env to your MCP config:

```json
{
  "mcpServers": {
    "mypry": {
      "command": "mypry-bridge",
      "env": { "MYPRY_URL": "http://127.0.0.1:3099" }
    }
  }
}
```

---

## Verify it works

After restarting your agent, ask it:

```
You: What debugger tools do you have?
```

It should list `debugger_state`, `debugger_eval`, etc. If not:

1. Is the daemon running? → `curl http://localhost:3098/health`
2. Is `mypry-bridge` on PATH? → `which mypry-bridge`
3. Agent can't find it? → use `npx mypry-bridge` or the full path

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
