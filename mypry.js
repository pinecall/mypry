#!/usr/bin/env node
'use strict'

// mypry — a remote-friendly Node debugger CLI with two faces:
//   - default: pry-style interactive REPL for humans
//   - --json:  newline-delimited JSON over stdio for LLM agents
//
// Talks CDP (Chrome DevTools Protocol) over WebSocket. Zero deps. Node 22+.

const readline = require('node:readline')
const { parseArgs } = require('node:util')

// ─────────────────────────── CDP minimal client ───────────────────────────

class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.nextId = 0
    this.pending = new Map()
    this.eventHandlers = new Map()
    this.closed = false
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl)
    await new Promise((resolve, reject) => {
      const onOpen = () => { cleanup(); resolve() }
      const onError = () => { cleanup(); reject(new Error('websocket error')) }
      const cleanup = () => {
        this.ws.removeEventListener('open', onOpen)
        this.ws.removeEventListener('error', onError)
      }
      this.ws.addEventListener('open', onOpen)
      this.ws.addEventListener('error', onError)
    })
    this.ws.addEventListener('message', (ev) => this._onMessage(ev.data))
    this.ws.addEventListener('close', () => {
      this.closed = true
      for (const { reject } of this.pending.values()) reject(new Error('connection closed'))
      this.pending.clear()
      const handlers = this.eventHandlers.get('__close__') || []
      for (const h of handlers) h()
    })
  }

  _onMessage(data) {
    const msg = JSON.parse(data)
    if (msg.id != null) {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(`${msg.error.code}: ${msg.error.message}`))
      else p.resolve(msg.result)
    } else if (msg.method) {
      const handlers = this.eventHandlers.get(msg.method) || []
      for (const h of handlers) h(msg.params)
    }
  }

  send(method, params = {}) {
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  on(method, handler) {
    if (!this.eventHandlers.has(method)) this.eventHandlers.set(method, [])
    this.eventHandlers.get(method).push(handler)
  }

  onClose(handler) { this.on('__close__', handler) }
}

// ─────────────────────────── Debugger session ─────────────────────────────

class DebuggerSession {
  constructor(cdp) {
    this.cdp = cdp
    this.scripts = new Map()        // scriptId -> {url, source|null}
    this.currentPause = null        // {callFrames, reason, ...}
    this.pauseListeners = []
    this.onConsole = null           // callback for console output forwarding
  }

  async init() {
    this.cdp.on('Debugger.scriptParsed', (p) => {
      this.scripts.set(p.scriptId, { url: p.url, source: null })
    })
    this.cdp.on('Debugger.paused', (p) => {
      this.currentPause = p
      const ls = this.pauseListeners.splice(0)
      for (const l of ls) l(p)
    })
    this.cdp.on('Debugger.resumed', () => { this.currentPause = null })
    this.cdp.on('Runtime.consoleAPICalled', (p) => {
      if (this.onConsole) this.onConsole(p)
    })

    await this.cdp.send('Runtime.enable')
    await this.cdp.send('Debugger.enable')
  }

  topFrame() { return this.currentPause?.callFrames?.[0] || null }

  async getSource(scriptId) {
    const entry = this.scripts.get(scriptId)
    if (!entry) return null
    if (entry.source == null) {
      try {
        const r = await this.cdp.send('Debugger.getScriptSource', { scriptId })
        entry.source = r.scriptSource
      } catch { entry.source = '' }
    }
    return entry
  }

  async evalInFrame(expr) {
    const frame = this.topFrame()
    if (!frame) throw new Error('not paused')
    return this.cdp.send('Debugger.evaluateOnCallFrame', {
      callFrameId: frame.callFrameId,
      expression: expr,
      returnByValue: true,
      generatePreview: true,
    })
  }

  async getLocals() {
    const frame = this.topFrame()
    if (!frame) return {}
    const local = frame.scopeChain.find((s) => s.type === 'local')
    if (!local) return {}
    const r = await this.cdp.send('Runtime.getProperties', {
      objectId: local.object.objectId,
      ownProperties: true,
    })
    const out = {}
    for (const p of r.result || []) {
      if (!p.value) { out[p.name] = '[unset]'; continue }
      if (p.value.value !== undefined) out[p.name] = p.value.value
      else out[p.name] = p.value.description || `[${p.value.type}]`
    }
    return out
  }

