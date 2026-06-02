<div align="center">

# mypry

**The interactive full-stack debugger for AI agents.**

Pause, step, and inspect live state across your **Node.js backend and browser frontend — in a single session** — and hand it all to your AI agent over MCP.

[![npm](https://img.shields.io/npm/v/mypry.svg)](https://www.npmjs.com/package/mypry)
[![node](https://img.shields.io/badge/node-%E2%89%A522-43853d.svg)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](#license)

```bash
npm install mypry
```

</div>

---

## Why mypry

AI coding agents are great at reading code and guessing. They're blind at runtime. Most tools that try to fix this either:

- **only see the browser** (Chrome DevTools-style MCP servers) — great for the DOM, but they can't set a breakpoint in your Node service and step through it, or
- **only see the backend** (Node inspector MCP servers) — they pause your server, but they have no idea what the frontend sent.

A real bug lives in *both*: the button click, the request payload, the handler, the DB call. mypry is the only debugger that lets an agent **follow one request from the browser click into the backend handler — pausing, stepping and evaluating live on both sides — inside a single session.**

---

## Quick start (60 seconds)

**1. Run your app with the inspector open.**

```bash
node --inspect server.js
```

**2. Point your agent at mypry.** Add to your MCP config:

```json
{
  "mcpServers": {
    "mypry": {
      "command": "mypry-bridge"
    }
  }
}
```

**3. Your agent now has live debugging tools.**

```
You:    Why is the admin login returning a 403?
Agent:  [debugger_connect]         { port: 9229 }
        [debugger_set_breakpoint]  auth.service.ts:151  condition: email === "admin@test.com"
        [debugger_state]           → paused, locals: { user, isMatch: false }
        [debugger_eval]            → user.role  →  "viewer"
        The role is "viewer", not "admin" — bcrypt matched but the role check fails.
```

---

## The one idea: one session, both sides

Connect to **both** the Node inspector and a Playwright browser. Every eval takes an optional `target` — `"backend"` (default) or `"browser"` — so your agent walks a request end to end without switching tools or processes.

```
debugger_connect { port: 9229, frontend: "http://localhost:5173" }

# Frontend: fill the form and submit
debugger_snapshot                          → ARIA tree: textbox "Email", button "Sign In"
debugger_browse { script: "fill \"textbox Email\" \"admin@test.com\"\nclick \"button Sign in\"" }
  → backend: paused at auth.service.ts:151

# Backend: inspect the same request
debugger_eval { expr: "user.role" }        → "viewer"
debugger_eval { expr: "document.cookie", target: "browser" }  → "session=abc123"
debugger_continue
```

---

## Two ways to pause

### `debugger_set_breakpoint` — no code changes

The agent sets a breakpoint by file and line. **No edits, no restart, no hot-reload needed.** The app pauses the next time that line executes.

```
debugger_set_breakpoint { file: "auth.ts", line: 47 }
# trigger the code path...
debugger_state → paused at auth.ts:47, locals visible
```

This is the recommended approach — the agent doesn't touch your source code.

### `debugger` statement — simplest

The agent can also edit your code and drop a `debugger;` statement. When the inspector is connected and Node.js hits it, the app pauses automatically — no `set_breakpoint` call needed.

```js
// Agent adds this line:
debugger;
```

```
debugger_state → paused at the debugger; line, locals visible
```

Both approaches work. `set_breakpoint` is cleaner (no file edits). `debugger;` is simpler (the agent already knows how to edit code).

---

## MCP setup

mypry ships a **stdio MCP bridge** as its binary. No daemon, no config file — the agent's MCP runtime starts the process directly.

```
AI Agent ── stdio ──▶ mypry-bridge ── CDP ──▶ your app
                          │
                          └── Playwright ──▶ browser
```

**Claude Code** — `~/.claude/mcp.json`:

```json
{
  "mcpServers": {
    "mypry": { "command": "mypry-bridge" }
  }
}
```

**Cursor** — `~/.cursor/mcp.json`: same block.

**Antigravity** — settings or `mcp_config.json`:

```json
{
  "mypry": { "command": "mypry-bridge" }
}
```

> `npm install -g mypry` makes `mypry-bridge` available globally. For local installs, use `npx mypry-bridge`.

---

## Tools

| Tool | Description |
|------|-------------|
| `debugger_connect` | Connect to V8 inspector + optionally launch a Playwright browser |
| `debugger_disconnect` | Close everything |
| `debugger_state` | Paused/running, file, line, function, locals, source window |
| `debugger_set_breakpoint` | File + line, optional `condition`. Source maps handled automatically |
| `debugger_breakpoints` | List or remove breakpoints |
| `debugger_eval` | JS expression — `target: "backend"` (default) or `"browser"` |
| `debugger_step` | Step over / into / out |
| `debugger_continue` | Resume until next breakpoint |
| `debugger_browse` | Drive the browser via [AgentScript](#agentscript) |
| `debugger_snapshot` | ARIA accessibility tree — how the agent "sees" the page |
| `debugger_inject` | Attach to a running process without `--inspect` |

---

## Modes

### Backend only

```
debugger_connect { port: 9229 }
debugger_set_breakpoint { file: "auth.ts", line: 47 }
debugger_state        → paused at line 47, locals: { user, token }
debugger_eval { expr: "user.email" }
debugger_continue
```

### Browser only

```
debugger_connect { frontend: "http://localhost:3000" }
debugger_snapshot     → ARIA tree
debugger_browse { script: "fill \"textbox Email\" \"alice\"\nclick \"button Sign in\"" }
debugger_eval { expr: "document.title", target: "browser" }
```

### Fullstack

```
debugger_connect { port: 9229, frontend: "http://localhost:3000" }
debugger_set_breakpoint { file: "auth.ts", line: 47 }
debugger_browse { script: "fill \"textbox Email\" \"alice\"\nclick \"button Sign in\"" }
  → backend paused at auth.ts:47, locals: { email: "alice" }
debugger_eval { expr: "req.body" }
debugger_eval { expr: "document.cookie", target: "browser" }
debugger_continue
```

---

## Inject (no restart)

Attach the debugger to a running Node.js process that wasn't started with `--inspect`.

```
debugger_inject { appPort: 3000 }
```

Finds the PID via `lsof`, activates the V8 inspector via `_debugProcess`, discovers the new inspector port, and connects — all in one call. Returns an actionable error if port 9229 is occupied.

---

## Next.js + Turbopack

Next.js spawns multiple processes. Start with `NODE_OPTIONS` to enable the inspector on the child:

```bash
NODE_OPTIONS='--inspect=9555' npm run dev
# Child (next-server) opens on port 9556
```

```
debugger_connect { port: 9556, frontend: "http://localhost:3000" }
debugger_set_breakpoint { file: "route.ts", line: 7 }
```

Turbopack's consolidated chunk format, sectioned source maps, and hot-reload re-compilation are handled transparently. See [ARCHITECTURE.md](ARCHITECTURE.md) for internals.

---

## AgentScript

`debugger_browse` uses AgentScript — a built-in DSL that translates one-line commands into Playwright actions. **AgentScript is for driving the browser**, not for backend debugging.

**Always call `debugger_snapshot` first** to see available selectors. Then use what the snapshot returns:

```
fill "textbox Email" "alice@example.com"
fill "textbox Password" "secret"
click "button Sign in"
waiturl "/dashboard"
```

| Category | Verbs |
|----------|-------|
| **Navigation** | `goto <url>`, `back`, `forward`, `reload`, `waiturl "<pattern>"` |
| **Interaction** | `click`, `fill`, `clear`, `type`, `press`, `select`, `check`, `uncheck`, `hover`, `scroll`, `upload`, `ondialog` |
| **Timing** | `wait <sel> visible`, `wait <sel> hidden`, `wait 500ms` |

> For reading DOM values, use `debugger_eval { target: "browser" }` instead of DSL verbs. After navigation, snapshot again.

---

## Security

mypry gives an AI agent `eval` access to both your Node.js process and a browser page. This is powerful — and risky if misused.

**What the agent can do:**
- Execute arbitrary JavaScript in your Node.js process (read env vars, access the filesystem, call `process.exit()`)
- Execute arbitrary JavaScript in the browser page (access cookies, localStorage, DOM)
- Set breakpoints that pause your application

**Recommendations:**
- **Development only.** Do not run mypry on production systems.
- **Localhost only.** The V8 inspector (`--inspect`) binds to `127.0.0.1` by default. Do not expose it to the network (`--inspect=0.0.0.0` is dangerous).
- **Headless browser.** The default `headless: true` prevents UI interference. Use `headless: false` only for visual debugging.
- **Review agent actions.** If your MCP runtime supports approval flows, enable them for `debugger_eval` and `debugger_inject`.

---

## Programmatic use

```ts
import { DebuggerToolKit } from 'mypry/toolkit'

const kit = new DebuggerToolKit()
await kit.call('debugger_connect', { port: 9229 })
await kit.call('debugger_set_breakpoint', { file: 'auth.ts', line: 47 })
const state = await kit.call('debugger_state')
await kit.call('debugger_eval', { expr: 'user.role' })
await kit.call('debugger_continue')
await kit.call('debugger_disconnect')
```

---

## Documentation

| Document | Description |
|----------|-------------|
| [**Programmatic API**](docs/programmatic-api.md) | `DebuggerToolKit`, `CDPClient`, `DebuggerSession` — for custom integrations |
| [**skills/SKILL.md**](skills/SKILL.md) | Drop-in AI agent skill |

---

## Requirements

- **Node.js ≥ 22**
- **Playwright** — installed automatically with mypry

## License

MIT
