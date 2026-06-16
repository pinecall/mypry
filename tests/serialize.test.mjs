/**
 * Unit tests for the bounded serializer (src/core/serialize.ts).
 *
 * No CDP, no server — `inFrameSerialize` is the exact function that gets
 * injected into the target process, so testing it directly validates
 * production behavior. `buildSerializerExpr` is also exercised by eval()ing
 * its output, which proves the injected string actually runs.
 *
 * Run:  npm run build && node --test tests/serialize.test.mjs
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  inFrameSerialize,
  buildSerializerExpr,
  clampPrimitive,
  DEFAULT_LIMITS,
  SECRET_KEY_RE,
} from '../dist/core/serialize.js'

const L = DEFAULT_LIMITS

const lines = (v) => JSON.stringify(v, null, 2).split('\n').length

describe('inFrameSerialize — framework summarization', () => {
  it('collapses an IncomingMessage-like req to one short line', () => {
    const req = {
      method: 'POST',
      url: '/api/login',
      headers: { 'content-type': 'application/json', accept: '*/*', cookie: 'a=b' },
      socket: { remoteAddress: '127.0.0.1', remotePort: 54321 },
      // noise that must NOT appear
      _readableState: { buffer: [1, 2, 3], length: 999 },
      rawHeaders: new Array(40).fill('x'),
    }
    req.constructor = { name: 'IncomingMessage' }
    const out = inFrameSerialize(req, L)
    assert.equal(out['@'], 'IncomingMessage')
    assert.equal(out.method, 'POST')
    assert.equal(out.url, '/api/login')
    assert.equal(out.headers, '3 headers')
    assert.ok(lines(out) <= 20, `req summary should be tiny, got ${lines(out)} lines`)
  })

  it('collapses a ServerResponse-like res', () => {
    const res = {
      statusCode: 200,
      headersSent: false,
      finished: false,
      setHeader() {},
      _header: 'HTTP/1.1 200 OK',
    }
    res.constructor = { name: 'ServerResponse' }
    const out = inFrameSerialize(res, L)
    assert.deepEqual(out, { '@': 'ServerResponse', statusCode: 200, headersSent: false, finished: false })
  })

  it('summarizes Buffer as a byte count', () => {
    const out = inFrameSerialize(Buffer.from('hello world'), L)
    assert.equal(out, '[Buffer 11 bytes]')
  })
})

describe('inFrameSerialize — secret redaction', () => {
  it('redacts a password local regardless of value type', () => {
    assert.equal(inFrameSerialize({ password: 'hunter2' }, L).password, '[redacted]')
    assert.equal(inFrameSerialize({ apiKey: 'sk-123' }, L).apiKey, '[redacted]')
    assert.equal(inFrameSerialize({ authorization: 'Bearer x' }, L).authorization, '[redacted]')
    assert.equal(inFrameSerialize({ vdfToken: { proof: 1 } }, L).vdfToken, '[redacted]')
  })

  it('does not redact innocuous lookalikes', () => {
    assert.equal(inFrameSerialize({ author: 'alice' }, L).author, 'alice')
    assert.equal(inFrameSerialize({ username: 'bob' }, L).username, 'bob')
  })

  it('respects redact:false', () => {
    const out = inFrameSerialize({ password: 'hunter2' }, { ...L, redact: false })
    assert.equal(out.password, 'hunter2')
  })
})

describe('inFrameSerialize — bounds', () => {
  it('terminates at maxDepth', () => {
    const deep = { a: { b: { c: { d: { e: { f: 1 } } } } } }
    const out = inFrameSerialize(deep, { ...L, maxDepth: 3 })
    // root is depth 0: a(1) > b(2) > value-at-depth-3 collapses
    assert.equal(out.a.b.c, '[Object]')
  })

  it('handles circular references', () => {
    const a = { name: 'a' }
    a.self = a
    const out = inFrameSerialize(a, L)
    assert.equal(out.self, '[Circular]')
    assert.equal(out.name, 'a')
  })

  it('does not flag shared (non-circular) refs as circular', () => {
    const shared = { x: 1 }
    const out = inFrameSerialize({ a: shared, b: shared }, L)
    assert.deepEqual(out.a, { x: 1 })
    assert.deepEqual(out.b, { x: 1 })
  })

  it('caps long strings with a length marker', () => {
    const out = inFrameSerialize({ s: 'x'.repeat(5000) }, { ...L, maxString: 100 })
    assert.match(out.s, /^x{100}…\(5000 chars\)$/)
  })

  it('caps arrays with an overflow marker', () => {
    const out = inFrameSerialize({ arr: Array.from({ length: 250 }, (_, i) => i) }, { ...L, maxArray: 100 })
    assert.equal(out.arr.length, 101)
    assert.equal(out.arr[100], '…+150 more')
  })

  it('caps object breadth with a remaining-keys marker', () => {
    const big = {}
    for (let i = 0; i < 80; i++) big['k' + i] = i
    const out = inFrameSerialize(big, { ...L, maxKeys: 50 })
    assert.equal(out['…'], '+30 more keys')
  })

  it('drops known Node-internal keys but keeps _id', () => {
    const out = inFrameSerialize({ _id: 'abc', _events: {}, _readableState: {}, name: 'x' }, L)
    assert.equal(out._id, 'abc')
    assert.equal(out.name, 'x')
    assert.ok(!('_events' in out))
    assert.ok(!('_readableState' in out))
  })
})

