/**
 * Inject e2e — attach to a plain Node process that was NOT started with
 * --inspect, set a breakpoint, and confirm a bounded/redacted pause.
 *
 * Exercises the headline `debugger_inject` path (findPidByPort → _debugProcess
 * → port scan → connect) plus set_breakpoint + the bounded serializer, all
 * through the real DebuggerToolKit (the MCP call path). No browser.
 *
 * Run:  npm run build && node --test tests/integration/inject.test.mjs
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DebuggerToolKit } from '../../dist/fullstack-toolkit.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP = resolve(__dirname, '../../examples/login-bug/server.cjs')
const APP_PORT = 3062
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const out = (r) => JSON.parse(r.content[0].text)

let app
let kit

before(async () => {
  // inject always opens the inspector on 9229 — make sure it's free.
  try { execSync('lsof -tiTCP:9229 -sTCP:LISTEN | xargs -r kill -9', { stdio: 'ignore' }) } catch {}
  app = spawn(process.execPath, [APP], { env: { ...process.env, PORT: String(APP_PORT) }, stdio: ['pipe', 'pipe', 'pipe'] })
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('app start timeout')), 8000)
    app.stdout.on('data', (c) => String(c).includes('LISTENING') && (clearTimeout(t), res()))
    app.on('error', rej)
  })
  kit = new DebuggerToolKit()
})

after(async () => {
  try { await kit?.dispose() } catch {}
  try { app?.kill('SIGKILL') } catch {}
})

describe('debugger_inject (no --inspect)', () => {
  it('attaches by app port and reports the inspector port', async () => {
    const r = out(await kit.call('debugger_inject', { appPort: APP_PORT }))
    assert.equal(r.backend?.connected, true)
    assert.ok(r.injected?.pid > 0, 'should report the PID it injected')
    assert.ok(r.injected?.inspectorPort > 0, 'should report the inspector port it found')
  })

  it('a breakpoint fires and the pause is bounded + redacted', async () => {
    await kit.call('debugger_set_breakpoint', { file: 'server.cjs', line: 62 })

    // Trigger the handler (don't await — it pauses at the breakpoint).
    fetch(`http://127.0.0.1:${APP_PORT}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'alice@corp.com', password: 'hunter2' }),
    }).catch(() => {})

    let st
    for (let i = 0; i < 60; i++) { st = out(await kit.call('debugger_state', {})); if (st.backend?.status === 'paused') break; await sleep(50) }

    assert.equal(st.backend.status, 'paused')
    assert.equal(st.backend.line, 62)
    // The bug is visible: sanitizeUser dropped role.
    assert.equal(st.backend.locals.user.role, undefined)
    assert.equal(st.backend.locals.dbUser.role, 'admin')
    // The submitted password is redacted.
    assert.equal(st.backend.locals.password, '[redacted]')
  })
})
