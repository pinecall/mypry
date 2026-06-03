# Programmatic API

mypry exports its internals for building custom integrations, test harnesses, or TUIs.

## DebuggerToolKit (recommended)

The highest-level API. Wraps all 11 MCP tools in a single class.

```ts
import { DebuggerToolKit } from 'mypry/toolkit'

const kit = new DebuggerToolKit()

// kit.tools          → MCP tool definitions (JSON Schema)
// kit.call(name, args) → execute any tool
// kit.dispose()      → cleanup

await kit.call('debugger_connect', { port: 9229 })
await kit.call('debugger_set_breakpoint', { file: 'auth.ts', line: 47 })

// ... trigger the endpoint ...

const state = await kit.call('debugger_state')
// { backend: { status: 'paused', file: '...', line: 47, locals: {...} } }

await kit.call('debugger_eval', { expr: 'user.role' })
// { ok: true, type: 'string', value: 'admin' }

await kit.call('debugger_continue')
await kit.call('debugger_disconnect')
```

### With browser (fullstack)

```ts
const kit = new DebuggerToolKit()

await kit.call('debugger_connect', {
  port: 9229,
  frontend: 'http://localhost:3000'
})

// Snapshot the page
const snap = await kit.call('debugger_snapshot')

// Drive the browser
await kit.call('debugger_browse', {
  actions: [
    { fill: ['textbox Email', 'alice'] },
    { click: 'button Sign in' },
  ]
})

// Eval in both contexts
await kit.call('debugger_eval', { expr: 'req.body' })          // backend
await kit.call('debugger_eval', { expr: 'document.title', target: 'browser' })

await kit.call('debugger_disconnect')
```

---

## Core API (lower level)

For building custom debugger UIs or direct CDP control.

```ts
import { CDPClient, DebuggerSession, snapshot, discoverTargets } from 'mypry/core'
```

### discoverTargets

Find Node.js inspector targets on a host:port.

```ts
const targets = await discoverTargets('127.0.0.1', 9229)
// [{ kind: 'node', wsUrl: 'ws://...', title: 'server.js' }]
```

### CDPClient

Minimal Chrome DevTools Protocol client over WebSocket. Zero dependencies.

```ts
const cdp = new CDPClient(targets[0].wsUrl)
await cdp.connect()

// Send CDP commands directly
const result = await cdp.send('Runtime.evaluate', {
  expression: '1 + 1',
  returnByValue: true,
})
console.log(result.result.value) // 2

// Listen for CDP events
cdp.on('Debugger.paused', (params) => {
  console.log('Paused at', params.callFrames[0].location)
})
```

### DebuggerSession

High-level debugger abstraction over CDPClient. Handles breakpoints, stepping, evaluation, source maps, and Turbopack chunk resolution.

```ts
const session = new DebuggerSession(cdp)
await session.init()

// Breakpoints
const bp = await session.setBreakpoint('auth.ts', 47, 'email === "admin"')
await session.waitNextPause()

// Inspect
const locals = await session.getLocals()     // { email, isMatch, ... }
const frames = await session.getBacktrace()  // [{ function, file, line }, ...]

// Evaluate in the paused frame
const result = await session.evalInFrame('user.role')
// { ok: true, type: 'string', value: 'admin' }

// Step
await session.stepOver()
await session.stepInto()
await session.stepOut()

// Resume
await session.resume()

// Cleanup
await session.removeBreakpoint(bp.id)
```

### snapshot

Build a full state snapshot (same format as `debugger_state`):

```ts
const state = await snapshot(session)
// { status: 'paused', file: '...', line: 47, function: 'validateUser',
//   source_window: [...], locals: { email, isMatch } }
```

---

## Example: custom watcher

```ts
import { CDPClient, DebuggerSession, snapshot, discoverTargets } from 'mypry/core'

async function main() {
  const [target] = await discoverTargets('127.0.0.1', 9229)
  const cdp = new CDPClient(target.wsUrl)
  await cdp.connect()

  const session = new DebuggerSession(cdp)
  await session.init()

  // React to pauses
  cdp.on('Debugger.paused', async () => {
    const state = await snapshot(session)
    console.log(`⏸  Paused at ${state.function} ${state.file}:${state.line}`)
    console.log('   Locals:', JSON.stringify(state.locals, null, 2))
  })

  cdp.on('Debugger.resumed', () => {
    console.log('▶  Resumed')
  })

  console.log('Watching... (Ctrl+C to exit)')
  await new Promise(() => {})
}

main()
```
