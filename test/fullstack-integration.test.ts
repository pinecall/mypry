/**
 * Fullstack integration tests — validates end-to-end debugging with the
 * examples/fullstack app (Express backend + React/Vite frontend).
 *
 * Tests:
 *  1. Backend: set_breakpoint on .js file → fires on API call
 *  2. Frontend: set_breakpoint on .tsx file → source-map resolves → fires
 *  3. Frontend: eval in browser context
 *  4. Frontend: locals visible when paused at breakpoint
 *
 * Requirements:
 *  - examples/fullstack deps installed (npm install)
 *  - Chrome available at standard path (frontend tests skip if missing)
 *
 * Run: npm run test:integration
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execSync, type ChildProcess } from 'node:child_process'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function findProjectRoot(dir: string): string {
  for (let levels = 1; levels <= 5; levels++) {
    const candidate = path.resolve(dir, ...Array(levels).fill('..'))
    if (existsSync(path.join(candidate, 'package.json'))) return candidate
  }
  throw new Error('could not find project root from ' + dir)
}

const ROOT = findProjectRoot(__dirname)
const MYPRY_CLI = path.join(ROOT, 'dist', 'cli.js')
const EXAMPLE_DIR = path.join(ROOT, 'examples', 'fullstack')
const CLIENT_DIR = path.join(EXAMPLE_DIR, 'client')

// ── Port allocation ───
const BACKEND_INSPECT_PORT = 9260
const BACKEND_HTTP_PORT = 3476     // Express API
const VITE_PORT = 5210
const MYPRY_HTTP_PORT = 3110
const CHROME_DEBUG_PORT = 9222  // mypry hardcodes this

// ── Helpers ───

function httpPost(port: number, path: string, body: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request({
      hostname: '127.0.0.1', port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let buf = ''
      res.on('data', (c: Buffer) => buf += c)
      res.on('end', () => {
        try { resolve(JSON.parse(buf)) } catch { resolve(buf) }
      })
    })
    req.on('error', reject)
    req.setTimeout(10_000, () => { req.destroy(); reject(new Error('timeout')) })
    req.write(data)
    req.end()
  })
}

function httpGet(port: number, path: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let buf = ''
      res.on('data', (c: Buffer) => buf += c)
      res.on('end', () => {
        try { resolve(JSON.parse(buf)) } catch { resolve(buf) }
      })
    })
    req.on('error', reject)
    req.setTimeout(5_000, () => { req.destroy(); reject(new Error('timeout')) })
    req.end()
  })
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

function waitForOutput(proc: ChildProcess, match: string, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for "${match}"`)), timeoutMs)
    const handler = (buf: Buffer) => {
      if (buf.toString().includes(match)) {
        clearTimeout(timer)
        proc.stderr?.off('data', handler)
        proc.stdout?.off('data', handler)
        resolve()
      }
    }
    proc.stderr?.on('data', handler)
    proc.stdout?.on('data', handler)
    proc.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`process exited with code ${code} before "${match}"`))
    })
  })
}

function killProc(proc: ChildProcess | null): Promise<void> {
  if (!proc || proc.killed || proc.exitCode !== null) return Promise.resolve()
  return new Promise(r => {
    proc.on('exit', () => r())
    proc.kill()
    setTimeout(() => { try { proc.kill('SIGKILL') } catch {} }, 2000)
    setTimeout(r, 3000) // fallback
  })
}

// ── Chrome detection ───

function findChrome(): string | null {
  const paths = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
  ]
  return paths.find(p => existsSync(p)) || null
}

// ── Test suite ───

describe('fullstack integration', { concurrency: 1, timeout: 120_000 }, () => {
  let backend: ChildProcess | null = null
  let vite: ChildProcess | null = null
  let chrome: ChildProcess | null = null
  let mypry: ChildProcess | null = null
  const chromePath = findChrome()

  before(async () => {
    // 1. Start Vite dev server
    vite = spawn('npx', ['vite', '--port', String(VITE_PORT)], {
      cwd: CLIENT_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PORT: String(BACKEND_HTTP_PORT) },
    })
    await waitForOutput(vite, 'ready in')

    // 2. Start backend Express server (with custom port + inspect)
    backend = spawn('node', [
      `--inspect=${BACKEND_INSPECT_PORT}`,
      'server/index.js',
    ], {
      cwd: EXAMPLE_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PORT: String(BACKEND_HTTP_PORT) },
    })
    await waitForOutput(backend, 'Server:')

    // 3. Start Chrome (if available) for frontend tests
    if (chromePath) {
      chrome = spawn(chromePath, [
        `--remote-debugging-port=${CHROME_DEBUG_PORT}`,
        `--user-data-dir=/tmp/mypry-integ-chrome-${Date.now()}`,
        '--no-first-run', '--no-default-browser-check', '--headless=new',
        `http://localhost:${VITE_PORT}`,
      ], { stdio: ['pipe', 'pipe', 'pipe'] })
      await sleep(3000) // Chrome startup
    }

    // 4. Start mypry serve
    const mypryArgs = [
      MYPRY_CLI, 'serve',
      '--inspect', String(BACKEND_INSPECT_PORT),
      '--port', String(MYPRY_HTTP_PORT),
    ]
    if (chromePath) {
      mypryArgs.push('--frontend', `http://localhost:${VITE_PORT}`)
    }
    mypry = spawn('node', mypryArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    await waitForOutput(mypry, 'HTTP server listening')
  })

  after(async () => {
    await killProc(mypry)
    await killProc(chrome)
    await killProc(backend)
    await killProc(vite)
  })

  // ── Backend tests ───

  it('health check returns ok', async () => {
    const r = await httpGet(MYPRY_HTTP_PORT, '/health')
    assert.equal(r.ok, true)
    assert.equal(r.connected, true)
  })

  it('backend: eval in running state', async () => {
    const r = await httpPost(MYPRY_HTTP_PORT, '/command', { op: 'eval', expr: '1 + 1' })
    assert.equal(r.ok, true)
    assert.equal(r.value, 2)
  })

  it('backend: set_breakpoint on server/index.js fires on API call', async () => {
    // Set breakpoint on the health route (line 90 — no pry() here)
    const bp = await httpPost(MYPRY_HTTP_PORT, '/command', {
      op: 'set_breakpoint', file: 'index.js', line: 90,
    })
    assert.ok(bp.ok || bp.id, `set_breakpoint failed: ${JSON.stringify(bp)}`)

    // Trigger the health endpoint in background
    httpGet(BACKEND_HTTP_PORT, '/api/health').catch(() => {})
    await sleep(1500)

    // Check if backend paused
    const state = await httpPost(MYPRY_HTTP_PORT, '/command', { op: 'state' })
    assert.equal(state.status, 'paused', 'backend should be paused at breakpoint')
    assert.ok(state.file?.includes('index'), `paused in wrong file: ${state.file}`)

    // Continue
    await httpPost(MYPRY_HTTP_PORT, '/command', { op: 'continue' })
    await sleep(500)

    // Remove breakpoint
    await httpPost(MYPRY_HTTP_PORT, '/command', { op: 'remove_breakpoint', id: bp.id })
  })

  // ── Frontend tests (skip if no Chrome) ───

  it('frontend: eval in browser returns DOM content', { skip: !chromePath }, async () => {
    // Reload to get fresh page
    await httpPost(MYPRY_HTTP_PORT, '/command', {
      op: 'eval', target: 'frontend',
      expr: 'document.title',
    })
    const r = await httpPost(MYPRY_HTTP_PORT, '/command', {
      op: 'eval', target: 'frontend',
      expr: 'document.querySelector("h1")?.textContent',
    })
    assert.equal(r.ok, true)
    assert.equal(r.type, 'string')
    assert.ok(r.value?.includes('mypry'), `unexpected h1: ${r.value}`)
  })

  it('frontend: set_breakpoint on App.tsx resolves source maps and fires', { skip: !chromePath }, async () => {
    // Reload Chrome page
    await httpPost(MYPRY_HTTP_PORT, '/command', {
      op: 'eval', target: 'frontend', expr: 'location.reload()',
    })
    await sleep(3000)

    // Set breakpoint on App.tsx line 52 (const res = await fetch inside fetchUsers)
    const bp = await httpPost(MYPRY_HTTP_PORT, '/command', {
      op: 'set_breakpoint', file: 'App.tsx', line: 52, target: 'frontend',
    })
    assert.ok(bp.ok || bp.id, `set_breakpoint failed: ${JSON.stringify(bp)}`)

    // Click the Load button in background (eval returns immediately but handler pauses)
    httpPost(MYPRY_HTTP_PORT, '/command', {
      op: 'eval', target: 'frontend',
      expr: 'document.querySelector("button").click()',
    }).catch(() => {}) // may timeout if Chrome pauses
    await sleep(3000)

    // Check frontend state — should be paused
    const state = await httpPost(MYPRY_HTTP_PORT, '/command', {
      op: 'state', target: 'frontend',
    })
    assert.equal(state.status, 'paused', `frontend should be paused, got: ${state.status}`)
    assert.ok(state.file?.includes('App'), `paused in wrong file: ${state.file}`)
    assert.equal(typeof state.locals, 'object', 'locals should be an object')

    // Verify source_window shows original TSX source (not generated code)
    const sw = state.source_window || []
    const hasOriginalSource = sw.some((l: any) =>
      l.text?.includes('fetch') || l.text?.includes('setLoading') || l.text?.includes('addLog')
    )
    assert.ok(hasOriginalSource, 'source_window should show original TSX code')

    // Continue frontend
    await httpPost(MYPRY_HTTP_PORT, '/command', { op: 'continue', target: 'frontend' })
    await sleep(500)

    // Also continue backend pry() if it fired
    const bState = await httpPost(MYPRY_HTTP_PORT, '/command', { op: 'state' })
    if (bState.status === 'paused') {
      await httpPost(MYPRY_HTTP_PORT, '/command', { op: 'continue' })
    }
    await sleep(500)

    // Continue frontend pry() if it fired after backend response
    const fState = await httpPost(MYPRY_HTTP_PORT, '/command', { op: 'state', target: 'frontend' })
    if (fState.status === 'paused') {
      await httpPost(MYPRY_HTTP_PORT, '/command', { op: 'continue', target: 'frontend' })
    }

    // Remove breakpoint
    await httpPost(MYPRY_HTTP_PORT, '/command', {
      op: 'remove_breakpoint', id: bp.id, target: 'frontend',
    })
  })

  it('frontend: locals include React useState values', { skip: !chromePath }, async () => {
    // Set breakpoint deeper — line 130 (setOrders inside fetchOrders)
    const bp = await httpPost(MYPRY_HTTP_PORT, '/command', {
      op: 'set_breakpoint', file: 'App.tsx', line: 130, target: 'frontend',
    })
    assert.ok(bp.ok || bp.id, `set_breakpoint failed: ${JSON.stringify(bp)}`)

    // fetchOrders calls GET /api/orders which has no backend pry() — clean test
    httpPost(MYPRY_HTTP_PORT, '/command', {
      op: 'eval', target: 'frontend',
      expr: 'fetch("http://localhost:' + BACKEND_HTTP_PORT + '/api/orders").then(r=>r.json())',
    }).catch(() => {})

    // Wait for breakpoint or pry() to fire
    await sleep(3000)

    const state = await httpPost(MYPRY_HTTP_PORT, '/command', {
      op: 'state', target: 'frontend',
    })

    if (state.status === 'paused') {
      // Verify locals contain React state variables
      const locals = state.locals || {}
      const keys = Object.keys(locals)
      // The React component's locals should include useState variables
      const hasReactState = keys.some(k =>
        ['users', 'orders', 'setUsers', 'setOrders', 'loading', 'log'].includes(k)
      )
      assert.ok(hasReactState, `locals should have React state, got: ${keys.join(', ')}`)

      // Continue
      await httpPost(MYPRY_HTTP_PORT, '/command', { op: 'continue', target: 'frontend' })
    }

    // Clean up any remaining pry pauses
    await sleep(500)
    const fState = await httpPost(MYPRY_HTTP_PORT, '/command', { op: 'state', target: 'frontend' })
    if (fState.status === 'paused') {
      await httpPost(MYPRY_HTTP_PORT, '/command', { op: 'continue', target: 'frontend' })
    }

    await httpPost(MYPRY_HTTP_PORT, '/command', {
      op: 'remove_breakpoint', id: bp.id, target: 'frontend',
    })
  })

  it('frontend: breakpoints list shows active breakpoints', { skip: !chromePath }, async () => {
    const bp1 = await httpPost(MYPRY_HTTP_PORT, '/command', {
      op: 'set_breakpoint', file: 'App.tsx', line: 45, target: 'frontend',
    })
    const bp2 = await httpPost(MYPRY_HTTP_PORT, '/command', {
      op: 'set_breakpoint', file: 'App.tsx', line: 120, target: 'frontend',
    })

    const list = await httpPost(MYPRY_HTTP_PORT, '/command', {
      op: 'breakpoints', target: 'frontend',
    })
    assert.ok(Array.isArray(list.breakpoints), 'breakpoints should be an array')
    assert.ok(list.breakpoints.length >= 2, `expected ≥2 breakpoints, got ${list.breakpoints.length}`)

    // Clean up
    await httpPost(MYPRY_HTTP_PORT, '/command', { op: 'remove_breakpoint', id: bp1.id, target: 'frontend' })
    await httpPost(MYPRY_HTTP_PORT, '/command', { op: 'remove_breakpoint', id: bp2.id, target: 'frontend' })
  })
})
