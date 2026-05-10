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

## Usage

### Inline trigger (target side)

```js
const pry = require('mypry')

function calcularPrecio(cantidad, precio) {
  const subtotal = cantidad * precio
  pry()                           // pauses; waits for client
  return subtotal * 1.21
}
```

Run it normally:

```bash
node app.js
# [mypry] inspector listening on 0.0.0.0:9229
# [mypry] connect with: mypry attach --host 0.0.0.0 --port 9229
# [mypry] waiting for client...
```

### Human mode

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

Commands: `n`, `s`, `o`, `c`, `l`, `bt`, `locals`, `q`, plus any expression.

### Agent mode (`--json`)

```bash
mypry attach --json
```

Stdout: emits an initial paused-state JSON, then one JSON line per request.
Stdin: one `{"op": "..."}` JSON object per line.

```
< {"status":"paused","file":"/app/test.js","line":8,"function":"calcularPrecio",
   "source_window":[{"line":6,"text":"  const subtotal = cantidad * precio","current":false}, ...],
   "locals":{"cantidad":5,"precio":100,"subtotal":500}}
> {"op":"eval","expr":"cantidad * precio"}
< {"ok":true,"type":"number","value":500,"description":null}
> {"op":"step_over"}
< {"status":"paused","file":"/app/test.js","line":9, ...}
> {"op":"continue"}
< {"status":"terminated"}
```

#### Operations

| op           | params         | response                                               |
|--------------|----------------|--------------------------------------------------------|
| `state`      | —              | full paused snapshot (file, line, locals, source win.) |
| `eval`       | `{expr}`       | `{ok, type, value, description}`                       |
| `step_over`  | —              | next paused snapshot                                   |
| `step_into`  | —              | next paused snapshot                                   |
| `step_out`   | —              | next paused snapshot                                   |
| `continue`   | —              | next paused snapshot or `{status:"terminated"}`        |
| `locals`     | —              | `{locals: {...}}`                                      |
| `backtrace`  | —              | `{frames: [...]}`                                      |
| `source`     | —              | `{file, source, current_line}`                         |
| `quit`       | —              | `{status:"disconnected"}` then exits                   |

## How an LLM agent uses it

The agent runs `mypry attach --json` as a long-lived child process and writes
one JSON request per line to its stdin, reading one JSON response per line from
its stdout. State (current frame, scopes, source cache) is held server-side in
the CLI process — each tool call from the agent is stateless from its view.

Wrap it as a single agent tool with operations matching the table above.
Antigravity / Claude Code / any agent framework with a "shell session" tool
can drive it directly.

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

## What's intentionally not built (yet)

- Breakpoints by file:line (`break path:N`) — easy to add via `Debugger.setBreakpointByUrl`.
- Watch expressions across pauses.
- Conditional breakpoints.
- Source-map awareness (TS/Babel).
- Auth on the inspector port.
