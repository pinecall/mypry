/**
 * Tool-output shape tests — drive the real DebuggerToolKit against a plain
 * http server and assert each tool returns its trimmed target shape (the
 * per-tool noise audit). Validates the full MCP call path, not just internals.
 *
 * Run:  npm run build && node --test tests/tool-output.test.mjs
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DebuggerToolKit } from '../dist/fullstack-toolkit.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SERVER = resolve(__dirname, 'fixtures/http-locals-server.cjs')
const APP_PORT = 3096
const INSPECT_PORT = 9244

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const parse = (res) => JSON.parse(res.content[0].text)

let proc
let kit

/** Call debugger_state until the backend reports paused (bounded poll). */
async function waitPaused() {
  for (let i = 0; i < 40; i++) {
    const s = parse(await kit.call('debugger_state', {}))
    if (s.backend?.status === 'paused') return s.backend
    await sleep(50)
  }
  throw new Error('never paused')
}

before(async () => {
  proc = spawn(process.execPath, [`--inspect=${INSPECT_PORT}`, SERVER], {
    env: { ...process.env, PORT: String(APP_PORT) },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('server start timeout')), 10_000)
    proc.stdout.on('data', (c) => { if (String(c).includes('LISTENING')) { clearTimeout(t); res() } })
    proc.stderr.on('data', () => {})
    proc.on('error', rej)
  })
  kit = new DebuggerToolKit()
  await kit.call('debugger_connect', { port: INSPECT_PORT })
})

after(async () => {
  try { await kit?.dispose() } catch {}
  try { proc?.kill('SIGKILL') } catch {}
})

describe('per-tool output shapes', () => {
  it('debugger_breakpoints — [{id,file,line,kind}], no null condition', async () => {
    await kit.call('debugger_set_breakpoint', { file: 'http-locals-server.cjs', line: 25 })
    const { breakpoints } = parse(await kit.call('debugger_breakpoints', {}))
    assert.ok(breakpoints.length >= 1)
    const bp = breakpoints[0]
    assert.deepEqual(Object.keys(bp).sort(), ['file', 'id', 'kind', 'line'])
    assert.equal(bp.kind, 'breakpoint')
    assert.ok(!('condition' in bp), 'no null condition key')
  })

  it('debugger_state — bounded + redacted backend snapshot', async () => {
    // Fire a request; handler hits `debugger` and pauses.
    fetch(`http://127.0.0.1:${APP_PORT}/api/login`).catch(() => {})
    const backend = await waitPaused()
    assert.equal(backend.locals.submission.password, '[redacted]')
    assert.equal(backend.locals.req['@'], 'IncomingMessage')
  })

  it('debugger_eval — {ok,target,value}, type only for non-objects, never redacted', async () => {
    // object → no `type`, no null fields
    const obj = parse(await kit.call('debugger_eval', { expr: 'submission' }))
    assert.deepEqual(Object.keys(obj).sort(), ['ok', 'target', 'value'])
    assert.equal(obj.ok, true)
    assert.equal(obj.target, 'backend')
    // escape hatch: explicit eval of a secret is NOT redacted and is full-depth
    assert.equal(obj.value.password, 'hunter2')
    assert.equal(obj.value.vdfProof.steps.length, 200)

    // primitive → includes `type`
    const num = parse(await kit.call('debugger_eval', { expr: '1 + 1' }))
    assert.equal(num.value, 2)
    assert.equal(num.type, 'number')
  })

  it('debugger_state { expand } — full value of one path', async () => {
    const s = parse(await kit.call('debugger_state', { expand: 'submission.vdfProof.token' }))
    assert.equal(s.backend.expanded.path, 'submission.vdfProof.token')
    assert.equal(s.backend.expanded.value, 'secret-token-abcdef') // unbounded, unredacted
  })

  it('debugger_continue — clean {status:"running"} when nothing else fires', async () => {
    await kit.call('debugger_breakpoints', { remove: 1 }).catch(() => {})
    const out = parse(await kit.call('debugger_continue', { timeoutMs: 1000 }))
    assert.ok(['running', 'paused', 'terminated'].includes(out.status))
    if (out.status === 'running') assert.deepEqual(Object.keys(out), ['status'])
  })
})
