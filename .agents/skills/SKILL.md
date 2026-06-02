# Skill: mypry — Fullstack Debugger for AI Agents

> **When to read this:** Whenever you need to debug a running Node.js process, set breakpoints, inspect variables at runtime, step through code, or interact with the browser while debugging.

---

## Getting Connected

### Option A — Inject into a running process (RECOMMENDED)

**No restart required.** Just tell mypry which port your app listens on:

```
→ debugger_inject { appPort: 3000 }
← { backend: { connected: true }, injected: { pid: 12345, inspectorPort: 9229 } }
```

Add `frontend` for fullstack (backend + browser):

```
→ debugger_inject { appPort: 3000, frontend: "http://localhost:3000" }
```

Works with Express, Fastify, Vite, Hono — any Node.js app.

> **Requires port 9229 to be free.** If another Node.js process already has an inspector on 9229, inject will fail with a clear error and instructions. In that case, use Option B.

### Option B — Process already started with `--inspect`

If the user started their app with the inspector flag:

```bash
node --inspect=9333 server.js
```

Connect directly to that port:

```
→ debugger_connect { port: 9333 }
```

Add `frontend` for fullstack:

```
→ debugger_connect { port: 9333, frontend: "http://localhost:3000" }
```

### Option C — Next.js (Turbopack)

Next.js spawns a **child process** (`next-server`) that runs your code. The parent process gets the inspector, but your breakpoints need the child.

**Tell the user to start with:**

```bash
NODE_OPTIONS='--inspect=9555' npm run dev
```

Then connect to **PORT+1** (the child process):

```
→ debugger_connect { port: 9556, frontend: "http://localhost:3000" }
```

> **Tip:** Check terminal output for `Debugger listening on ws://127.0.0.1:XXXX/...` to find the exact child port.

Breakpoints work with Turbopack — mypry handles sectioned source maps and URL-encoded chunk paths automatically.

### Option D — Browser only (no backend)

```
→ debugger_connect { frontend: "http://localhost:3000" }
```

### Decision Tree

| User says... | Do this |
|---|---|
| "Debug my app on port 3000" | `debugger_inject { appPort: 3000 }` |
| "I started with `--inspect`" | `debugger_connect { port: XXXX }` |
| "Debug my Next.js app" | Tell user: `NODE_OPTIONS='--inspect=9555' npm run dev`, then `debugger_connect { port: 9556 }` |
| "Test the UI" / "Check the page" | `debugger_connect { frontend: "http://..." }` |

---

## MCP Tools (11 tools)

### Connection

| Tool | Params | Description |
|------|--------|-------------|
| `debugger_connect` | `port?`, `host?`, `frontend?`, `headless?` | Connect to backend inspector + optionally launch browser |
| `debugger_inject` | `appPort?`, `pid?`, `frontend?`, `headless?` | Activate inspector on a running process (no restart) |
| `debugger_disconnect` | — | Close everything |

### Inspection

| Tool | Params | Description |
|------|--------|-------------|
| `debugger_state` | — | Unified state: backend (paused/running, file, line, locals) + browser (URL) |
| `debugger_eval` | `expr`, `target?` | Evaluate JS — paused: frame scope; running: global scope. `target: "browser"` for frontend |
| `debugger_snapshot` | `scope?` | Browser ARIA tree — read this before `debugger_browse` if you don't know the page |

### Browser Interaction

| Tool | Params | Description |
|------|--------|-------------|
| `debugger_browse` | `script`, `timeoutMs?` | Execute browser script. **Auto-detects backend pause** if a breakpoint fires |

### Execution Control

| Tool | Params | Description |
|------|--------|-------------|
| `debugger_continue` | — | Resume until next breakpoint (5s timeout) |
| `debugger_step` | `mode` | `over`, `into`, or `out` — returns new state |
| `debugger_set_breakpoint` | `file`, `line`, `condition?` | Set breakpoint (TypeScript + Turbopack via source maps) |
| `debugger_breakpoints` | `remove?` | List all. If `remove` is set, removes that ID |

