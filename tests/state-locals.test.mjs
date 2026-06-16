/**
 * End-to-end serializer test through a REAL CDP session.
 *
 * Spawns a plain Node http server, attaches a DebuggerSession, fires a
 * request that hits a `debugger` statement, and asserts the pause snapshot is
 * small and bounded — req/res summarized, secrets redacted, depth/array/string
 * capped, no node-internal call frames. This validates the injected
 * buildSerializerExpr path survives CDP `returnByValue`, which the pure unit
 * test cannot.
 *
 * Run:  npm run build && node --test tests/state-locals.test.mjs
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DebuggerSession } from '../dist/core/session.js'
import { CDPClient } from '../dist/core/cdp-client.js'
import { snapshot } from '../dist/core/snapshot.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SERVER = resolve(__dirname, 'fixtures/http-locals-server.cjs')
const APP_PORT = 3097
const INSPECT_PORT = 9242

let proc
let cdp
let session

before(async () => {
  proc = spawn(process.execPath, [`--inspect=${INSPECT_PORT}`, SERVER], {
    env: { ...process.env, PORT: String(APP_PORT) },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  // Wait for the app to be listening.
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('server start timeout')), 10_000)
    const onData = (c) => { if (String(c).includes('LISTENING')) { clearTimeout(t); res() } }
    proc.stdout.on('data', onData)
    proc.stderr.on('data', () => {}) // swallow the inspector banner
    proc.on('error', rej)
  })

  // Discover the inspector ws url and connect.
  const json = await (await fetch(`http://127.0.0.1:${INSPECT_PORT}/json`)).json()
  cdp = new CDPClient(json[0].webSocketDebuggerUrl)
  await cdp.connect()
  session = new DebuggerSession(cdp)
  await session.init()
  await cdp.send('Runtime.runIfWaitingForDebugger')
})

after(async () => {
  try { cdp?.ws.close() } catch {}
  try { proc?.kill('SIGKILL') } catch {}
})

describe('pause snapshot is bounded end-to-end', () => {
  let snap

  before(async () => {
    // Fire a request; the handler hits `debugger` and pauses (so don't await).
    const pause = session._waitRawPause()
    fetch(`http://127.0.0.1:${APP_PORT}/api/login`).catch(() => {})
    await pause
    snap = await snapshot(session)
    // Resume so the process can exit cleanly.
    await session.resume().catch(() => {})
  })

  it('is paused with a small total payload', () => {
    assert.equal(snap.status, 'paused')
    const bytes = JSON.stringify(snap).length
    assert.ok(bytes < 6000, `snapshot should be tiny, got ${bytes} bytes`)
  })

  it('summarizes req and res instead of dumping them', () => {
    const req = snap.locals.req
    assert.equal(req['@'], 'IncomingMessage')
    assert.equal(req.method, 'GET')
    assert.match(req.url, /\/api\/login/)
    const res = snap.locals.res
    assert.equal(res['@'], 'ServerResponse')
    assert.equal(typeof res.statusCode, 'number')
  })

  it('redacts secrets and bounds the submission object', () => {
    const s = snap.locals.submission
    assert.equal(s.password, '[redacted]')
    assert.equal(s.vdfProof.token, '[redacted]')
    // steps array capped at 100 + overflow marker
    assert.equal(s.vdfProof.steps.length, 101)
    assert.equal(s.vdfProof.steps[100], '…+100 more')
    // deep nesting collapses
    assert.equal(s.nested.a.b.c, '[Object]')
  })

  it('caps long string locals', () => {
    assert.match(snap.locals.bigString, /…\(5000 chars\)$/)
  })

  it('omits node-internal frames from the call stack (justMyCode)', () => {
    for (const f of snap.call_stack) {
      assert.ok(!f.file.includes('node:'), `unexpected node frame: ${f.file}`)
      assert.ok(!f.file.includes('node_modules'), `unexpected framework frame: ${f.file}`)
    }
  })
})