  _waitRawPause() {
    if (this.currentPause) return Promise.resolve(this.currentPause)
    return new Promise((res) => this.pauseListeners.push(res))
  }

  async _skipPryFrames() {
    // When paused inside pry(), auto-step-out so the user lands in their code
    while (this.currentPause) {
      const top = this.currentPause.callFrames?.[0]
      if (!top) break
      const url = this.scripts.get(top.location.scriptId)?.url || ''
      if (!url.endsWith('/pry.js')) break
      this.currentPause = null
      await this.cdp.send('Debugger.stepOut')
      await this._waitRawPause()
    }
  }

  async waitNextPause() {
    await this._waitRawPause()
    await this._skipPryFrames()
    return this.currentPause
  }

  async stepOver()  { this.currentPause = null; await this.cdp.send('Debugger.stepOver');  return this.waitNextPause() }
  async stepInto()  { this.currentPause = null; await this.cdp.send('Debugger.stepInto');  return this.waitNextPause() }
  async stepOut()   { this.currentPause = null; await this.cdp.send('Debugger.stepOut');   return this.waitNextPause() }
  async resume()    { this.currentPause = null; return this.cdp.send('Debugger.resume') }
}

// ─────────────────────────── Pretty (human) renderer ──────────────────────

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  cyan: '\x1b[36m', yellow: '\x1b[33m', green: '\x1b[32m', red: '\x1b[31m',
}
const ARROW = `${C.bold}${C.yellow}►${C.reset}`

function cleanUrl(u) { return (u || '').replace(/^file:\/\//, '') }

function renderPause(session, ctx = 4) {
  const frame = session.topFrame()
  if (!frame) return `${C.dim}(not paused)${C.reset}\n`
  const scriptId = frame.location.scriptId
  const line = frame.location.lineNumber
  const script = session.scripts.get(scriptId)
  const lines = (script?.source || '').split('\n')
  const start = Math.max(0, line - ctx)
  const end = Math.min(lines.length - 1, line + ctx)
  const fname = cleanUrl(script?.url) || `<scriptId:${scriptId}>`
  const w = String(end + 1).length

  let out = `${C.dim}─── ${fname}:${line + 1}  ${frame.functionName || '<anon>'} ───${C.reset}\n`
  for (let i = start; i <= end; i++) {
    const num = String(i + 1).padStart(w, ' ')
    const text = lines[i] ?? ''
    if (i === line) {
      out += `${ARROW} ${C.bold}${num}${C.reset} │ ${C.yellow}${text}${C.reset}\n`
    } else {
      out += `  ${C.dim}${num} │ ${text}${C.reset}\n`
    }
  }
  return out
}

function formatValue(v) {
  if (v === undefined) return 'undefined'
  if (v === null) return 'null'
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'object') { try { return JSON.stringify(v) } catch { return String(v) } }
  return String(v)
}

const HELP = [
  '  n, next       step over',
  '  s, step       step into',
  '  o, out        step out',
  '  c, continue   resume execution',
  '  l, list       show source around current line',
  '  bt, where     show call stack',
  '  locals        list local variables',
  '  <expression>  evaluate in current frame (the pry trick)',
  '  q, quit       disconnect',
  '',
].join('\n')

// ─────────────────────────── Human (TTY) mode ─────────────────────────────

async function runHumanMode(session) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const ask = (q) => new Promise((res, rej) => {
    rl.question(q, (ans) => res(ans))
    rl.once('close', () => rej(new Error('stdin closed')))
  })

  // Forward console output from the target to this terminal
  session.onConsole = (event) => {
    const args = (event.args || []).map(a => {
      if (a.value !== undefined) return formatValue(a.value)
      return a.description || `[${a.type}]`
    })
    const text = args.join(' ')
    // Suppress Node-internal warnings (inspector SecurityWarning, etc.)
    if (text.includes('SecurityWarning') || text.includes('DeprecationWarning')) return
    const tag = event.type === 'log' ? '' : `.${event.type}`
    process.stdout.write(`${C.dim}[console${tag}]${C.reset} ${text}\n`)
  }

  await session.waitNextPause()
  await session.getSource(session.topFrame().location.scriptId)
  process.stdout.write(renderPause(session))

  session.cdp.onClose(() => {
    process.stdout.write(`\n${C.dim}(target disconnected)${C.reset}\n`)
    rl.close()
    process.exit(0)
  })

  while (true) {
    let line
    try { line = await ask(`${C.green}(mypry)${C.reset} `) } catch { break }
    const cmd = (line || '').trim()
    if (!cmd) continue

    try {
      const lc = cmd.toLowerCase()
      if (lc === 'q' || lc === 'quit' || lc === 'exit') break
      else if (lc === 'help' || lc === '?') process.stdout.write(HELP)
      else if (lc === 'n' || lc === 'next')      { await session.stepOver(); await afterStep(session) }
      else if (lc === 's' || lc === 'step')      { await session.stepInto(); await afterStep(session) }
      else if (lc === 'o' || lc === 'out')       { await session.stepOut();  await afterStep(session) }
      else if (lc === 'c' || lc === 'continue')  {
        await session.resume()
        process.stdout.write(`${C.dim}(running...)${C.reset}\n`)
        await session.waitNextPause()
        await afterStep(session)
      }
      else if (lc === 'l' || lc === 'list')      process.stdout.write(renderPause(session, 8))
      else if (lc === 'bt' || lc === 'where' || lc === 'backtrace') {
        const frames = session.currentPause?.callFrames || []
        for (let i = 0; i < frames.length; i++) {
          const f = frames[i]
          const u = cleanUrl(session.scripts.get(f.location.scriptId)?.url)
          const marker = i === 0 ? ARROW : ' '
          process.stdout.write(`  ${marker} ${i}: ${C.cyan}${f.functionName || '<anon>'}${C.reset} ${C.dim}${u}:${f.location.lineNumber + 1}${C.reset}\n`)
        }
      }
      else if (lc === 'locals') {
        const locals = await session.getLocals()
        for (const [k, v] of Object.entries(locals)) {
          process.stdout.write(`  ${C.cyan}${k}${C.reset} = ${formatValue(v)}\n`)
        }
      }
      else {
        // pry-style: bare expression → evaluate in current frame
        const r = await session.evalInFrame(cmd)
        if (r.exceptionDetails) {
          process.stdout.write(`${C.red}!! ${r.exceptionDetails.text}${C.reset}\n`)
          if (r.result?.description) process.stdout.write(`   ${r.result.description}\n`)
        } else {
          const val = r.result.value !== undefined ? r.result.value : r.result.description
          process.stdout.write(`${C.dim}=>${C.reset} ${formatValue(val)}\n`)
        }
      }
    } catch (e) {
      process.stdout.write(`${C.red}error: ${e.message}${C.reset}\n`)
    }
  }
  rl.close()
}

