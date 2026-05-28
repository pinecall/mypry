# Programmatic API

mypry exports its internals so you can build custom UIs, TUIs, integrations, or test harnesses. Everything the CLI and MCP bridge use is available as a TypeScript API.

```ts
import {
  CDPClient,
  DebuggerSession,
  discoverTargets,
  matchTarget,
  snapshot,
  executeOp,
} from 'mypry/core'
```

---

## CDPClient

Minimal Chrome DevTools Protocol client over WebSocket. Zero dependencies.

```ts
import { CDPClient } from 'mypry/core'

const cdp = new CDPClient('ws://127.0.0.1:9229/...')
await cdp.connect()

// Send a CDP command
const result = await cdp.send('Runtime.evaluate', {
  expression: '1 + 1',
  returnByValue: true,
})
console.log(result.result.value) // 2

// Listen for events
cdp.on('Debugger.paused', (params) => {
  console.log('Paused at', params.callFrames[0].location)
})

// Disconnect
cdp.ws.close()
```

### Methods

| Method | Description |
|--------|-------------|
| `connect()` | Open WebSocket, enable `Debugger` and `Runtime` domains |
| `send(method, params?)` | Send a CDP command, returns a Promise |
| `on(event, handler)` | Subscribe to CDP events |
| `off(event, handler)` | Unsubscribe |

---

## DebuggerSession

High-level debugger abstraction over CDPClient. Handles pause state, breakpoints, stepping, evaluation, source maps, trace mode, and locals extraction.

```ts
import { CDPClient, DebuggerSession, discoverTargets } from 'mypry/core'

const [target] = await discoverTargets('127.0.0.1', 9229)
const cdp = new CDPClient(target.wsUrl)
await cdp.connect()

const session = new DebuggerSession(cdp)
await session.init()

// Set a breakpoint
const bp = await session.setBreakpoint('auth.service.ts', 151)

// Wait for pause
await session.waitNextPause()

// Inspect
const locals = await session.getLocals()     // { email, isMatch, ... }
const frames = await session.getBacktrace()  // [{ function, file, line }, ...]
const src = await session.getSource()        // { file, source, current_line }

// Evaluate in the paused frame
const result = await session.evalInFrame('user.role')
// { ok: true, type: 'string', value: 'admin', description: 'admin' }

// Step
await session.stepOver()
await session.stepInto()
await session.stepOut()

// Resume
await session.resume()

// Remove breakpoint
await session.removeBreakpoint(bp.id)
```

### Key methods

| Method | Returns | Description |
|--------|---------|-------------|
| `init()` | void | Enable debugger, set up event listeners |
| `setBreakpoint(file, line, condition?)` | `{ id }` | Set a breakpoint |
| `removeBreakpoint(id)` | void | Remove a breakpoint |
| `getBreakpoints()` | `Breakpoint[]` | List active breakpoints |
| `resume()` | void | Continue execution |
| `stepOver()` | void | Step over |
| `stepInto()` | void | Step into |
| `stepOut()` | void | Step out |
| `pause()` | void | Force-pause |
| `waitNextPause(timeout?)` | void | Wait for the next pause (default 30s) |
| `getLocals()` | `Record<string, any>` | Frame-local variables |
| `getBacktrace()` | `Frame[]` | Call stack (source-mapped) |
| `getSource(file?)` | `{ file, source, current_line }` | Source code |
| `evalInFrame(expr)` | `EvalResult` | Evaluate JS in the paused frame |
| `startTrace(maxBuffer?)` | void | Begin non-blocking trace |
| `stopTrace()` | `{ count, hits }` | Stop trace, return hits |
| `getTraceStatus()` | `{ tracing, count, hits }` | Peek at trace buffer |

### evalInFrame

`evalInFrame` auto-unwraps:
- **Vue `ref()`** → returns `.value`
- **Pinia store** → returns `.$state`
- **`reactive()` proxy** → unwraps via `__v_raw`
- **Circular references** → replaced with `[Circular]`

These checks are harmless no-ops for non-Vue code.

---

## discoverTargets

Find Node.js and Chrome inspector targets on a host:port.

```ts
import { discoverTargets } from 'mypry/core'

const targets = await discoverTargets('127.0.0.1', 9229)
// [{ kind: 'node', wsUrl: 'ws://...', title: 'server.js' }]

const chromeTargets = await discoverTargets('127.0.0.1', 9222)
// [{ kind: 'chrome', wsUrl: 'ws://...', title: 'Login', url: 'http://localhost:3001/login' }]
```

## matchTarget

Find a specific Chrome tab by title or URL:

```ts
import { matchTarget } from 'mypry/core'

const tab = matchTarget(chromeTargets, { tabUrl: 'localhost:3001' })
const cdp = new CDPClient(tab!.wsUrl)
```

---

## snapshot

Build a full state snapshot (what `debugger_state` returns):

```ts
import { snapshot } from 'mypry/core'

const state = await snapshot(session)
// { status, file, line, function, source_window, locals }
```

---

## executeOp

The shared operation dispatch used by every transport (HTTP, ndjson, MCP). Execute any op programmatically:

```ts
import { executeOp } from 'mypry/core'

const result = await executeOp(session, { op: 'eval', expr: 'users.length' })
// { ok: true, type: 'number', value: 3, description: '3' }

const state = await executeOp(session, { op: 'state' })
// { status: 'paused', file: '...', line: 151, ... }
```

Supports `target` and `worker` routing when you pass frontend/worker sessions:

```ts
const result = await executeOp(
  session,
  { op: 'eval', expr: 'document.title', target: 'frontend' },
  { frontendSession, workerSessions }
)
```

---

## Example: custom TUI

```ts
import { CDPClient, DebuggerSession, discoverTargets, snapshot } from 'mypry/core'

async function main() {
  const [target] = await discoverTargets('127.0.0.1', 9229)
  const cdp = new CDPClient(target.wsUrl)
  await cdp.connect()

  const session = new DebuggerSession(cdp)
  await session.init()

  // React to pauses
  session.on('paused', async () => {
    const state = await snapshot(session)
    console.log(`⏸  Paused at ${state.function} ${state.file}:${state.line}`)
    console.log('   Locals:', JSON.stringify(state.locals, null, 2))
  })

  session.on('resumed', () => {
    console.log('▶  Resumed')
  })

  console.log('Watching... (Ctrl+C to exit)')
  await new Promise(() => {}) // block forever
}

main()
```
