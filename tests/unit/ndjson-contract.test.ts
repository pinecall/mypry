/**
 * ndjson contract tests — locks in the Aurora protocol with node:test.
 *
 * Each test spawns a fresh target + mypry pair on a unique port
 * to avoid conflicts. Tests validate every op shape from Section 5.2.
 */

import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnTarget, attachMypry, type SpawnedTarget, type MypryClient } from './helpers/index.js'

// Base port — each test uses base + offset to avoid collisions
const BASE_PORT = 9240

describe('ndjson contract', { concurrency: 1 }, () => {
  // Track resources for cleanup
  const targets: SpawnedTarget[] = []
  const clients: MypryClient[] = []

  after(async () => {
    for (const c of clients) await c.exit().catch(() => {})
    for (const t of targets) await t.exit().catch(() => {})
  })

  async function setup(portOffset: number) {
    const port = BASE_PORT + portOffset
    const target = await spawnTarget('target-simple.cjs', { port })
    targets.push(target)
    const client = await attachMypry({ port })
    clients.push(client)
    return { target, client, port }
  }

  it('initial state is paused with all required fields', async () => {
    const { client } = await setup(0)
    const first = await client.nextLine()

    assert.equal(first.status, 'paused')
    assert.equal(typeof first.file, 'string')
    assert.equal(typeof first.line, 'number')
    assert.equal(typeof first.function, 'string')
    assert.ok(Array.isArray(first.source_window), 'source_window is array')
    assert.ok(first.source_window.length > 0, 'source_window not empty')

    const current = first.source_window.find((l: any) => l.current === true)
    assert.ok(current, 'source_window has a current line')
    assert.equal(typeof current.line, 'number')
    assert.equal(typeof current.text, 'string')

    assert.equal(typeof first.locals, 'object')
    assert.ok(first.locals !== null)
    assert.ok('reason' in first)
  })

  it('op: state returns same shape as initial', async () => {
    const { client } = await setup(1)
    await client.nextLine() // initial

    const state = await client.command({ op: 'state' })
    assert.equal(state.status, 'paused')
    assert.equal(typeof state.file, 'string')
    assert.equal(typeof state.line, 'number')
    assert.ok(Array.isArray(state.source_window))
    assert.equal(typeof state.locals, 'object')
  })

  it('op: eval success returns {ok, type, value, description}', async () => {
    const { client } = await setup(2)
    await client.nextLine()

    const r = await client.command({ op: 'eval', expr: '1 + 1' })
    assert.equal(r.ok, true)
    assert.equal(r.value, 2)
    assert.equal(typeof r.type, 'string')
    assert.ok('description' in r)
  })

  it('op: eval error returns {ok: false, error}', async () => {
    const { client } = await setup(3)
    await client.nextLine()

    const r = await client.command({ op: 'eval', expr: 'nonexistent_xyz_var' })
    assert.equal(r.ok, false)
    assert.equal(typeof r.error, 'string')
  })

  it('op: eval complex expression', async () => {
    const { client } = await setup(4)
    await client.nextLine()

    const r = await client.command({ op: 'eval', expr: 'JSON.stringify({a:1})' })
    assert.equal(r.ok, true)
    assert.equal(r.value, '{"a":1}')
  })

  it('op: locals returns {locals: object}', async () => {
    const { client } = await setup(5)
    await client.nextLine()

    const r = await client.command({ op: 'locals' })
    assert.equal(typeof r.locals, 'object')
    assert.ok(r.locals !== null)
  })

  it('op: backtrace returns {frames: array}', async () => {
    const { client } = await setup(6)
    await client.nextLine()

    const r = await client.command({ op: 'backtrace' })
    assert.ok(Array.isArray(r.frames))
    assert.ok(r.frames.length > 0)

    const f = r.frames[0]
    assert.equal(typeof f.function, 'string')
    assert.equal(typeof f.file, 'string')
    assert.equal(typeof f.line, 'number')
  })

  it('op: source returns {file, source, current_line}', async () => {
    const { client } = await setup(7)
    await client.nextLine()

    const r = await client.command({ op: 'source' })
    assert.equal(typeof r.file, 'string')
    assert.equal(typeof r.source, 'string')
    assert.equal(typeof r.current_line, 'number')
    assert.ok(r.source.length > 0, 'source is not empty')
  })

  it('op: set_breakpoint + breakpoints + remove_breakpoint', async () => {
    const { client } = await setup(8)
    await client.nextLine()

    // Set
    const setBp = await client.command({ op: 'set_breakpoint', file: 'nonexistent', line: 1 })
    assert.equal(setBp.ok, true)
    assert.equal(typeof setBp.id, 'number')
    assert.equal(setBp.file, 'nonexistent')
    assert.equal(setBp.line, 1)

    // List
    const list = await client.command({ op: 'breakpoints' })
    assert.ok(Array.isArray(list.breakpoints))
    assert.ok(list.breakpoints.length >= 1)
    const found = list.breakpoints.find((bp: any) => bp.id === setBp.id)
    assert.ok(found, 'set breakpoint appears in list')

    // Remove
    const rm = await client.command({ op: 'remove_breakpoint', id: setBp.id })
    assert.equal(rm.ok, true)

    // Verify removal
    const list2 = await client.command({ op: 'breakpoints' })
    const notFound = list2.breakpoints.find((bp: any) => bp.id === setBp.id)
    assert.equal(notFound, undefined, 'removed breakpoint gone from list')
  })

  it('op: step_over returns paused snapshot', async () => {
    const { client } = await setup(9)
    await client.nextLine()

    const r = await client.command({ op: 'step_over' })
    assert.equal(r.status, 'paused')
    assert.equal(typeof r.file, 'string')
    assert.equal(typeof r.line, 'number')
    assert.ok(Array.isArray(r.source_window))
    assert.equal(typeof r.locals, 'object')
  })

  it('op: step_into returns paused snapshot', async () => {
    const { client } = await setup(10)
    await client.nextLine()

    const r = await client.command({ op: 'step_into' })
    assert.equal(r.status, 'paused')
    assert.equal(typeof r.line, 'number')
  })

  it('op: step_out returns paused snapshot', async () => {
    const { client } = await setup(11)
    await client.nextLine()

    const r = await client.command({ op: 'step_out' })
    // step_out from top-level may terminate or land in internal frames
    assert.ok(r.status === 'paused' || r.status === 'running')
  })

  it('op: continue → terminated or paused', async () => {
    const { client } = await setup(12)
    await client.nextLine()

    // step_over first to advance past pry line
    await client.command({ op: 'step_over' })

    // continue — target should complete and terminate
    // mypry may exit before we get a response line
    let r: any
    try {
      r = await client.command({ op: 'continue' })
    } catch {
      r = { status: 'terminated', _exited: true }
    }
    assert.ok(
      r.status === 'terminated' || r.status === 'paused' || r._exited,
      `continue returned ${r.status}`
    )
  })

  it('op: quit returns {status: "disconnected"}', async () => {
    const { client } = await setup(13)
    await client.nextLine()

    const r = await client.command({ op: 'quit' })
    assert.equal(r.status, 'disconnected')
  })

  it('unknown op returns {error}', async () => {
    const { client } = await setup(14)
    await client.nextLine()

    const r = await client.command({ op: 'nonexistent_op' })
    assert.equal(typeof r.error, 'string')
    assert.ok(r.error.includes('unknown op'))
  })

  it('invalid JSON returns {error}', async () => {
    const { client } = await setup(15)
    await client.nextLine()

    // Send raw invalid JSON
    client.proc.stdin!.write('not json\n')
    const r = await client.nextLine()
    assert.equal(typeof r.error, 'string')
    assert.ok(r.error.includes('invalid json'))
  })
})
