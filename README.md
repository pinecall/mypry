# mypry

Inline debugger for Node.js and the browser. Drop `pry()` anywhere — execution pauses and waits for you.

Built for **AI pair programming**: your agent attaches via MCP or JSON, inspects variables, steps through code, and continues — programmatically.

```
npm install mypry
```

## Quick Start

### 1. Drop `pry()` in your code

```js
const pry = require('mypry')

function handleRequest(req) {
  const users = db.getUsers()
  pry()  // ← execution pauses here, waiting for a client
  return users
}
```

### 2. Attach the debugger

```bash
# Run your app — it blocks at pry()
node server.js

# In another terminal:
mypry attach
```

```
─── server.js:5  handleRequest ───
  3 │ function handleRequest(req) {
  4 │   const users = db.getUsers()
  5 │   pry()
► 6 │   return users
  7 │ }

(mypry) users
=> [{"id": 1, "name": "Alice"}, {"id": 2, "name": "Bob"}]
(mypry) continue
```

That's it. `pry()` opens the V8 inspector and blocks. `mypry attach` connects via CDP and drops you into a REPL at the exact line where `pry()` was called.

## pry() Options

```js
pry()                                    // default port 9229
pry({ port: 9235 })                      // custom port
pry({ message: 'before DB query' })      // log a label when it pauses
pry({ port: 9235, host: '127.0.0.1' })  // custom host + port
```

If you use a custom port, pass `--port` to the CLI:

```bash
mypry attach --port 9235
```

## REPL Commands

| Command | Alias | Description |
|---------|-------|-------------|
| `continue` | `c` | Resume execution |
| `next` | `n` | Step over |
| `step` | `s` | Step into |
| `out` | `o` | Step out |
| `list` | `l` | Show source context (wider) |
| `locals` | — | Show all local variables |
| `backtrace` | `bt`, `where` | Show call stack |
| `break file:line` | `b` | Set a breakpoint |
| `breakpoints` | `bl` | List breakpoints |
| `delete N` | `del` | Remove breakpoint |
| `pause` | — | Pause a running target |
| `quit` | `q` | Disconnect |
| *anything else* | — | Evaluate in current frame |

## Frontend Debugging

### 1. Add `pry()` in your React / Vue / Svelte code

```tsx
import { pry } from 'mypry/browser'

function UserList() {
  const [users, setUsers] = useState([])

  const loadUsers = async () => {
    const data = await fetch('/api/users').then(r => r.json())
    pry({ message: `loaded ${data.length} users` })
    setUsers(data)
  }

  return <button onClick={loadUsers}>Load</button>
}
```

### 2. Add `--chrome`

```bash
mypry attach --chrome                        # auto-detect dev server
mypry attach --chrome http://localhost:5178  # explicit URL
```

Without a URL, mypry scans common dev ports (3000, 5173–5180, 8080, 4200) and opens the first one it finds. If you have multiple servers running, pass the URL explicitly.

When a frontend `pry()` fires, the REPL shows your component code:

```
━━━ FRONTEND ━━━
─── App.tsx:55  loadUsers ───
  53 │     const data = await res.json()
  54 │     pry({ message: `loaded ${data.count} users` })
► 55 │     setUsers(data.users)

(mypry|frontend) data
=> {"users": [...], "count": 3}
(mypry|frontend) continue
```

### Fullstack (backend + frontend in one REPL)

If your backend also uses `pry()`, both pause in the same session:

```bash
mypry attach --port 9235 --chrome
```

Click a button → backend pauses → inspect → `continue` → frontend pauses → inspect → `continue`. The REPL labels each pause:

```
━━━ BACKEND ━━━
─── server.js:12  <anon> ───
► 12 │   res.json({ users: result })

(mypry|backend) continue

━━━ FRONTEND ━━━
─── App.tsx:55  loadUsers ───
► 55 │     setUsers(data.users)

(mypry|frontend) continue
```

## AI Agent Modes

### JSON (ndjson stdio)

```bash
mypry attach --json
```

Newline-delimited JSON on stdin/stdout. For embedding in AI tools.

```json
→ {"action":"eval","expression":"users.length"}
← {"ok":true,"value":3}

→ {"action":"continue"}
← {"ok":true,"running":true}
```

### MCP (Model Context Protocol)

```bash
mypry attach --mcp
```

MCP server on stdio — plug into Claude Code, Cursor, or any MCP client.

| Tool | Description |
|------|-------------|
| `get_state` | Current pause location, source, and locals |
| `eval` | Evaluate expression in current frame |
| `step_over` / `step_into` / `step_out` | Stepping |
| `continue` | Resume |
| `set_breakpoint` / `remove_breakpoint` | Breakpoint management |
| `get_snapshot` | Full state snapshot |

## CLI Reference

```
mypry attach [options]

Connection:
  --port PORT        V8 inspector port (default: 9229)
  --host HOST        Inspector host (default: 127.0.0.1)
  --url WS_URL       Direct WebSocket URL

Transport:
  (default)          Human REPL
  --json             ndjson stdio
  --mcp              MCP server on stdio

Frontend:
  --chrome           Auto-detect dev server, launch Chrome with CDP

  -h, --help         Show help
```

## Architecture

```
Your Code                    mypry CLI
─────────                    ─────────
                             ┌──────────────────┐
  pry()  ─── V8 Inspector ──→│  DebuggerSession  │
  (Node)     (CDP)           │                    │
                             │  ┌──── REPL        │
  pry()  ─── Chrome CDP ────→│  ├──── JSON        │
  (Browser)                  │  └──── MCP         │
                             └──────────────────┘
```

| Module | Purpose |
|--------|---------|
| `src/pry.ts` | Node.js `pry()` — opens inspector, fires `debugger` |
| `src/browser.ts` | Browser `pry()` — fires `debugger` for Chrome CDP |
| `src/core/session.ts` | Debugger session — pause, step, eval, breakpoints |
| `src/core/cdp-client.ts` | Raw WebSocket CDP client |
| `src/core/targets.ts` | Target discovery |
| `src/transports/repl.ts` | Human REPL |
| `src/transports/ndjson.ts` | JSON stdio transport |
| `src/transports/mcp.ts` | MCP server transport |
| `src/cli.ts` | CLI entry point |

## Requirements

- Node.js ≥ 22
- Chrome (for `--chrome`)

## License

MIT