---

## Workflows

### Backend debugging (no browser)

```
→ debugger_inject { appPort: 3000 }
← { backend: { connected: true, target: "server.js" }, injected: { pid: 12345 } }

→ debugger_set_breakpoint { file: "auth.service.ts", line: 47 }
← { ok: true, id: 1 }

(trigger the code path — e.g. curl, browser click)

→ debugger_state
← { backend: { status: "paused", file: "auth.service.ts", line: 47,
     function: "validateUser", locals: { email: "alice@test.com" } } }

→ debugger_eval { expr: "user.role" }
← { ok: true, value: "admin" }

→ debugger_continue
← { status: "running" }
```

> **TypeScript supported:** `set_breakpoint("file.ts", line)` automatically resolves via source maps.

### Conditional breakpoints

```
→ debugger_set_breakpoint {
    file: "auth.service.ts", line: 47,
    condition: "email === \"admin@test.com\""
  }
```

Only pauses when the condition is truthy.

### Fullstack: debug backend + drive browser

The most powerful workflow: set a breakpoint, trigger it from the browser, inspect the request.

```
# 1. Connect to everything
→ debugger_inject { appPort: 3000, frontend: "http://localhost:3000" }
← { backend: { connected: true }, browser: { connected: true }, injected: { pid: 12345 } }

# 2. Set breakpoint on the login handler
→ debugger_set_breakpoint { file: "auth.controller.ts", line: 47 }
← { ok: true, id: 1 }

# 3. Snapshot to see the page
→ debugger_snapshot
← textbox "Email", textbox "Password", button "Sign in" ...

# 4. Fill form and submit — this triggers the breakpoint
→ debugger_browse { script: "fill \"label:Email\" \"alice@test.com\"\nfill \"label:Password\" \"secret\"\nclick \"button Sign in\"" }
← {
    browser: { ok: true, stepsRun: 3 },
    backend: { status: "paused", file: "auth.controller.ts", line: 47,
               locals: { body: { email: "alice@test.com", password: "secret" } } }
  }

# 5. Inspect both sides simultaneously
→ debugger_eval { expr: "body.email" }
← { ok: true, value: "alice@test.com" }

→ debugger_eval { expr: "document.title", target: "browser" }
← { ok: true, value: "Login — My App" }

→ debugger_continue
← { status: "running" }

# 6. Check browser landed on dashboard
→ debugger_browse { script: "expect \"heading Welcome\" visible" }

→ debugger_disconnect
```

### Browser rules (CRITICAL)

**NEVER invent or guess selectors.** Always call `debugger_snapshot` first, OR use known selectors from source code.

| Snapshot shows | Write in script |
|---|---|
| `button "Sign In"` | `click "button Sign In"` |
| `textbox "Email"` | `fill "textbox Email" "alice@test.com"` |
| `link "Dashboard"` | `click "link Dashboard"` |
| `heading "Welcome" [level=1]` | `expect "heading Welcome" visible` |

If a selector is known from code, use it directly without snapshotting:
`fill "#email" "alice"` or `fill "placeholder:Your name" "Alice"`.

---

## Important Behavior

1. **`debugger_inject` is the easiest path** — no restart, no flags. Just the app port.
2. **`debugger_browse` auto-detects pauses** — if a breakpoint fires during browser interaction, the response includes backend state.
3. **`debugger_continue` waits 5s** — for next breakpoint. Returns `{status: "running"}` if nothing fires.
4. **Source maps automatic** — TypeScript paths in state, breakpoints, eval. Works with Vite, Turbopack, tsc.
5. **Auto-reconnect** — survives process restarts (nodemon, NestJS `--watch`).
6. **Vue/Pinia unwrap** — `ref()` and `$state` auto-unwrapped in eval.
7. **Cross-platform** — `inject` uses `process._debugProcess` (works on macOS, Linux, Windows).

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
