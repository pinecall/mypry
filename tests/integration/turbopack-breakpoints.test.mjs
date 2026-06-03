/**
 * Integration tests — Turbopack breakpoints in Next.js 14
 *
 * Same cart-bug fixture but with --turbopack flag.
 * Turbopack uses consolidated chunks with sectioned source maps — different
 * from webpack's per-module compilation. This suite verifies the debugger
 * handles both bundlers correctly.
 *
 * Run:  npm run build && node --test tests/integration/turbopack-breakpoints.test.mjs
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  startServer, stopServer,
  connectSession, disconnectSession,
  postAPI, fireAndWaitPause, warmUpRoutes,
  APP_PORT,
} from './helpers.mjs'
import { snapshot } from '../../dist/core/snapshot.js'

let serverProc = null
let ctx = null

before(async () => {
  console.log('  Starting Next.js dev server (Turbopack)...')
  serverProc = await startServer({ turbo: true })
  console.log(`  Server up on :${APP_PORT} (Turbopack)`)
})

after(async () => {
  if (ctx) disconnectSession(ctx)
  await stopServer(serverProc)
  console.log('  Server stopped')
})

beforeEach(async () => {
  ctx = await connectSession()
  await warmUpRoutes()
  await new Promise(r => setTimeout(r, 500))
})

afterEach(async () => {
  if (ctx) {
    // Resume if paused
    if (ctx.session.currentPause) {
      try { await ctx.session.resume() } catch {}
    }
    // Remove all breakpoints
    for (const [id] of ctx.session.breakpoints) {
      try { await ctx.session.removeBreakpoint(id) } catch {}
    }
    disconnectSession(ctx)
    ctx = null
  }
})

describe('turbopack breakpoints', () => {

  it('sets a breakpoint on a TS route and pauses on request', async () => {
    const { session } = ctx
    await session.setBreakpoint('app/api/cart/total/route.ts', 9)
    const result = await fireAndWaitPause(session,
      '/api/cart/total',
      { sessionId: 'turbo-test' }
    )
    assert.ok(result.paused, 'should pause at breakpoint')
    await session.resume()
  })

  it('source map resolution works (TS file path in snapshot)', async () => {
    const { session } = ctx
    await session.setBreakpoint('app/api/cart/total/route.ts', 9)
    const result = await fireAndWaitPause(session,
      '/api/cart/total',
      { sessionId: 'turbo-sourcemap' }
    )
    assert.ok(result.paused, 'should pause')

    const state = await snapshot(session)
    assert.equal(state.status, 'paused')
    // File should be resolved to TS, not a chunk URL
    assert.ok(
      state.file.includes('route.ts'),
      `file should be .ts, got: ${state.file}`
    )
    // Should NOT contain turbopack chunk URL
    assert.ok(
      !state.file.includes('[turbopack]'),
      `file should not contain [turbopack], got: ${state.file}`
    )

    await session.resume()
  })

  it('locals deep-serialize objects', async () => {
    const { session } = ctx
    await session.setBreakpoint('app/api/cart/total/route.ts', 9)

    // Add some items first
    await postAPI('/api/cart/add', { sessionId: 'turbo-locals', sku: 'KEY' })

    const result = await fireAndWaitPause(session,
      '/api/cart/total',
      { sessionId: 'turbo-locals' }
    )
    assert.ok(result.paused, 'should pause')

    const state = await snapshot(session)
    const locals = state.locals

    // cart should be a real object, not just "Object"
    const cartVal = locals.cart
    assert.ok(
      cartVal !== undefined && typeof cartVal !== 'string',
      `cart should be a real object, got: ${typeof cartVal}`
    )

    await session.resume()
  })

  it('call stack includes multiple frames', async () => {
    const { session } = ctx
    await session.setBreakpoint('app/api/cart/total/route.ts', 9)
    const result = await fireAndWaitPause(session,
      '/api/cart/total',
      { sessionId: 'turbo-stack' }
    )
    assert.ok(result.paused, 'should pause')

    const state = await snapshot(session)
    assert.ok(state.call_stack.length > 1, 'should have multiple stack frames')

    await session.resume()
  })

  it('eval works at breakpoint', async () => {
    const { session } = ctx
    await session.setBreakpoint('app/api/cart/total/route.ts', 9)

    await postAPI('/api/cart/add', { sessionId: 'turbo-eval', sku: 'KEY' })
    const result = await fireAndWaitPause(session,
      '/api/cart/total',
      { sessionId: 'turbo-eval' }
    )
    assert.ok(result.paused, 'should pause')

    const evalResult = await session.evalInFrame('cart.items.length')
    assert.ok(evalResult.result.value >= 0, 'should be able to eval at breakpoint')

    await session.resume()
  })

  it('step over advances to the next line', async () => {
    const { session } = ctx
    await session.setBreakpoint('app/api/cart/total/route.ts', 9)
    const result = await fireAndWaitPause(session,
      '/api/cart/total',
      { sessionId: 'turbo-step' }
    )
    assert.ok(result.paused, 'should pause')

    const stateBefore = await snapshot(session)
    const lineBefore = stateBefore.line

    await session.stepOver()

    const stateAfter = await snapshot(session)
    assert.ok(stateAfter.line > lineBefore, `should advance: ${lineBefore} → ${stateAfter.line}`)

    await session.resume()
  })

  it('logpoint does not pause', async () => {
    const { session } = ctx

    const condition = `(console.log(\`[logpoint] turbopack test\`), false)`
    await session.setBreakpoint('app/api/cart/total/route.ts', 9, condition)

    const result = await postAPI('/api/cart/total', { sessionId: 'turbo-logpoint' })
    assert.ok(result, 'should get response — logpoint should not pause')

    const pause = await Promise.race([
      session.waitNextPause().then(() => 'paused'),
      new Promise(r => setTimeout(r, 1000)).then(() => 'running'),
    ])
    assert.equal(pause, 'running', 'logpoint should NOT pause execution')
  })

  it('conditional breakpoint works', async () => {
    const { session } = ctx

    // Set conditional BP — only pause when sku === 'KEY'
    await session.setBreakpoint('app/api/cart/add/route.ts', 7, 'sku === "KEY"')

    // Send with sku=MUG — should NOT pause
    await postAPI('/api/cart/add', { sessionId: 'turbo-cond', sku: 'MUG' })
    const noPause = await Promise.race([
      session.waitNextPause().then(() => 'paused'),
      new Promise(r => setTimeout(r, 1000)).then(() => 'running'),
    ])
    assert.equal(noPause, 'running', 'should NOT pause for MUG')

    // Send with sku=KEY — SHOULD pause
    const fetchP = fetch(`http://localhost:${APP_PORT}/api/cart/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'turbo-cond', sku: 'KEY' }),
    }).catch(() => null)

    const yesP = await Promise.race([
      session.waitNextPause().then(() => 'paused'),
      new Promise(r => setTimeout(r, 5000)).then(() => 'timeout'),
    ])
    assert.equal(yesP, 'paused', 'should pause for KEY')
    await session.resume()
    await fetchP
  })
})
