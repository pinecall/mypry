/**
 * DebuggerSession — manages a CDP debugging session.
 *
 * Mechanical translation from mypry.js lines 78-209.
 * DO NOT change behavior — this is load-bearing.
 */

import { CDPClient } from './cdp-client.js'

type PauseListener = (params: unknown) => void

interface ScriptEntry {
  url: string
  source: string | null
  sourceMapURL?: string
}

interface BreakpointEntry {
  file: string
  line: number
  cdpId: string
  condition?: string
}

/* eslint-disable @typescript-eslint/no-explicit-any */

export class DebuggerSession {
  cdp: CDPClient
  scripts: Map<string, ScriptEntry>
  currentPause: any
  pauseListeners: PauseListener[]
  onConsole: ((event: any) => void) | null
  breakpoints: Map<number, BreakpointEntry>
  _nextBpId: number

  // Trace mode — non-blocking observation
  tracing: boolean
  traceBuffer: any[]
  maxTraceBuffer: number
  onTraceHit: ((entry: any) => void) | null

  constructor(cdp: CDPClient) {
    this.cdp = cdp
    this.scripts = new Map()          // scriptId -> {url, source|null}
    this.currentPause = null          // {callFrames, reason, ...}
    this.pauseListeners = []
    this.onConsole = null             // callback for console output forwarding
    this.breakpoints = new Map()      // id -> {file, line, cdpId}
    this._nextBpId = 0
    this.tracing = false
    this.traceBuffer = []
    this.maxTraceBuffer = 100
    this.onTraceHit = null
  }

  async init(): Promise<void> {
    this.cdp.on('Debugger.scriptParsed', (p: any) => {
      this.scripts.set(p.scriptId, { url: p.url, source: null, sourceMapURL: p.sourceMapURL })
    })
    this.cdp.on('Debugger.paused', (p: unknown) => {
      this.currentPause = p

      // Trace mode: capture snapshot and auto-resume
      if (this.tracing) {
        this._captureTraceHit().catch(() => {})
        return
      }

      const ls = this.pauseListeners.splice(0)
      for (const l of ls) l(p)
    })
    this.cdp.on('Debugger.resumed', () => { this.currentPause = null })
    this.cdp.on('Runtime.consoleAPICalled', (p: unknown) => {
      if (this.onConsole) this.onConsole(p)
    })

    await this.cdp.send('Runtime.enable')
    await this.cdp.send('Debugger.enable')
  }

  topFrame(): any { return this.currentPause?.callFrames?.[0] || null }

  async getSource(scriptId: string): Promise<ScriptEntry | null> {
    const entry = this.scripts.get(scriptId)
    if (!entry) return null
    if (entry.source == null) {
      try {
        const r = await this.cdp.send('Debugger.getScriptSource', { scriptId }) as any
        entry.source = r.scriptSource
      } catch { entry.source = '' }
    }
    return entry
  }

  async evalInFrame(expr: string): Promise<any> {
    const frame = this.topFrame()
    if (!frame) {
      // Not paused — use Runtime.evaluate for global scope eval
      return this.cdp.send('Runtime.evaluate', {
        expression: expr,
        returnByValue: true,
      })
    }

    // Always use smart serializer — CDP returnByValue silently returns {}
    // for Vue/Pinia Proxy objects, so we can't rely on it.
    return this.cdp.send('Debugger.evaluateOnCallFrame', {
      callFrameId: frame.callFrameId,
      expression: `(function(__expr) {
        try {
          var v = __expr;
          // Unwrap Vue ref
          if (v && v.__v_isRef) v = v.value;
          // Unwrap Pinia store → raw state
          if (v && v.$state) v = JSON.parse(JSON.stringify(v.$state));
          // Unwrap Vue reactive proxy
          if (v && v.__v_raw) v = v.__v_raw;
          // Primitives
          if (v === null) return null;
          if (v === undefined) return undefined;
          if (typeof v === 'string') return v;
          if (typeof v === 'number' || typeof v === 'boolean') return v;
          if (typeof v === 'function') return '[Function: ' + (v.name || 'anon') + ']';
          // Object/Array — circular-safe JSON
          var seen = new WeakSet();
          return JSON.parse(JSON.stringify(v, function(k, val) {
            if (typeof val === 'object' && val !== null) {
              if (val.__v_isRef) return val.value;
              if (val.__v_raw) val = val.__v_raw;
              if (seen.has(val)) return '[Circular]';
              seen.add(val);
            }
            if (typeof val === 'function') return '[Function: ' + (val.name || 'anon') + ']';
            return val;
          }));
        } catch(e) {
          return '[eval error] ' + e.message;
        }
      })(${expr})`,
      returnByValue: true,
    })
  }