async function afterStep(session) {
  const frame = session.topFrame()
  if (frame) await session.getSource(frame.location.scriptId)
  process.stdout.write(renderPause(session))
}

// ─────────────────────────── Agent (JSON) mode ────────────────────────────
//
// Protocol: newline-delimited JSON in both directions.
// First message emitted: initial paused state.
// Each request: {"op": "..."} → exactly one JSON response on stdout.

async function runJsonMode(session) {
  await session.waitNextPause()
  await session.getSource(session.topFrame().location.scriptId)
  emit(await snapshot(session))

  session.cdp.onClose(() => { emit({ status: 'terminated' }); process.exit(0) })

  const rl = readline.createInterface({ input: process.stdin })
  for await (const raw of rl) {
    let req
    try { req = JSON.parse(raw) }
    catch (e) { emit({ error: `invalid json: ${e.message}` }); continue }

    try {
      const op = req.op
      switch (op) {
        case 'state':
          emit(await snapshot(session)); break
        case 'step_over':
          await session.stepOver();  await session.getSource(session.topFrame().location.scriptId); emit(await snapshot(session)); break
        case 'step_into':
          await session.stepInto();  await session.getSource(session.topFrame().location.scriptId); emit(await snapshot(session)); break
        case 'step_out':
          await session.stepOut();   await session.getSource(session.topFrame().location.scriptId); emit(await snapshot(session)); break
        case 'continue': {
          await session.resume()
          const result = await Promise.race([
            session.waitNextPause().then(() => 'paused'),
            new Promise((r) => session.cdp.onClose(() => r('terminated'))),
          ])
          if (result === 'terminated') { emit({ status: 'terminated' }); return }
          await session.getSource(session.topFrame().location.scriptId)
          emit(await snapshot(session))
          break
        }
        case 'eval': {
          const r = await session.evalInFrame(req.expr || '')
          if (r.exceptionDetails) {
            emit({ ok: false, error: r.exceptionDetails.text, description: r.result?.description })
          } else {
            emit({
              ok: true,
              type: r.result.type,
              value: r.result.value !== undefined ? r.result.value : null,
              description: r.result.description ?? null,
            })
          }
          break
        }
        case 'locals':
          emit({ locals: await session.getLocals() }); break
        case 'backtrace': {
          const frames = (session.currentPause?.callFrames || []).map((f) => ({
            function: f.functionName || '<anon>',
            file: cleanUrl(session.scripts.get(f.location.scriptId)?.url),
            line: f.location.lineNumber + 1,
          }))
          emit({ frames }); break
        }
        case 'source': {
          const f = session.topFrame()
          const s = await session.getSource(f.location.scriptId)
          emit({
            file: cleanUrl(s?.url),
            source: s?.source || '',
            current_line: f.location.lineNumber + 1,
          }); break
        }
        case 'quit':
          emit({ status: 'disconnected' }); return
        default:
          emit({ error: `unknown op: ${op}` })
      }
    } catch (e) {
      emit({ error: e.message })
    }
  }
}

