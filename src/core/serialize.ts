/**
 * Bounded, summarizing value serializer — the single biggest lever on
 * how much an agent has to read per pause.
 *
 * `inFrameSerialize` is the ONE source of truth. It is used two ways:
 *
 *   1. Unit-tested directly (test/serialize.test.ts).
 *   2. Stringified via `.toString()` and injected into the *target* Node
 *      process (see {@link buildSerializerExpr}) so that locals collapse
 *      in-frame, bounded, BEFORE they ever cross the CDP wire.
 *
 * Because it is injected verbatim, `inFrameSerialize` MUST be fully
 * self-contained: no imports, no module-scope references, no closures.
 * Everything it needs is inlined or arrives via the `limits` argument.
 * (tsc target is ES2022 with no importHelpers, so `.toString()` yields
 * clean, runnable source — no `__spreadArray`/`__assign` shims leak in.)
 *
 * @module
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface SerializeLimits {
  /** Max object/array nesting before collapsing to `[Object]`/`[Array(n)]`. */
  maxDepth: number
  /** Max own-keys rendered per object; the rest become `"…": "+N more keys"`. */
  maxKeys: number
  /** Max array/Set elements rendered; the rest become `"…+N more"`. */
  maxArray: number
  /** Max string length before truncating with a `…(N chars)` marker. */
  maxString: number
  /** Redact values whose KEY looks secret (password/token/cookie/…). */
  redact: boolean
  /** Collapse known-noisy framework objects (req/res/socket/…) to one line. */
  frameworkSummary: boolean
}

/**
 * Conservative defaults. A typical Express pause snapshot drops from
 * thousands of lines to well under a hundred. Agents can widen per-call
 * (e.g. `debugger_state { depth: 6 }`).
 */
export const DEFAULT_LIMITS: SerializeLimits = {
  maxDepth: 4,
  maxKeys: 50,
  maxArray: 100,
  maxString: 1024,
  redact: true,
  frameworkSummary: true,
}

/**
 * Keys whose VALUE is a secret. Kept in sync (by hand + by test) with the
 * inline `SECRET` regex inside {@link inFrameSerialize} — that copy cannot
 * reference this one because it runs in the target process.
 *
 * `authorization` (not bare `auth`) avoids redacting `author`.
 */
export const SECRET_KEY_RE =
  /pass|secret|token|authorization|cookie|apikey|api[-_]?key|private|credential|passwd|pwd|jwt|bearer/i

/**
 * Bounded, summarizing serializer. Returns a JSON-safe structure (no
 * functions, no cycles, no Node internals) sized by `limits`.
 *
 * SELF-CONTAINED ON PURPOSE — see the module doc. Do not reference any
 * outer binding from this function body.
 */