describe('inFrameSerialize — value types', () => {
  it('handles primitives, functions, dates, errors, maps, sets', () => {
    assert.equal(inFrameSerialize({ f: () => {} }, L).f, '[Function: f]')
    assert.equal(inFrameSerialize({ n: 42 }, L).n, 42)
    assert.equal(inFrameSerialize({ b: true }, L).b, true)
    assert.equal(inFrameSerialize({ d: new Date('2020-01-01T00:00:00Z') }, L).d, '2020-01-01T00:00:00.000Z')
    const err = inFrameSerialize({ e: new TypeError('boom') }, L).e
    assert.equal(err['@error'], 'TypeError')
    assert.equal(err.message, 'boom')
    const m = inFrameSerialize(new Map([['a', 1]]), L)
    assert.equal(m['@Map'], 1)
    assert.deepEqual(m.entries, { a: 1 })
    const s = inFrameSerialize(new Set([1, 2]), L)
    assert.equal(s['@Set'], 2)
    assert.deepEqual(s.values, [1, 2])
  })

  it('unwraps a Vue ref()', () => {
    assert.equal(inFrameSerialize({ count: { __v_isRef: true, value: 5 } }, L).count, 5)
  })
})

describe('buildSerializerExpr — the injected string actually runs', () => {
  // The string returned here is exactly what gets injected into the target
  // process. eval()ing it locally proves it is self-contained and correct.
  const run = (expr, limits = L) => eval(buildSerializerExpr(expr, limits))

  it('serializes a literal object', () => {
    assert.deepEqual(run('({ a: 1, b: "two" })'), { a: 1, b: 'two' })
  })

  it('redacts inside the injected path', () => {
    assert.equal(run('({ token: "abc" })').token, '[redacted]')
  })

  it('catches eval errors instead of throwing', () => {
    assert.match(run('thisIsNotDefined'), /^\[eval error\]/)
  })

  it('bounds depth inside the injected path', () => {
    assert.equal(run('({ a: { b: { c: { d: 1 } } } })', { ...L, maxDepth: 2 }).a.b, '[Object]')
  })
})

describe('clampPrimitive', () => {
  it('redacts secret keys and clamps long strings', () => {
    assert.equal(clampPrimitive('password', 'hunter2', L), '[redacted]')
    assert.equal(clampPrimitive('email', 'a@b.com', L), 'a@b.com')
    assert.match(clampPrimitive('blob', 'y'.repeat(2000), { ...L, maxString: 50 }), /^y{50}…\(2000 chars\)$/)
  })
})

describe('SECRET_KEY_RE stays in sync with the in-frame regex', () => {
  // Guards against drift between the exported regex (used in mypry's process)
  // and the inline copy inside inFrameSerialize (runs in the target process).
  const secrets = ['password', 'apiKey', 'api_key', 'authorization', 'cookie', 'jwt', 'bearerToken', 'sessionSecret', 'privateKey']
  const safe = ['author', 'username', 'email', 'count', 'userId', 'publicUrl']
  it('matches secrets', () => {
    for (const k of secrets) {
      assert.ok(SECRET_KEY_RE.test(k), `expected ${k} to be secret`)
      assert.equal(inFrameSerialize({ [k]: 'x' }, L)[k], '[redacted]', `in-frame should redact ${k}`)
    }
  })
  it('leaves safe keys alone', () => {
    for (const k of safe) {
      assert.ok(!SECRET_KEY_RE.test(k), `expected ${k} to be safe`)
      assert.equal(inFrameSerialize({ [k]: 'x' }, L)[k], 'x', `in-frame should keep ${k}`)
    }
  })
})
