/**
 * Test helpers — real server lifecycle, CDP connection, request firing.
 * Zero mocks. Everything runs against the actual Next.js cart-bug example.
 */
import { spawn, execSync } from 'node:child_process'
import { DebuggerSession } from '../../dist/core/session.js'
import { CDPClient } from '../../dist/core/cdp-client.js'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const CART_BUG_DIR = resolve(__dirname, '../fixtures/cart-bug')
export const INSPECTOR_PORT = 9230
export const APP_PORT = 3099  // use non-standard port to avoid conflicts

// ── Port cleanup ──

/** Kill anything listening on our ports. */
function killPorts() {
  for (const port of [APP_PORT, 9229, INSPECTOR_PORT]) {
    try {
      const pids = execSync(
        `lsof -iTCP:${port} -sTCP:LISTEN -P -n -t 2>/dev/null`,
        { encoding: 'utf-8' }
      ).trim()
      if (pids) {
        for (const pid of pids.split('\n')) {
          try { process.kill(Number(pid), 'SIGKILL') } catch {}
        }
      }
    } catch { /* no process on this port */ }
  }
}

// ── Server lifecycle ──

/** Start the Next.js dev server with inspector, wait until ready.
 *  @param {{ turbo?: boolean }} opts
 */
export async function startServer(opts = {}) {
  // Kill any leftover processes on our ports
  killPorts()
  await new Promise(r => setTimeout(r, 1000))

  // Clean .next cache for deterministic state
  try { rmSync(resolve(CART_BUG_DIR, '.next'), { recursive: true, force: true }) } catch {}

  const args = ['next', 'dev', '-p', String(APP_PORT)]
  if (opts.turbo) args.push('--turbo')

  return new Promise((resolveP, rejectP) => {
    const proc = spawn('npx', args, {
      cwd: CART_BUG_DIR,
      env: { ...process.env, NODE_OPTIONS: '--inspect=9229' },
      stdio: ['pipe', 'pipe', 'pipe'],
      // detached: true so we can kill the entire process group later
      detached: true,
    })

    let output = ''
    let resolved = false
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true
        proc.kill('SIGKILL')
        rejectP(new Error('Server start timeout (30s). Output:\n' + output))
      }
    }, 30_000)

    const onData = (chunk) => {
      output += chunk.toString()
      if (!resolved && output.includes('Ready in')) {
        resolved = true
        clearTimeout(timeout)
        // Give router server a moment to open inspector port
        setTimeout(() => resolveP(proc), 1500)
      }
    }

    proc.stdout.on('data', onData)
    proc.stderr.on('data', onData)
    proc.on('error', (err) => {
      if (!resolved) { resolved = true; clearTimeout(timeout); rejectP(err) }
    })
    proc.on('exit', (code) => {
      if (!resolved && code !== null && code !== 0) {
        resolved = true
        clearTimeout(timeout)
        rejectP(new Error(`Server exited ${code}. Output:\n${output}`))
      }
    })
  })
}

/** Kill the server process tree and wait. */
export async function stopServer(proc) {
  if (!proc) return
  // Kill the process group to get all children (router worker, etc.)
  try { process.kill(-proc.pid, 'SIGTERM') } catch {}
  try { proc.kill('SIGTERM') } catch {}
  await new Promise(r => setTimeout(r, 1000))
  try { proc.kill('SIGKILL') } catch {}
  // Also clean up by port in case children survive
  killPorts()
  await new Promise(r => setTimeout(r, 500))
}

// ── CDP connection ──

/** Connect a DebuggerSession to the router server inspector. */
export async function connectSession() {
  // Retry connection up to 3 times (inspector may take a moment after HMR)
  let lastErr
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${INSPECTOR_PORT}/json`)
      const targets = await res.json()
      const wsUrl = targets[0]?.webSocketDebuggerUrl
      if (!wsUrl) throw new Error('No inspector target found')

      const cdp = new CDPClient(wsUrl)
      await cdp.connect()
      const session = new DebuggerSession(cdp)
      await session.init()
      return { session, cdp }
    } catch (err) {
      lastErr = err
      await new Promise(r => setTimeout(r, 1000))
    }
  }
  throw lastErr
}

/** Disconnect cleanly. */
export function disconnectSession(ctx) {
  if (!ctx) return
  try { ctx.cdp.ws.close() } catch {}
}

// ── Request helpers ──

/** POST to a cart-bug API endpoint and return the JSON response (or null on timeout). */
export async function postAPI(path, body, timeoutMs = 8000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`http://localhost:${APP_PORT}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    return await res.json()
  } catch {
    clearTimeout(timer)
    return null
  }
}

/**
 * Fire a request that we expect to cause a breakpoint pause.
 * Returns the pause info or null if it didn't pause within timeoutMs.
 */
export async function fireAndWaitPause(session, path, body, timeoutMs = 8000) {
  const ctrl = new AbortController()
  setTimeout(() => ctrl.abort(), timeoutMs)

  // Fire the request (don't await — it'll hang while paused)
  const fetchP = fetch(`http://localhost:${APP_PORT}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: ctrl.signal,
  }).catch(() => null)

  // Wait for pause (poll with backoff)
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (session.currentPause) {
      return {
        paused: true,
        locals: await session.getLocals(),
        location: session.currentPause.callFrames?.[0]?.location,
        fetchP,
      }
    }
    await new Promise(r => setTimeout(r, 100))
  }
  await fetchP
  return { paused: false, fetchP }
}

// ── Warm-up helper ──

/**
 * Hit all cart-bug API routes to force webpack compilation.
 * Must be done before setting breakpoints so scripts are in the Map.
 */
export async function warmUpRoutes(sid = '__warmup__') {
  await postAPI('/api/cart/add', { sessionId: sid, sku: 'KEY' })
  await postAPI('/api/cart/total', { sessionId: sid })
  await postAPI('/api/cart/coupon', { sessionId: sid, code: 'SAVE10' })
  await postAPI('/api/cart/clear', { sessionId: sid })
}

// ── HMR helper ──

const ROUTE_FILE = resolve(CART_BUG_DIR, 'app/api/cart/total/route.ts')
let _originalContent = null

/** Touch the total route file to trigger HMR. */
export function triggerHMR() {
  _originalContent = readFileSync(ROUTE_FILE, 'utf-8')
  const modified = _originalContent.replace(
    '// <-- BUEN SITIO PARA UN BREAKPOINT',
    `// <-- BUEN SITIO PARA UN BREAKPOINT (hmr-${Date.now()})`
  )
  writeFileSync(ROUTE_FILE, modified)
}

/** Restore the total route file to its original content. */
export function restoreHMR() {
  if (_originalContent) {
    writeFileSync(ROUTE_FILE, _originalContent)
    _originalContent = null
  }
}