export function inFrameSerialize(root: any, limits: SerializeLimits): any {
  const maxDepth = limits.maxDepth
  const maxKeys = limits.maxKeys
  const maxArray = limits.maxArray
  const maxString = limits.maxString
  const redact = limits.redact
  const frameworkSummary = limits.frameworkSummary

  // MUST mirror SECRET_KEY_RE in serialize.ts (verified by a unit test).
  const SECRET = /pass|secret|token|authorization|cookie|apikey|api[-_]?key|private|credential|passwd|pwd|jwt|bearer/i

  // Node-internal property names dropped wholesale (pure noise). Deliberately
  // specific so common user fields like `_id` (MongoDB) survive.
  const NOISE: Record<string, true> = {
    _readableState: true, _writableState: true, _events: true, _eventsCount: true,
    _maxListeners: true, _httpMessage: true, _httpParser: true, parser: true,
    _handle: true, _idleNext: true, _idlePrev: true, _idleStart: true,
    _idleTimeout: true, _onTimeout: true, _consuming: true, _dumped: true,
    _header: true, _keepAliveTimeout: true,
  }

  const seen = typeof WeakSet !== 'undefined' ? new WeakSet() : null

  function clampStr(s: string): string {
    return s.length > maxString ? s.slice(0, maxString) + '…(' + s.length + ' chars)' : s
  }

  function ctorName(v: any): string {
    try { return (v && v.constructor && v.constructor.name) || '' } catch (_e) { return '' }
  }

  function isPlain(v: any): boolean {
    try {
      const p = Object.getPrototypeOf(v)
      return p === Object.prototype || p === null
    } catch (_e) { return false }
  }

  /** One-line summary for known-noisy framework objects, or undefined. */
  function summarize(v: any): any {
    let cn = ''
    try { cn = ctorName(v) } catch (_e) { /* ignore */ }

    // Buffer / TypedArray
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer && Buffer.isBuffer(v)) {
      return '[Buffer ' + v.length + ' bytes]'
    }
    // HTTP request (IncomingMessage) — duck-typed so framework wrappers match too
    if (cn === 'IncomingMessage' ||
        (typeof v.method === 'string' && typeof v.url === 'string' && v.headers && v.socket)) {
      let h = 0
      try { h = v.headers && typeof v.headers === 'object' ? Object.keys(v.headers).length : 0 } catch (_e) { /* */ }
      return { '@': cn || 'IncomingMessage', method: v.method, url: v.url, headers: h + ' headers' }
    }
    // HTTP response (ServerResponse)
    if (cn === 'ServerResponse' ||
        (typeof v.statusCode === 'number' && typeof v.setHeader === 'function' && 'headersSent' in v)) {
      return { '@': cn || 'ServerResponse', statusCode: v.statusCode, headersSent: !!v.headersSent, finished: !!v.finished }
    }
    // Sockets
    if (cn === 'Socket' || cn === 'TLSSocket') {
      const addr = v.remoteAddress ? v.remoteAddress + ':' + v.remotePort : 'unconnected'
      return '[' + cn + ' ' + addr + ']'
    }
    // HTTP/net server
    if (cn === 'Server') return '[Server' + (v.listening ? ' listening' : '') + ']'
    // Generic readable/writable stream
    if (typeof v.pipe === 'function' && (v._readableState || v._writableState)) {
      return '[' + (cn || 'Stream') + ']'
    }
    // Node EventEmitter that isn't a plain object (Pool, app, emitter singletons)
    if (v._events && typeof v.on === 'function' && typeof v.emit === 'function' && !isPlain(v)) {
      return '[' + (cn || 'EventEmitter') + ']'
    }
    return undefined
  }

  function walk(v: any, depth: number, keyName: string | null): any {
    // Redact by key name first — covers any value type under a secret key.
    if (redact && keyName && SECRET.test(keyName)) return '[redacted]'

    if (v === null) return null
    const t = typeof v
    if (t === 'string') return clampStr(v)
    if (t === 'number') return v
    if (t === 'boolean') return v
    if (t === 'undefined') return undefined
    if (t === 'bigint') { try { return v.toString() + 'n' } catch (_e) { return '[bigint]' } }
    if (t === 'symbol') { try { return v.toString() } catch (_e) { return '[symbol]' } }
    if (t === 'function') return '[Function: ' + (v.name || 'anonymous') + ']'

    // object from here down
    // Unwrap Vue ref() and reactive proxy raw target before anything else.
    try {
      if (v.__v_isRef) return walk(v.value, depth, keyName)
      if (v.__v_raw) v = v.__v_raw
    } catch (_e) { /* exotic proxy — fall through */ }

    if (seen && seen.has(v)) return '[Circular]'

    if (frameworkSummary) {
      try {
        const s = summarize(v)
        if (s !== undefined) return s
      } catch (_e) { /* fall through to generic */ }
    }

    // Well-known builtins
    if (v instanceof Date) { try { return v.toISOString() } catch (_e) { return '[Date]' } }
    if (v instanceof RegExp) return String(v)
    if (v instanceof Error) {
      return { '@error': v.name || 'Error', message: clampStr(String(v.message || '')) }
    }

    if (depth >= maxDepth) {
      if (Array.isArray(v)) return '[Array(' + v.length + ')]'
      const cn = ctorName(v)
      return cn && cn !== 'Object' ? '[' + cn + ']' : '[Object]'
    }

    if (seen) seen.add(v)
    try {
      if (Array.isArray(v)) {
        const arr: any[] = []
        const n = v.length < maxArray ? v.length : maxArray
        for (let i = 0; i < n; i++) arr.push(walk(v[i], depth + 1, null))
        if (v.length > maxArray) arr.push('…+' + (v.length - maxArray) + ' more')
        return arr
      }
      if (typeof Map !== 'undefined' && v instanceof Map) {
        const mo: Record<string, any> = {}
        let c = 0
        for (const [mk, mv] of v) {
          if (c >= maxKeys) { mo['…'] = '+' + (v.size - c) + ' more'; break }
          const ks = typeof mk === 'string' ? mk : String(mk)
          mo[ks] = walk(mv, depth + 1, ks)
          c++
        }
        return { '@Map': v.size, entries: mo }
      }
      if (typeof Set !== 'undefined' && v instanceof Set) {
        const so: any[] = []
        let c = 0
        for (const sv of v) {
          if (c >= maxArray) { so.push('…+' + (v.size - c) + ' more'); break }
          so.push(walk(sv, depth + 1, null))
          c++
        }
        return { '@Set': v.size, values: so }
      }

      const out: Record<string, any> = {}
      let keys: string[]
      try { keys = Object.keys(v) } catch (_e) { keys = [] }
      let shown = 0
      let skipped = 0
      for (let j = 0; j < keys.length; j++) {
        const k = keys[j]
        if (NOISE[k]) continue
        if (shown >= maxKeys) { skipped++; continue }
        let child: any
        try { child = v[k] } catch (_e) { child = '[getter threw]' }
        const r = walk(child, depth + 1, k)
        if (r !== undefined) { out[k] = r; shown++ }
      }
      if (skipped > 0) out['…'] = '+' + skipped + ' more keys'
      return out
    } finally {
      if (seen) seen.delete(v)
    }
  }

  return walk(root, 0, null)
}

/**
 * Build the expression injected into the target process: evaluate `expr`
 * (errors caught), then bounded-serialize the result in-frame.
 */
export function buildSerializerExpr(expr: string, limits: SerializeLimits): string {
  const fn = inFrameSerialize.toString()
  const safeExpr =
    '(function(){ try { return (' + expr + '); } catch (e) { return "[eval error] " + (e && e.message || e) } })()'
  return '(' + fn + ')(' + safeExpr + ', ' + JSON.stringify(limits) + ')'
}

/**
 * Clamp/redact a PRIMITIVE local in mypry's own process (CDP already gives
 * us primitive values directly, so they never pass through the in-frame
 * serializer). Mirrors the string/redaction rules of {@link inFrameSerialize}.
 */
export function clampPrimitive(key: string, value: unknown, limits: SerializeLimits): unknown {
  if (limits.redact && key && SECRET_KEY_RE.test(key)) return '[redacted]'
  if (typeof value === 'string' && value.length > limits.maxString) {
    return value.slice(0, limits.maxString) + '…(' + value.length + ' chars)'
  }
  return value
}
