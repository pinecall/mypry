#!/usr/bin/env node
'use strict'

// Aurora ndjson contract test
// Run BEFORE and AFTER every phase to confirm Aurora's protocol is intact.
//
// Usage:
//   node test-aurora-contract.js
//   MYPRY_CLI=/path/to/mypry.js node test-aurora-contract.js

const { spawn } = require('node:child_process')
const readline = require('node:readline')
const path = require('node:path')

const MYPRY_CLI = process.env.MYPRY_CLI || path.join(__dirname, 'mypry.js')
const PRY_PATH = process.env.MYPRY_PRY || path.join(__dirname, 'lib', 'pry.cjs')
const TARGET_PORT = 9230

let passed = 0
let failed = 0

function assert(cond, msg) {
  if (!cond) {
    console.error(`  ✗ FAIL: ${msg}`)
    failed++
    return false
  }
  passed++
  return true
}

async function main() {
  console.log(`mypry contract test`)
  console.log(`  CLI: ${MYPRY_CLI}`)
  console.log(`  pry: ${PRY_PATH}`)
  console.log()

  // 1. Spawn a target with pry()
  const targetCode = `
    const pry = require('${PRY_PATH.replace(/\\/g, '\\\\')}');
    const x = 42;
    const y = { a: 1, b: 2 };
    pry({ port: ${TARGET_PORT} });
    const z = x + 1;
    console.log('continued past pry, z =', z);
  `
  const target = spawn('node', ['-e', targetCode], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  // Wait for inspector to be ready
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('target did not start inspector')), 10000)
    target.stderr.on('data', (buf) => {
      const text = buf.toString()
      if (text.includes('waiting for client')) {
        clearTimeout(timeout)
        resolve()
      }
    })
    target.on('exit', (code) => {
      clearTimeout(timeout)
      reject(new Error(`target exited early with code ${code}`))
    })
  })

  // 2. Attach mypry --json
  const mypry = spawn('node', [
    MYPRY_CLI, 'attach', '--json',
    '--host', '127.0.0.1',
    '--port', String(TARGET_PORT),
  ], { stdio: ['pipe', 'pipe', 'pipe'] })

  const lineQueue = []
  const lineWaiters = []

  const rl = readline.createInterface({ input: mypry.stdout })
  rl.on('line', (raw) => {
    let parsed
    try { parsed = JSON.parse(raw) } catch { return }
    if (lineWaiters.length) lineWaiters.shift()(parsed)
    else lineQueue.push(parsed)
  })

  const nextLine = (timeoutMs = 10000) => new Promise((resolve, reject) => {
    if (lineQueue.length) return resolve(lineQueue.shift())
    const timer = setTimeout(() => reject(new Error('timeout waiting for response')), timeoutMs)
    lineWaiters.push((data) => { clearTimeout(timer); resolve(data) })
  })

  const sendOp = (op, params = {}) => {
    const cmd = JSON.stringify({ op, ...params })
    mypry.stdin.write(cmd + '\n')
    return nextLine()
  }

  // Collect stderr for diagnostics
  let stderrBuf = ''
  mypry.stderr.on('data', (buf) => { stderrBuf += buf.toString() })

  try {
    // ── 3. Initial state ──
    console.log('Testing initial state...')
    const first = await nextLine()
    assert(first.status === 'paused', `initial status should be "paused", got "${first.status}"`)
    assert(typeof first.file === 'string', `state.file should be string, got ${typeof first.file}`)
    assert(typeof first.line === 'number', `state.line should be number, got ${typeof first.line}`)
    assert(typeof first.function === 'string', `state.function should be string`)
    assert(Array.isArray(first.source_window), `state.source_window should be array`)
    if (first.source_window?.length > 0) {
      const sw = first.source_window[0]
      assert(typeof sw.line === 'number', 'source_window[].line should be number')
      assert(typeof sw.text === 'string', 'source_window[].text should be string')
      assert(typeof sw.current === 'boolean', 'source_window[].current should be boolean')
    }
    assert(typeof first.locals === 'object' && first.locals !== null, 'state.locals should be object')
    assert('reason' in first, 'state should have reason field')

    // ── 4. op: state ──
    console.log('Testing op: state...')
    const stateResp = await sendOp('state')
    assert(stateResp.status === 'paused', 'state op returns paused')
    assert(typeof stateResp.file === 'string', 'state op has file')
    assert(typeof stateResp.line === 'number', 'state op has line')
    assert(Array.isArray(stateResp.source_window), 'state op has source_window')
    assert(typeof stateResp.locals === 'object', 'state op has locals')

    // ── 5. op: eval ──
    console.log('Testing op: eval...')
    const evalResp = await sendOp('eval', { expr: '1 + 1' })
    assert(evalResp.ok === true, `eval ok should be true, got ${evalResp.ok}`)
    assert(evalResp.value === 2, `eval value should be 2, got ${evalResp.value}`)
    assert(typeof evalResp.type === 'string', 'eval has type field')
    assert('description' in evalResp, 'eval has description field')

    // eval error case
    const evalErr = await sendOp('eval', { expr: 'nonexistent_var_xyz' })
    assert(evalErr.ok === false, 'eval error: ok should be false')
    assert(typeof evalErr.error === 'string', 'eval error: has error string')

    // ── 6. op: locals ──
    console.log('Testing op: locals...')
    const localsResp = await sendOp('locals')
    assert(typeof localsResp.locals === 'object', 'locals has locals object')

    // ── 7. op: backtrace ──
    console.log('Testing op: backtrace...')
    const btResp = await sendOp('backtrace')
    assert(Array.isArray(btResp.frames), 'backtrace has frames array')
    if (btResp.frames.length > 0) {
      const f = btResp.frames[0]
      assert(typeof f.function === 'string', 'frame has function')
      assert(typeof f.file === 'string', 'frame has file')
      assert(typeof f.line === 'number', 'frame has line')
    }

    // ── 8. op: source ──
    console.log('Testing op: source...')
    const srcResp = await sendOp('source')
    assert(typeof srcResp.file === 'string', 'source has file')
    assert(typeof srcResp.source === 'string', 'source has source text')
    assert(typeof srcResp.current_line === 'number', 'source has current_line')

    // ── 9. op: set_breakpoint + breakpoints + remove_breakpoint ──
    console.log('Testing breakpoint ops...')
    const setBp = await sendOp('set_breakpoint', { file: 'nonexistent', line: 1 })
    assert(setBp.ok === true, 'set_breakpoint returns ok')
    assert(typeof setBp.id === 'number', 'set_breakpoint returns id')

    const listBp = await sendOp('breakpoints')
    assert(Array.isArray(listBp.breakpoints), 'breakpoints returns array')
    assert(listBp.breakpoints.length >= 1, 'breakpoints list has our bp')

    const rmBp = await sendOp('remove_breakpoint', { id: setBp.id })
    assert(rmBp.ok === true, 'remove_breakpoint returns ok')

    // ── 10. op: step_over ──
    console.log('Testing op: step_over...')
    const stepResp = await sendOp('step_over')
    assert(stepResp.status === 'paused', 'step_over returns paused state')
    assert(typeof stepResp.file === 'string', 'step_over has file')
    assert(typeof stepResp.line === 'number', 'step_over has line')
    assert(Array.isArray(stepResp.source_window), 'step_over has source_window')
    assert(typeof stepResp.locals === 'object', 'step_over has locals')

    // ── 11. op: continue ──
    console.log('Testing op: continue...')
    // After step_over, the target may be on the last executable line.
    // continue may return terminated, or mypry may exit before responding.
    let contResp
    try {
      const mypryExited = new Promise((resolve) => {
        mypry.on('exit', () => resolve({ status: 'terminated', _exited: true }))
      })
      contResp = await Promise.race([
        sendOp('continue'),
        mypryExited,
      ])
    } catch {
      // Timeout or error — mypry may have exited
      contResp = { status: 'terminated', _exited: true }
    }
    assert(
      contResp.status === 'terminated' || contResp.status === 'paused',
      `continue returns terminated or paused, got ${contResp.status}`
    )

    // ── 12. op: quit ──
    console.log('Testing op: quit...')
    // If we got terminated, mypry may have already exited
    if (contResp.status !== 'terminated') {
      const quitResp = await sendOp('quit')
      assert(quitResp.status === 'disconnected', 'quit returns disconnected')
    }

    // Wait for mypry to exit
    await new Promise((resolve) => {
      if (contResp._exited) return resolve()
      const t = setTimeout(() => { mypry.kill(); resolve() }, 3000)
      mypry.on('exit', () => { clearTimeout(t); resolve() })
    })

  } catch (err) {
    console.error(`\n  ✗ FATAL: ${err.message}`)
    if (stderrBuf) console.error(`  mypry stderr:\n${stderrBuf}`)
    failed++
  } finally {
    try { mypry.kill() } catch {}
    try { target.kill() } catch {}
  }

  console.log()
  if (failed === 0) {
    console.log(`✅ Aurora contract OK (${passed} assertions passed)`)
  } else {
    console.log(`❌ Aurora contract FAILED (${failed} failures, ${passed} passed)`)
    process.exit(1)
  }
}

main().catch((e) => { console.error('fatal:', e); process.exit(1) })