async function snapshot(session) {
  const frame = session.topFrame()
  if (!frame) return { status: 'running' }
  const scriptId = frame.location.scriptId
  const s = await session.getSource(scriptId)
  const line = frame.location.lineNumber
  const lines = (s?.source || '').split('\n')
  const ctx = 4
  const start = Math.max(0, line - ctx)
  const end = Math.min(lines.length - 1, line + ctx)
  const sourceWindow = []
  for (let i = start; i <= end; i++) {
    sourceWindow.push({ line: i + 1, text: lines[i] ?? '', current: i === line })
  }
  return {
    status: 'paused',
    file: cleanUrl(s?.url),
    line: line + 1,
    function: frame.functionName || '<anon>',
    reason: session.currentPause?.reason || null,
    source_window: sourceWindow,
    locals: await session.getLocals(),
  }
}

function emit(obj) { process.stdout.write(JSON.stringify(obj) + '\n') }

// ─────────────────────────── Bootstrap ────────────────────────────────────

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      host: { type: 'string', default: '127.0.0.1' },
      port: { type: 'string', default: '9229' },
      url:  { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  })

  if (values.help || positionals[0] === 'help') {
    process.stdout.write(
      `mypry attach [--host HOST] [--port PORT] [--url WS_URL] [--json]\n\n` +
      `Examples:\n` +
      `  mypry attach                       # connects to 127.0.0.1:9229\n` +
      `  mypry attach --host 10.0.0.5       # remote\n` +
      `  mypry attach --json                # newline-JSON mode for agents\n`
    )
    return
  }

  // Resolve WebSocket URL via /json discovery if not given
  let wsUrl = values.url
  if (!wsUrl) {
    // 0.0.0.0 is a bind address, not routable — use 127.0.0.1 to connect
    const connectHost = values.host === '0.0.0.0' ? '127.0.0.1' : values.host
    let res
    try {
      res = await fetch(`http://${connectHost}:${values.port}/json`)
    } catch (e) {
      process.stderr.write(`cannot reach inspector at ${connectHost}:${values.port} — ${e.message}\n`)
      process.exit(1)
    }
    const list = await res.json()
    if (!list.length) { process.stderr.write('no inspectable contexts\n'); process.exit(1) }
    wsUrl = list[0].webSocketDebuggerUrl
    // The inspector may advertise 0.0.0.0 in the ws URL — fix it
    if (wsUrl.includes('0.0.0.0')) wsUrl = wsUrl.replace('0.0.0.0', connectHost)
  }

  const cdp = new CDPClient(wsUrl)
  await cdp.connect()
  const session = new DebuggerSession(cdp)
  await session.init()

  // Unblock target if it was launched with --inspect-brk or wait=true.
  await cdp.send('Runtime.runIfWaitingForDebugger')

  if (values.json) await runJsonMode(session)
  else             await runHumanMode(session)

  try { cdp.ws.close() } catch {}
  process.exit(0)
}

main().catch((e) => { process.stderr.write(`fatal: ${e.message}\n`); process.exit(1) })
