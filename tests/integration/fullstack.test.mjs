/**
 * Fullstack e2e — drive the browser and pause the backend in one session.
 *
 * Opens a headless browser on the login page, sets a backend breakpoint, fills
 * + submits the form, and asserts the click auto-attaches the backend pause
 * (the bug: sanitizeUser drops `role`). Covers the browser-facing tools that
 * the unit suite can't: connect+frontend, snapshot, browse, eval target:browser.
 *
 * Needs Playwright Chromium (`npx playwright install chromium`).
 * Run:  npm run build && node --test tests/integration/fullstack.test.mjs
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DebuggerToolKit } from '../../dist/fullstack-toolkit.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP = resolve(__dirname, '../../examples/login-bug/server.cjs')
const APP_PORT = 3063
const INSPECT_PORT = 9246
const out = (r) => JSON.parse(r.content[0].text)

let app
let kit

before(async () => {
  // Start WITH --inspect so we can debugger_connect (deterministic, no lsof).
  app = spawn(process.execPath, [`--inspect=${INSPECT_PORT}`, APP], { env: { ...process.env, PORT: String(APP_PORT) }, stdio: ['pipe', 'pipe', 'pipe'] })
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('app start timeout')), 8000)
    app.stdout.on('data', (c) => String(c).includes('LISTENING') && (clearTimeout(t), res()))
    app.stderr.on('data', () => {})
    app.on('error', rej)
  })
  kit = new DebuggerToolKit()
  await kit.call('debugger_connect', { port: INSPECT_PORT, frontend: `http://127.0.0.1:${APP_PORT}` })
})

after(async () => {
  try { await kit?.dispose() } catch {}
  try { app?.kill('SIGKILL') } catch {}
})

describe('fullstack: browser click → backend pause', () => {
  it('snapshot exposes the form selectors', async () => {
    const aria = (await kit.call('debugger_snapshot', {})).content[0].text
    assert.match(aria, /textbox "Email"/)
    assert.match(aria, /button "Sign in"/)
  })

  it('browse fills + submits and auto-attaches the backend pause showing the bug', async () => {
    await kit.call('debugger_set_breakpoint', { file: 'server.cjs', line: 62 })

    const r = out(await kit.call('debugger_browse', { actions: [
      { fill: ['textbox Email', 'alice@corp.com'] },
      { fill: ['textbox Password', 'hunter2'] },
      { click: 'button Sign in' },
    ] }))

    assert.equal(r.browser.ok, true, 'all 3 actions should complete')
    assert.equal(r.backend?.status, 'paused', 'the click should auto-attach a backend pause')
    assert.equal(r.backend.line, 62)
    // The sanitized user the gate reads has no role; the DB row did.
    assert.equal(r.backend.locals.user.role, undefined)
    assert.equal(r.backend.locals.dbUser.role, 'admin')
  })

  it('eval reaches the browser side too', async () => {
    const r = out(await kit.call('debugger_eval', { expr: 'document.title', target: 'browser' }))
    assert.equal(r.ok, true)
    assert.equal(r.value, 'Acme Admin')
    await kit.call('debugger_continue', { timeoutMs: 1500 })
  })
})