  async getLocals(): Promise<Record<string, unknown>> {
    const frame = this.topFrame()
    if (!frame) return {}
    const local = frame.scopeChain.find((s: any) => s.type === 'local')
    if (!local) return {}
    const r = await this.cdp.send('Runtime.getProperties', {
      objectId: local.object.objectId,
      ownProperties: true,
    }) as any
    const out: Record<string, unknown> = {}
    for (const p of r.result || []) {
      if (!p.value) { out[p.name] = '[unset]'; continue }
      if (p.value.value !== undefined) out[p.name] = p.value.value
      else out[p.name] = p.value.description || `[${p.value.type}]`
    }
    return out
  }

  _waitRawPause(): Promise<unknown> {
    if (this.currentPause) return Promise.resolve(this.currentPause)
    return new Promise((res) => this.pauseListeners.push(res))
  }

  async _skipPryFrames(): Promise<void> {
    // When paused inside pry(), auto-step-out so the user lands in their code
    while (this.currentPause) {
      const top = this.currentPause.callFrames?.[0]
      if (!top) break
      const rawUrl = this.scripts.get(top.location.scriptId)?.url || ''
      const url = rawUrl.split('?')[0]  // strip Vite ?t=... cache busters
      if (!url.endsWith('/pry.js') && !url.endsWith('/pry.cjs') && !url.endsWith('/browser.js')) break
      this.currentPause = null
      await this.cdp.send('Debugger.stepOut')
      await this._waitRawPause()
    }
  }

  async waitNextPause(): Promise<unknown> {
    await this._waitRawPause()
    await this._skipPryFrames()
    return this.currentPause
  }

  async stepOver(): Promise<unknown>  { this.currentPause = null; await this.cdp.send('Debugger.stepOver');  return this.waitNextPause() }
  async stepInto(): Promise<unknown>  { this.currentPause = null; await this.cdp.send('Debugger.stepInto');  return this.waitNextPause() }
  async stepOut(): Promise<unknown>   { this.currentPause = null; await this.cdp.send('Debugger.stepOut');   return this.waitNextPause() }
  async resume(): Promise<unknown>    { this.currentPause = null; return this.cdp.send('Debugger.resume') }

  async pause(): Promise<unknown> {
    if (this.currentPause) return this.currentPause
    await this.cdp.send('Debugger.pause')
    return this._waitRawPause()
  }

  async setBreakpoint(filePattern: string, line: number, condition?: string): Promise<number> {
    // line is 1-based from user, CDP uses 0-based
    const lineNumber = line - 1
    const isTS = /\.tsx?$/.test(filePattern)

    // For TypeScript files, we need to:
    // 1. Find the compiled .js script whose source map points to our .ts file
    // 2. Reverse-map the TS line → JS line using the source map
    // 3. Set the breakpoint on the .js file at the mapped line
    if (isTS) {
      const resolved = await this._resolveSourceMapBreakpoint(filePattern, lineNumber)
      if (resolved) {
        const params: Record<string, unknown> = {
          lineNumber: resolved.jsLine,
          urlRegex: resolved.jsUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        }
        if (condition) params.condition = condition
        const r = await this.cdp.send('Debugger.setBreakpointByUrl', params) as any
        const id = ++this._nextBpId
        this.breakpoints.set(id, { file: filePattern, line, cdpId: r.breakpointId, condition })
        return id
      }
    }

    // Fallback: direct regex match (works for .js files and Vite/ESM where URLs match)
    const escaped = filePattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const params: Record<string, unknown> = {
      lineNumber,
      urlRegex: escaped,
    }
    if (condition) params.condition = condition
    const r = await this.cdp.send('Debugger.setBreakpointByUrl', params) as any
    const id = ++this._nextBpId
    this.breakpoints.set(id, { file: filePattern, line, cdpId: r.breakpointId, condition })
    return id
  }

