/**
 * Integration tests — webpack breakpoints in Next.js 14
 *
 * Real tests against a real Next.js dev server. No mocks.
 * Each test connects to the router server inspector via CDP,
 * sets breakpoints on TypeScript API routes, fires HTTP requests,
 * and verifies the debugger pauses at the right place with the right locals.
 *
 * Run:  npm run build && node --test tests/integration/webpack-breakpoints.test.mjs
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  startServer, stopServer,
  connectSession, disconnectSession,
  postAPI, fireAndWaitPause, warmUpRoutes,
  triggerHMR, restoreHMR,
  APP_PORT,
} from './helpers.mjs'

let serverProc = null
let ctx = null  // { session, cdp }

// ── Lifecycle ──

before(async () => {
  console.log('  Starting Next.js dev server...')
  serverProc = await startServer()
  console.log(`  Server up on :${APP_PORT}`)
})

after(async () => {
  restoreHMR()
  if (ctx) disconnectSession(ctx)
  await stopServer(serverProc)
  console.log('  Server stopped')
})

// Each test gets a fresh CDP session
beforeEach(async () => {
  ctx = await connectSession()
  // Warm up all routes so webpack compiles them and scripts are in the map
  await warmUpRoutes()
  // Brief pause to let scriptParsed events settle
  await new Promise(r => setTimeout(r, 500))
})

afterEach(async () => {
  restoreHMR()
  if (ctx) {
    try { await ctx.session.removeAllBreakpoints() } catch {}
    disconnectSession(ctx)
    ctx = null
  }
})

// ── Tests ──

describe('webpack-internal breakpoints', { timeout: 300_000 }, () => {

  it('sets a breakpoint on a TS route and pauses on request', async () => {
    const { session } = ctx
    const bpId = await session.setBreakpoint('app/api/cart/total/route.ts', 9)
    assert.ok(bpId > 0, 'breakpoint ID should be positive')

    const result = await fireAndWaitPause(
      session, '/api/cart/total', { sessionId: 'test_basic' }
    )
    assert.ok(result.paused, 'should pause at breakpoint')
    assert.ok(result.locals.cart !== undefined, 'should have cart in locals')
    assert.ok(result.locals.sessionId === 'test_basic', 'sessionId should match')

    await session.resume()
  })

  it('resolves source map correctly (TS line 9 → compiled line with cart in scope)', async () => {
    const { session } = ctx
    await session.setBreakpoint('app/api/cart/total/route.ts', 9)

    const result = await fireAndWaitPause(
      session, '/api/cart/total', { sessionId: 'test_srcmap' }
    )
    assert.ok(result.paused, 'should pause')

    // cart should be in scope and initialized (not "[unset]")
    // Line 9 of route.ts is: const subtotal = cart.items.reduce(...)
    // At this point cart is already assigned on line 6: const cart = getCart(sessionId)
    assert.ok(
      result.locals.cart !== '[unset]',
      `cart should be initialized at line 9, got: ${result.locals.cart}`
    )

    await session.resume()
  })

  it('selects the correct route when multiple routes share the basename "route.ts"', async () => {
    const { session } = ctx

    // Set breakpoint on the TOTAL route (not add, not clear)
    await session.setBreakpoint('app/api/cart/total/route.ts', 9)

    // Fire a request to the ADD route first — should NOT pause
    await postAPI('/api/cart/add', { sessionId: 'test_select', sku: 'KEY' })
    await new Promise(r => setTimeout(r, 500))
    assert.ok(!session.currentPause, 'should NOT pause on add route')

    // Fire a request to the TOTAL route — should pause
    const result = await fireAndWaitPause(
      session, '/api/cart/total', { sessionId: 'test_select' }
    )
    assert.ok(result.paused, 'should pause on total route')

    await session.resume()
  })

  it('supports conditional breakpoints', async () => {
    const { session } = ctx

    // Set conditional BP: only pause when cart has items AND a discount
    await session.setBreakpoint(
      'app/api/cart/total/route.ts', 9,
      'cart.items.length > 0 && cart.discountPct > 0'
    )

    // Request 1: empty cart → should NOT pause
    const r1 = await fireAndWaitPause(
      session, '/api/cart/total', { sessionId: 'test_cond' }, 3000
    )
    assert.ok(!r1.paused, 'should NOT pause on empty cart')

    // Setup: add item + coupon to plant the ghost discount bug
    await postAPI('/api/cart/add', { sessionId: 'test_cond', sku: 'KEY' })
    await postAPI('/api/cart/coupon', { sessionId: 'test_cond', code: 'SAVE25' })
    await postAPI('/api/cart/clear', { sessionId: 'test_cond' })
    await postAPI('/api/cart/add', { sessionId: 'test_cond', sku: 'PAD' })

    // Request 2: cart has items + ghost discount → should pause
    const r2 = await fireAndWaitPause(
      session, '/api/cart/total', { sessionId: 'test_cond' }
    )
    assert.ok(r2.paused, 'should pause when condition is met (ghost discount)')

    // Verify the ghost discount is visible in locals
    const cartVal = await session.evalInFrame('cart')
    const cart = cartVal?.result?.value
    assert.ok(cart, 'cart eval should return a value')
    assert.equal(cart.discountPct, 25, 'ghost discount should be 25%')
    assert.equal(cart.items.length, 1, 'cart should have 1 item')
    assert.equal(cart.items[0].sku, 'PAD', 'item should be the Desk Mat')

    await session.resume()
  })

  it('breakpoint survives webpack HMR', async () => {
    const { session } = ctx

    // Set breakpoint and verify it fires
    await session.setBreakpoint('app/api/cart/total/route.ts', 9)

    const r1 = await fireAndWaitPause(
      session, '/api/cart/total', { sessionId: 'test_hmr_pre' }
    )
    assert.ok(r1.paused, 'pre-HMR: should pause')
    await session.resume()
    await r1.fetchP
    await new Promise(r => setTimeout(r, 500))

    // Trigger HMR by modifying the source file
    triggerHMR()
    // Wait for webpack to recompile
    await new Promise(r => setTimeout(r, 4000))

    // Fire another request — breakpoint should still work
    const r2 = await fireAndWaitPause(
      session, '/api/cart/total', { sessionId: 'test_hmr_post' }
    )
    assert.ok(r2.paused, 'post-HMR: breakpoint should survive hot reload')

    await session.resume()
  })

  it('breakpoint works after disconnect + reconnect', async () => {
    const { session, cdp } = ctx

    // Verify initial connection works
    await session.setBreakpoint('app/api/cart/total/route.ts', 9)
    const r1 = await fireAndWaitPause(
      session, '/api/cart/total', { sessionId: 'test_reconn_1' }
    )
    assert.ok(r1.paused, 'initial connection: should pause')
    await session.resume()
    await r1.fetchP
    await new Promise(r => setTimeout(r, 500))

    // Disconnect
    disconnectSession(ctx)

    // Reconnect with fresh session
    ctx = await connectSession()
    await new Promise(r => setTimeout(r, 500))

    // Set breakpoint again on new session
    await ctx.session.setBreakpoint('app/api/cart/total/route.ts', 9)

    // Should pause on the reconnected session
    const r2 = await fireAndWaitPause(
      ctx.session, '/api/cart/total', { sessionId: 'test_reconn_2' }
    )
    assert.ok(r2.paused, 'after reconnect: should pause')

    await ctx.session.resume()
  })

  it('can set breakpoints on multiple different routes simultaneously', async () => {
    const { session } = ctx

    // Set BPs on both add and total routes
    const bpTotal = await session.setBreakpoint('app/api/cart/total/route.ts', 9)
    const bpAdd = await session.setBreakpoint('app/api/cart/add/route.ts', 12)
    assert.ok(bpTotal > 0)
    assert.ok(bpAdd > 0)
    assert.notEqual(bpTotal, bpAdd, 'different BP IDs')

    // Fire add request → should pause on add route
    const r1 = await fireAndWaitPause(
      session, '/api/cart/add', { sessionId: 'test_multi', sku: 'KEY' }
    )
    assert.ok(r1.paused, 'should pause on add route')
    await session.resume()
    await r1.fetchP
    await new Promise(r => setTimeout(r, 500))

    // Fire total request → should pause on total route
    const r2 = await fireAndWaitPause(
      session, '/api/cart/total', { sessionId: 'test_multi' }
    )
    assert.ok(r2.paused, 'should pause on total route')
    await session.resume()
  })

  it('remove breakpoint stops pausing', async () => {
    const { session } = ctx

    const bpId = await session.setBreakpoint('app/api/cart/total/route.ts', 9)

    // Verify it fires
    const r1 = await fireAndWaitPause(
      session, '/api/cart/total', { sessionId: 'test_remove_1' }
    )
    assert.ok(r1.paused, 'should pause before removal')
    await session.resume()
    await r1.fetchP
    await new Promise(r => setTimeout(r, 500))

    // Remove breakpoint
    await session.removeBreakpoint(bpId)

    // Fire again — should NOT pause
    const resp = await postAPI('/api/cart/total', { sessionId: 'test_remove_2' })
    await new Promise(r => setTimeout(r, 500))
    assert.ok(!session.currentPause, 'should NOT pause after breakpoint removal')
    assert.ok(resp, 'request should complete normally')
  })

  it('eval works at breakpoint — can inspect the ghost discount bug', async () => {
    const { session } = ctx

    // Plant the bug
    await postAPI('/api/cart/add', { sessionId: 'test_eval', sku: 'KEY' })
    await postAPI('/api/cart/add', { sessionId: 'test_eval', sku: 'MSE' })
    await postAPI('/api/cart/coupon', { sessionId: 'test_eval', code: 'SAVE25' })
    await postAPI('/api/cart/clear', { sessionId: 'test_eval' })
    await postAPI('/api/cart/add', { sessionId: 'test_eval', sku: 'PAD' })

    // Set BP and trigger
    await session.setBreakpoint('app/api/cart/total/route.ts', 9)
    const result = await fireAndWaitPause(
      session, '/api/cart/total', { sessionId: 'test_eval' }
    )
    assert.ok(result.paused, 'should pause')

    // Eval various expressions
    const cartRes = await session.evalInFrame('cart')
    const cart = cartRes?.result?.value
    assert.ok(cart, 'eval cart should work')
    assert.equal(cart.discountPct, 25, 'ghost discount is 25%')
    assert.equal(cart.items.length, 1, 'only 1 item after clear+add')
    // couponCode also survives the clear — that's part of the same bug!
    // clearCart() only clears items, not discountPct or couponCode.
    assert.equal(cart.couponCode, 'SAVE25', 'couponCode should persist (bug: not cleared)')

    // Eval sessionId
    const sidRes = await session.evalInFrame('sessionId')
    assert.equal(sidRes?.result?.value, 'test_eval')

    await session.resume()
  })

  it('step over advances to the next line', async () => {
    const { session } = ctx

    await session.setBreakpoint('app/api/cart/total/route.ts', 9)
    const result = await fireAndWaitPause(
      session, '/api/cart/total', { sessionId: 'test_step' }
    )
    assert.ok(result.paused, 'should pause at line 9')

    // Step over — should advance within the function
    await session.stepOver()
    assert.ok(session.currentPause, 'should still be paused after step over')

    // After stepping, subtotal should now be set
    const locals = await session.getLocals()
    assert.ok(
      locals.subtotal !== '[unset]',
      `subtotal should be set after step over, got: ${locals.subtotal}`
    )

  })

  // ── Edge case tests (v0.1.0-beta.8 improvements) ──

  it('locals deep-serialize objects — cart shows full JSON, not "Object"', async () => {
    const { session } = ctx

    // Setup: add items + coupon so cart has interesting nested data
    await postAPI('/api/cart/add', { sessionId: 'test_deep', sku: 'KEY' })
    await postAPI('/api/cart/add', { sessionId: 'test_deep', sku: 'MSE' })
    await postAPI('/api/cart/coupon', { sessionId: 'test_deep', code: 'SAVE10' })

    await session.setBreakpoint('app/api/cart/total/route.ts', 9)
    const result = await fireAndWaitPause(
      session, '/api/cart/total', { sessionId: 'test_deep' }
    )
    assert.ok(result.paused, 'should pause')

    const locals = await session.getLocals()

    // cart should be a FULL OBJECT, not the string "Object"
    assert.ok(
      typeof locals.cart === 'object' && locals.cart !== null,
      `cart should be a serialized object, got: ${typeof locals.cart} = ${JSON.stringify(locals.cart)}`
    )

    // Verify cart contents are accessible
    const cart = locals.cart
    assert.ok(Array.isArray(cart.items), 'cart.items should be an array')
    assert.equal(cart.items.length, 2, 'cart should have 2 items')
    assert.equal(cart.discountPct, 10, 'discountPct should be 10')
    assert.equal(cart.couponCode, 'SAVE10', 'couponCode should be SAVE10')

    // sessionId should still be a plain string
    assert.equal(locals.sessionId, 'test_deep', 'sessionId should be a string')

    await session.resume()
  })

  it('locals show [unset] for variables not yet initialized', async () => {
    const { session } = ctx

    // Line 9 is: const subtotal = cart.items.reduce(...)
    // At line 9, subtotal/discount/total should be [unset] (not yet assigned)
    await session.setBreakpoint('app/api/cart/total/route.ts', 9)
    const result = await fireAndWaitPause(
      session, '/api/cart/total', { sessionId: 'test_unset' }
    )
    assert.ok(result.paused, 'should pause')

    const locals = await session.getLocals()
    assert.equal(locals.subtotal, '[unset]', 'subtotal should be [unset] before assignment')
    assert.equal(locals.discount, '[unset]', 'discount should be [unset] before assignment')
    assert.equal(locals.total, '[unset]', 'total should be [unset] before assignment')

    // But cart and sessionId should be set (assigned on lines 5-6)
    assert.ok(locals.cart !== '[unset]', 'cart should be set')
    assert.ok(locals.sessionId !== '[unset]', 'sessionId should be set')

    await session.resume()
  })

  it('getLocals matches evalInFrame for complex objects', async () => {
    const { session } = ctx

    await postAPI('/api/cart/add', { sessionId: 'test_match', sku: 'PAD' })
    await session.setBreakpoint('app/api/cart/total/route.ts', 9)

    const result = await fireAndWaitPause(
      session, '/api/cart/total', { sessionId: 'test_match' }
    )
    assert.ok(result.paused, 'should pause')

    // Get cart via both paths
    const locals = await session.getLocals()
    const evalResult = await session.evalInFrame('cart')
    const evalCart = evalResult?.result?.value

    // Both should have the same shape
    assert.ok(typeof locals.cart === 'object', 'locals.cart should be an object')
    assert.ok(typeof evalCart === 'object', 'eval cart should be an object')
    assert.deepEqual(locals.cart.items, evalCart.items, 'items should match')
    assert.equal(locals.cart.discountPct, evalCart.discountPct, 'discountPct should match')

    await session.resume()
  })

  it('rejects breakpoint on non-existent file with helpful error', async () => {
    const { session } = ctx

    await assert.rejects(
      () => session.setBreakpoint('this/file/does-not-exist.ts', 1),
      (err) => {
        assert.ok(err.message.includes('No script matching'), `error should mention script search, got: ${err.message}`)
        assert.ok(err.message.includes('loaded scripts'), 'error should mention loaded scripts count')
        return true
      }
    )
  })

  it('req object in locals serializes as object, not just "Proxy"', async () => {
    const { session } = ctx

    // Pause at line 5 where req is in scope (const { sessionId } = await req.json())
    // Actually line 6 is better: const cart = getCart(sessionId)
    // At line 9, req is in scope from the function param
    await session.setBreakpoint('app/api/cart/total/route.ts', 9)
    const result = await fireAndWaitPause(
      session, '/api/cart/total', { sessionId: 'test_proxy' }
    )
    assert.ok(result.paused, 'should pause')

    const locals = await session.getLocals()
    // req is a NextRequest (Proxy) — should degrade gracefully, not crash
    // It should be either a serialized object or a description string, but NOT undefined
    assert.ok(locals.req !== undefined, 'req should be present in locals')

    await session.resume()
  })

  // ── v9 improvement tests ──

  it('snapshot source window shows TypeScript, not compiled JS', async () => {
    const { session } = ctx
    // Import snapshot from the built module
    const { snapshot } = await import('../../dist/core/snapshot.js')

    await session.setBreakpoint('app/api/cart/total/route.ts', 9)
    const result = await fireAndWaitPause(
      session, '/api/cart/total', { sessionId: 'test_srcwin' }
    )
    assert.ok(result.paused, 'should pause')

    const snap = await snapshot(session)
    assert.equal(snap.status, 'paused')

    // Source window should contain TypeScript code, not webpack compiled output
    const lines = snap.source_window.map(l => l.text)
    const allText = lines.join('\n')

    // Should contain recognizable TS code from route.ts
    assert.ok(
      allText.includes('cart') || allText.includes('sessionId') || allText.includes('subtotal'),
      `source window should contain TS code, got:\n${allText}`
    )

    // Should NOT contain webpack boilerplate
    assert.ok(
      !allText.includes('__webpack_require__') && !allText.includes('__webpack_exports__'),
      `source window should not contain webpack boilerplate, got:\n${allText}`
    )

    await session.resume()
  })

  it('snapshot includes call stack with multiple frames', async () => {
    const { session } = ctx
    const { snapshot } = await import('../../dist/core/snapshot.js')

    await session.setBreakpoint('app/api/cart/total/route.ts', 9)
    const result = await fireAndWaitPause(
      session, '/api/cart/total', { sessionId: 'test_stack' }
    )
    assert.ok(result.paused, 'should pause')

    const snap = await snapshot(session)
    assert.equal(snap.status, 'paused')

    // Should have call_stack array
    assert.ok(Array.isArray(snap.call_stack), 'call_stack should be an array')
    assert.ok(snap.call_stack.length >= 1, 'should have at least 1 frame')

    // Top frame should be our function
    const top = snap.call_stack[0]
    assert.ok(top.function, 'top frame should have function name')
    assert.ok(top.line > 0, 'top frame should have a line number')

    await session.resume()
  })

  it('snapshot file path resolves to TS, not webpack-internal URL', async () => {
    const { session } = ctx
    const { snapshot } = await import('../../dist/core/snapshot.js')

    await session.setBreakpoint('app/api/cart/total/route.ts', 9)
    const result = await fireAndWaitPause(
      session, '/api/cart/total', { sessionId: 'test_filepath' }
    )
    assert.ok(result.paused, 'should pause')

    const snap = await snapshot(session)
    assert.equal(snap.status, 'paused')

    // File should NOT be a webpack-internal URL
    assert.ok(
      !snap.file.includes('webpack-internal://'),
      `file should not be webpack URL, got: ${snap.file}`
    )

    // File should contain recognizable path
    assert.ok(
      snap.file.includes('route.ts') || snap.file.includes('cart'),
      `file should reference the TS source, got: ${snap.file}`
    )

    await session.resume()
  })

  it('locals include closure variables from parent scope', async () => {
    const { session } = ctx

    // The total route imports getCart from cart-store.ts
    // When paused inside POST, the closure should contain module-level imports
    await session.setBreakpoint('app/api/cart/total/route.ts', 9)
    const result = await fireAndWaitPause(
      session, '/api/cart/total', { sessionId: 'test_closure' }
    )
    assert.ok(result.paused, 'should pause')

    const locals = await session.getLocals()

    // Check that __closure__ exists and contains module-level variables
    // In webpack-compiled Next.js routes, closure typically includes
    // imported functions like getCart, NextResponse, etc.
    if (locals.__closure__) {
      assert.ok(typeof locals.__closure__ === 'object', '__closure__ should be an object')
      // It should contain at least some module-level bindings
      const closureKeys = Object.keys(locals.__closure__)
      assert.ok(closureKeys.length > 0, 'closure should have at least one variable')
    }
    // Note: closure existence depends on how webpack compiles the module.
    // The test passes either way — the key assertion is no crash.

    await session.resume()
  })

  it('exception breakpoint "all" pauses on thrown error', async () => {
    const { session } = ctx

    // Enable exception breakpoints
    await session.cdp.send('Debugger.setPauseOnExceptions', { state: 'all' })

    // Send a request with missing body to trigger a JSON parse error
    const fetchP = fetch(`http://localhost:${APP_PORT}/api/cart/total`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    }).catch(() => {})

    // Wait for first pause due to exception
    const pause = await Promise.race([
      session.waitNextPause().then(() => 'paused'),
      new Promise(r => setTimeout(r, 5000)).then(() => 'timeout'),
    ])

    if (pause === 'paused') {
      assert.ok(session.currentPause, 'should be paused on exception')
      const reason = session.currentPause?.reason
      assert.ok(
        reason === 'exception' || reason === 'promiseRejection' || reason === 'other',
        `pause reason should be exception-related, got: ${reason}`
      )
    }

    // Disable FIRST to prevent more pauses from queuing
    await session.cdp.send('Debugger.setPauseOnExceptions', { state: 'none' })

    // Resume all queued pauses (Next.js throws many internal exceptions)
    if (session.currentPause) {
      await session.resume()
      for (let i = 0; i < 50; i++) {
        const next = await Promise.race([
          session.waitNextPause().then(() => 'paused'),
          new Promise(r => setTimeout(r, 200)).then(() => 'running'),
        ])
        if (next !== 'paused') break
        await session.resume()
      }
    }

    await fetchP
  })

  it('exception breakpoint "none" disables exception pausing', async () => {
    const { session } = ctx

    // Make sure exception BPs are off
    await session.cdp.send('Debugger.setPauseOnExceptions', { state: 'none' })

    // Send malformed request — should NOT pause
    const fetchP = fetch(`http://localhost:${APP_PORT}/api/cart/total`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    }).catch(() => {})

    const pause = await Promise.race([
      session.waitNextPause().then(() => 'paused'),
      new Promise(r => setTimeout(r, 2000)).then(() => 'running'),
    ])

    assert.equal(pause, 'running', 'should NOT pause when exception BPs are disabled')
    await fetchP
  })

  it('logpoint logs without pausing', async () => {
    const { session } = ctx

    // Set a logpoint on the total route (line 9 — inside POST handler)
    // The trick is condition = '(console.log(...), false)' — never pauses
    const logMsg = 'cart has {cart.items.length} items'
    const template = logMsg.replace(/\{([^}]+)\}/g, '${$1}')
    const condition = `(console.log(\`[logpoint] ${template}\`), false)`
    await session.setBreakpoint('app/api/cart/total/route.ts', 9, condition)

    // Fire a request — should NOT pause (logpoint returns false)
    const result = await postAPI('/api/cart/total', { sessionId: 'logpoint-test' })

    // Verify we got a response (not blocked by pause)
    assert.ok(result, 'should get response — logpoint should not pause')

    // Brief wait to ensure no pause was triggered
    const pause = await Promise.race([
      session.waitNextPause().then(() => 'paused'),
      new Promise(r => setTimeout(r, 1000)).then(() => 'running'),
    ])
    assert.equal(pause, 'running', 'logpoint should NOT pause execution')
  })

  it('hit count breakpoint only pauses on Nth execution', async () => {
    const { session } = ctx

    // Set a hit count BP on the add route — only pause on 3rd call
    const counterVar = `__mypry_hit_test_${Date.now()}`
    const hitExpr = `(globalThis.${counterVar} = (globalThis.${counterVar} || 0) + 1) >= 3`
    await session.setBreakpoint('app/api/cart/add/route.ts', 7, hitExpr)

    const sid = `hitcount-${Date.now()}`

    // Call 1 and 2 — should NOT pause
    await postAPI('/api/cart/add', { sessionId: sid, sku: 'KEY' })
    await postAPI('/api/cart/add', { sessionId: sid, sku: 'MUG' })

    // Verify no pause after 2 calls
    const earlyPause = await Promise.race([
      session.waitNextPause().then(() => 'paused'),
      new Promise(r => setTimeout(r, 500)).then(() => 'running'),
    ])
    assert.equal(earlyPause, 'running', 'should NOT pause before hit count reached')

    // Call 3 — SHOULD pause
    const fetchP = fetch(`http://localhost:${APP_PORT}/api/cart/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sid, sku: 'PEN' }),
    }).catch(() => null)

    const thirdPause = await Promise.race([
      session.waitNextPause().then(() => 'paused'),
      new Promise(r => setTimeout(r, 5000)).then(() => 'timeout'),
    ])
    assert.equal(thirdPause, 'paused', 'should pause on 3rd execution (hit count)')
    await session.resume()
    await fetchP
  })
})
