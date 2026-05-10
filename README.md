# mypry

A pry-style debugger for Node.js. Two modes from one CLI:

- **Human TTY** — pry-like REPL where bare expressions evaluate in scope.
- **`--json`** — newline-delimited JSON over stdio, designed for LLM coding agents.

Talks CDP (Chrome DevTools Protocol) over WebSocket. Zero deps. Node 22+.

## Install

```bash
npm install --global .          # exposes `mypry`
# or use directly: node bin/mypry.js attach
```

## Two ways to debug

### 1. Inline `pry()` — like Ruby's `binding.pry`

Drop `pry()` anywhere in your code. When it's hit, execution pauses and waits
for a debugger client.

```js
const pry = require('mypry')

function calcularPrecio(cantidad, precio) {
  const subtotal = cantidad * precio
  pry()                           // pauses here, waiting for client
  return subtotal * 1.21
}
```

```bash
# Terminal 1 — run your app
node app.js
# [mypry] inspector listening on 0.0.0.0:9229
# [mypry] waiting for client...

# Terminal 2 — attach
mypry attach
```

### 2. `--inspect` mode — no code changes needed

Use Node's built-in `--inspect` flag. Set breakpoints from the mypry REPL.

```bash
# Terminal 1 — start with --inspect (any Node app, framework, server)
node --inspect app.js
# or for frameworks:
NODE_OPTIONS='--inspect' npm run dev

# Terminal 2 — attach and set breakpoints
mypry attach
(mypry|running) break src/routes/products.ts:15
# → breakpoint #1 → src/routes/products.ts:15

# Hit the route (browser, curl, etc.) → debugger pauses
(mypry) locals
(mypry) request.params
(mypry) c
```

Works with **Express, Fastify, NestJS, Remix, Next.js, Hono** — anything
that runs on Node.

## Human mode

```bash
mypry attach                          # local, default port
mypry attach --host 10.0.0.5          # remote
```

```
─── /app/test.js:8  calcularPrecio ───
   6 │   const subtotal = cantidad * precio
   7 │
►  8 │   pry()
   9 │   return subtotal * 1.21
  10 │ }
(mypry) cantidad
=> 5
(mypry) subtotal
=> 500
(mypry) cantidad * precio + 50
=> 550
(mypry) n
─── /app/test.js:9  calcularPrecio ───
   ...
(mypry) c
```

### Commands

| Command | Description |
|---------|-------------|
| `n`, `next` | Step over |
| `s`, `step` | Step into |
| `o`, `out` | Step out |
| `c`, `continue` | Resume execution |
| `l`, `list` | Show source around current line |
| `bt`, `where` | Show call stack |
| `locals` | List local variables |
| `break FILE:LINE` | Set breakpoint (e.g. `break src/app.ts:42`) |
| `breakpoints`, `bl` | List active breakpoints |
| `delete N` / `delete *` | Remove breakpoint #N or all |
| `pause` | Force-pause a running process |
| `<expression>` | Evaluate in current frame |
| `q`, `quit` | Disconnect |

When connected to a running process (no pause), the prompt shows
`(mypry|running)`. You can set breakpoints and `pause` from this state.

## Agent mode (`--json`)

```bash
mypry attach --json
```

Stdout: emits an initial state JSON (paused or running), then one JSON line
per request.
Stdin: one `{"op": "..."}` JSON object per line.

```
< {"status":"paused","file":"/app/test.js","line":8,"function":"calcularPrecio",
   "source_window":[...], "locals":{"cantidad":5,"precio":100,"subtotal":500}}
> {"op":"eval","expr":"cantidad * precio"}
< {"ok":true,"type":"number","value":500,"description":null}
> {"op":"step_over"}
< {"status":"paused","file":"/app/test.js","line":9, ...}
> {"op":"continue"}
< {"status":"terminated"}
```

If the target is already running (no pause): `< {"status":"running"}`

### Operations

| op | params | response |
|---|---|---|
| `state` | — | full paused snapshot (file, line, locals, source) |
| `eval` | `{expr}` | `{ok, type, value, description}` |
| `step_over` | — | next paused snapshot |
| `step_into` | — | next paused snapshot |
| `step_out` | — | next paused snapshot |
| `continue` | — | next paused snapshot or `{status:"terminated"}` |
| `locals` | — | `{locals: {...}}` |
| `backtrace` | — | `{frames: [...]}` |
| `source` | — | `{file, source, current_line}` |
| `set_breakpoint` | `{file, line}` | `{ok, id, file, line}` |
| `remove_breakpoint` | `{id}` | `{ok: true}` |
| `breakpoints` | — | `{breakpoints: [{id, file, line}, ...]}` |
| `pause` | — | paused snapshot |
| `quit` | — | `{status:"disconnected"}` then exits |

## How an LLM agent uses it

The agent runs `mypry attach --json` as a long-lived child process and writes
one JSON request per line to its stdin, reading one JSON response per line from
its stdout. State (current frame, scopes, source cache) is held server-side in
the CLI process — each tool call from the agent is stateless from its view.

Wrap it as a single agent tool with operations matching the table above.
Antigravity / Claude Code / any agent framework with a "shell session" tool
can drive it directly.

## Using with frameworks

### Remix / Next.js / NestJS

```bash
# Start the dev server with inspector enabled
NODE_OPTIONS='--inspect' npm run dev

# Attach and set breakpoints
mypry attach
(mypry|running) break app/routes/products.tsx:15
# Hit the route → pauses at line 15
(mypry) locals
(mypry) params
(mypry) c
```

### NestJS example with `pry()`

```ts
const pry = require('mypry')

@Get(':id')
async getUser(@Param('id') id: string) {
  const user = await this.usersService.findOne(id)
  pry()  // inspect user, id, this
  return user
}
```

## Remote

```bash
# target machine
node --inspect=0.0.0.0:9229 app.js
# or in code: pry({ host: '0.0.0.0', port: 9229 })

# your machine
mypry attach --host TARGET_IP --port 9229
```

⚠️ The CDP port is unauthenticated. For production-ish remote use, tunnel it
over SSH:

```bash
ssh -L 9229:localhost:9229 user@target
mypry attach           # connects to localhost:9229 → tunneled
```

## Console output

When you run `console.log()` from the REPL, the output appears in the
debugger terminal (forwarded via CDP), not just in the target's stdout.

```
(mypry) console.log('debug:', user)
[console] "debug:" {"id": 1, "name": "Alice"}
=> undefined
```

## What's intentionally not built (yet)

- Conditional breakpoints.
- Watch expressions across pauses.
- Source-map awareness (TS/Babel).
- Auth on the inspector port.