  /**
   * Resolve a TypeScript breakpoint to compiled JS coordinates.
   * Finds the .js script whose source map references our .ts file,
   * then reverse-maps the TS line to the JS line.
   */
  private async _resolveSourceMapBreakpoint(
    tsFile: string,
    tsLine0: number,
  ): Promise<{ jsUrl: string; jsLine: number } | null> {
    // Normalize: "auth.service.ts" or "src/auth/auth.service.ts"
    const tsBasename = tsFile.replace(/^.*[\\/]/, '')

    // Find a script whose source map references this .ts file
    for (const [scriptId, entry] of this.scripts) {
      if (!entry.sourceMapURL || !entry.url) continue
      // Only check .js files
      if (!/\.js(\?.*)?$/.test(entry.url)) continue

      try {
        // Resolve source map URL (can be relative to script URL or inline)
        let mapContent: string | null = null

        if (entry.sourceMapURL.startsWith('data:')) {
          // Inline source map
          const b64 = entry.sourceMapURL.split(',')[1]
          mapContent = Buffer.from(b64, 'base64').toString()
        } else {
          // File-based source map — read from disk
          const { readFileSync } = await import('fs')
          const { resolve, dirname } = await import('path')

          // Script URL is file:// or absolute path
          let scriptPath = entry.url.replace(/^file:\/\//, '')
          // Handle Windows-style paths
          if (process.platform === 'win32' && scriptPath.startsWith('/'))
            scriptPath = scriptPath.slice(1)

          const mapPath = resolve(dirname(scriptPath), entry.sourceMapURL)
          mapContent = readFileSync(mapPath, 'utf8')
        }

        if (!mapContent) continue

        const rawMap = JSON.parse(mapContent)
        // Check if any source in the map matches our TS file
        const sources: string[] = rawMap.sources || []
        const matchIdx = sources.findIndex((s: string) => {
          const sBasename = s.replace(/^.*[\\/]/, '')
          return sBasename === tsBasename || s.endsWith(tsFile) || tsFile.endsWith(s)
        })
        if (matchIdx === -1) continue

        // Found it! Now reverse-map the TS line to JS line using source-map
        const { SourceMapConsumer } = await import('source-map')
        const consumer = await new SourceMapConsumer(rawMap)
        try {
          // Find the generated position for this original position
          const gen = consumer.generatedPositionFor({
            source: sources[matchIdx],
            line: tsLine0 + 1, // source-map lib uses 1-based
            column: 0,
          })
          if (gen.line != null) {
            return { jsUrl: entry.url, jsLine: gen.line - 1 } // back to 0-based
          }
        } finally {
          consumer.destroy()
        }
      } catch {
        // Skip this script if source map can't be read/parsed
        continue
      }
    }
    return null
  }

  async removeBreakpoint(id: number): Promise<void> {
    const bp = this.breakpoints.get(id)
    if (!bp) throw new Error(`no breakpoint #${id}`)
    await this.cdp.send('Debugger.removeBreakpoint', { breakpointId: bp.cdpId })
    this.breakpoints.delete(id)
  }

  async removeAllBreakpoints(): Promise<void> {
    for (const [, bp] of this.breakpoints) {
      try { await this.cdp.send('Debugger.removeBreakpoint', { breakpointId: bp.cdpId }) } catch {}
    }
    this.breakpoints.clear()
  }

  // ── Trace mode ──

  async _captureTraceHit(): Promise<void> {
    const frame = this.topFrame()
    if (!frame) { await this.resume(); return }

    const scriptId = frame.location.scriptId
    const s = await this.getSource(scriptId)
    const line = frame.location.lineNumber + 1

    const entry = {
      timestamp: Date.now(),
      file: (s?.url || '').replace(/^file:\/\//, ''),
      line,
      function: frame.functionName || '<anon>',
      locals: await this.getLocals(),
    }

    if (this.traceBuffer.length < this.maxTraceBuffer) {
      this.traceBuffer.push(entry)
    }
    if (this.onTraceHit) this.onTraceHit(entry)

    // Auto-resume — don't block execution
    this.currentPause = null
    await this.cdp.send('Debugger.resume')
  }

  startTrace(maxBuffer?: number): void {
    this.tracing = true
    this.traceBuffer = []
    if (maxBuffer) this.maxTraceBuffer = maxBuffer
  }

  stopTrace(): any[] {
    this.tracing = false
    const buffer = this.traceBuffer
    this.traceBuffer = []
    return buffer
  }
}
