# 🔮 mypry

**Node + browser debugger with inline `pry()` trigger — pairs with your AI agent.**

Drop `pry()` anywhere in your code. Execution freezes. Attach with a human REPL, pipe ndjson for agent orchestration, speak MCP to Claude Code, or curl the HTTP API.

```bash
npm install mypry
```

## Quick Start

### 1. Drop `pry()` in your code

```js
const pry = require('mypry')

async function processOrder(order) {
  const total = calculateTotal(order)
  pry() // 🔮 execution stops here
  await chargeCustomer(order.userId, total)
}
```

### 2. Attach

```bash
# Human REPL (default)
mypry attach

# AI agent (ndjson over stdio)
mypry attach --json

# MCP server (Claude Code / Cursor)
mypry attach --mcp

# HTTP API (curl / embedders)
mypry attach --http-only
```

### 3. Debug

```
─── /src/orders.ts:12  processOrder ───
    10 │ async function processOrder(order) {
    11 │   const total = calculateTotal(order)
►   12 │   pry()
    13 │   await chargeCustomer(order.userId, total)
    14 │ }

(mypry) order
=> {"id": "ord_123", "items": [{"sku": "A1", "qty": 2}]}

(mypry) total
=> 49.99

(mypry) next
►   13 │   await chargeCustomer(order.userId, total)
```

## Transports

| Flag | Protocol | Use case |
|------|----------|----------|
| *(none)* | Readline REPL | Human developer debugging |
| `--json` | ndjson over stdio | Agent orchestration (Aurora, custom) |
| `--mcp` | MCP over stdio | Claude Code, Cursor, Windsurf |
| `--http[=PORT]` | REST over HTTP | curl, browser devtools, embedders |
| `--http-only` | REST over HTTP | Headless daemon (no stdio) |

`--http` is a **side transport** — combine it with any stdio mode:

```bash
# REPL + HTTP (pair programming: you debug, agent queries via HTTP)
mypry attach --http

# Agent ndjson + HTTP dashboard
mypry attach --json --http=4000
```

## API

### Inline Trigger

```js
// CommonJS
const pry = require('mypry')
pry()
pry({ port: 9230 })
pry({ message: 'after auth' })

// ESM
import { pry } from 'mypry'
pry()

// Browser
import { pry } from 'mypry/browser'
pry({ message: 'before render' })
```

### REPL Commands

| Command | Action |
|---------|--------|
| `n`, `next` | Step over |
| `s`, `step` | Step into |
| `o`, `out` | Step out |
| `c`, `continue` | Resume |
| `l`, `list` | Source context |
| `bt`, `where` | Call stack |
| `locals` | Local variables |
| `break file:line` | Set breakpoint |
| `breakpoints` | List breakpoints |
| `delete N` | Remove breakpoint |
| `pause` | Force-pause running code |
| `<expr>` | Eval in frame |
| `q`, `quit` | Disconnect |

### ndjson Protocol

Send JSON commands over stdin, receive JSON responses on stdout:

```bash
echo '{"op":"state"}' | node mypry.js attach --json --port 9229
```

**Operations:** `state`, `eval`, `step_over`, `step_into`, `step_out`, `continue`, `locals`, `backtrace`, `source`, `set_breakpoint`, `remove_breakpoint`, `breakpoints`, `pause`, `quit`

### MCP Tools

10 tools designed for AI agents:

| Tool | Description |
|------|-------------|
| `debugger_state` | Current status, file, line, locals |
| `debugger_step` | Step over/into/out |
| `debugger_continue` | Resume to next breakpoint |
| `debugger_eval` | Evaluate expression in frame |
| `debugger_set_breakpoint` | Set breakpoint (with optional condition) |
| `debugger_list_breakpoints` | List active breakpoints |
| `debugger_remove_breakpoint` | Remove by ID |
| `debugger_pause` | Force-pause running code |
| `debugger_backtrace` | Call stack |
| `debugger_source` | Full source of current file |

### HTTP API

```bash
# Get state
curl localhost:3099/state

# Evaluate expression
curl -X POST localhost:3099/command -d '{"op":"eval","expr":"x + 1"}'

# Step over
curl -X POST localhost:3099/command -d '{"op":"step_over"}'

# Health check
curl localhost:3099/health
```

## Browser Debugging

Attach to Chrome tabs via `--remote-debugging-port`:

```bash
# Launch Chrome with debugging
google-chrome --remote-debugging-port=9222

# Attach to a tab by title
mypry attach --port 9222 --tab "My App"

# Or by URL
mypry attach --port 9222 --tab-url "localhost:3000"
```

## Programmatic Use

```ts
import { CDPClient, DebuggerSession, snapshot } from 'mypry/core'
import { startHttpServer } from 'mypry/http'
import { startMcpServer } from 'mypry/mcp'

const cdp = new CDPClient('ws://127.0.0.1:9229/...')
await cdp.connect()
const session = new DebuggerSession(cdp)
await session.init()

// Use any transport
await startHttpServer(session, { port: 4000 })
await startMcpServer(session)
```

## Requirements

- Node.js ≥ 22.0.0

## License

MIT
