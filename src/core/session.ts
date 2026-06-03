/**
 * DebuggerSession — slim orchestrator for a CDP debugging session.
 *
 * Delegates to focused subsystems:
 * - {@link BreakpointManager} — breakpoint lifecycle + resolution
 * - {@link ScriptSkipper} — V8 blackbox patterns for stepping
 * - {@link ExceptionPauseService} — exception breakpoint filtering
 * - {@link SmartStepper} — auto-step through framework code
 *
 * This class owns: CDP events, pause management, stepping, eval, locals, trace.
 * It does NOT contain breakpoint resolution, source map parsing, or pattern matching.
 */

import { CDPClient } from './cdp-client.js'
import type { IScriptEntry } from './types.js'
import { BreakpointManager } from './breakpoints/index.js'
import { ScriptSkipper, SmartStepper, ExceptionPauseService } from './skipper/index.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

type PauseListener = (params: unknown) => void

export class DebuggerSession {
  // ── CDP connection ─────────────────────────────────────────────────
  readonly cdp: CDPClient
  readonly scripts = new Map<string, IScriptEntry>()

  // ── Subsystems ─────────────────────────────────────────────────────
  readonly breakpoints: BreakpointManager
  readonly skipper: ScriptSkipper
  readonly exceptions: ExceptionPauseService
  private readonly smartStepper = new SmartStepper()

  // ── Pause state ────────────────────────────────────────────────────
  currentPause: any = null
  private pauseListeners: PauseListener[] = []
  onConsole: ((event: any) => void) | null = null

  // ── Trace mode ─────────────────────────────────────────────────────
  private tracing = false
  private traceBuffer: any[] = []
  private maxTraceBuffer = 100
  onTraceHit: ((entry: any) => void) | null = null

  constructor(cdp: CDPClient) {
    this.cdp = cdp
    this.breakpoints = new BreakpointManager(cdp, this.scripts)
    this.skipper = new ScriptSkipper(cdp)
    this.exceptions = new ExceptionPauseService(cdp, this.scripts)
  }

  // ── Initialization ─────────────────────────────────────────────────

  async init(): Promise<void> {
    this.cdp.on('Debugger.scriptParsed', (p: any) => {
      this.scripts.set(p.scriptId, { url: p.url, source: null, sourceMapURL: p.sourceMapURL })
    })

    this.cdp.on('Debugger.paused', (p: any) => {
      this.currentPause = p

      // Trace mode: capture snapshot and auto-resume
      if (this.tracing) {
        this._captureTraceHit().catch(() => {})
        return
      }

      // Exception filtering via ExceptionPauseService
      if (!this.exceptions.shouldPauseAt(p.reason, p.callFrames || [])) {
        if (p.reason === 'exception' || p.reason === 'promiseRejection') {
          this.cdp.send('Debugger.resume').catch(() => {})
          this.currentPause = null
          return
        }
      }

      // Hit-count breakpoints: check server-side condition
      if (p.reason === 'other' && p.hitBreakpoints?.length) {
        const cdpBpId = p.hitBreakpoints[0]
        if (!this.breakpoints.shouldStayPaused(cdpBpId)) {
          this.cdp.send('Debugger.resume').catch(() => {})
          this.currentPause = null
          return
        }
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

    // Apply V8 blackbox patterns for smart stepping
    await this.skipper.applyBlackboxPatterns()
  }

  // ── Frame access ───────────────────────────────────────────────────

  /** Get the top call frame from the current pause, or null */
  topFrame(): any {
    return this.currentPause?.callFrames?.[0] || null
  }

  /** Get a script's source code (fetched lazily from CDP) */
  async getSource(scriptId: string): Promise<IScriptEntry | null> {
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

  // ── Evaluation ─────────────────────────────────────────────────────

  /**
   * Evaluate a JavaScript expression.
   * When paused: evaluates in the top frame scope (access locals).
   * When running: evaluates in global scope.
   *
   * Includes smart serialization for Vue ref(), Pinia $state, and
   * circular-safe JSON.
   */
  async evalInFrame(expr: string): Promise<any> {
    const frame = this.topFrame()
    if (!frame) {
      return this.cdp.send('Runtime.evaluate', {
        expression: expr,
        returnByValue: true,
      })
    }

    return this.cdp.send('Debugger.evaluateOnCallFrame', {
      callFrameId: frame.callFrameId,
      expression: `(function(__expr) {
        try {
          var v = __expr;
          if (v && v.__v_isRef) v = v.value;
          if (v && v.$state) v = JSON.parse(JSON.stringify(v.$state));
          if (v && v.__v_raw) v = v.__v_raw;
          if (v === null) return null;
          if (v === undefined) return undefined;
          if (typeof v === 'string') return v;
          if (typeof v === 'number' || typeof v === 'boolean') return v;
          if (typeof v === 'function') return '[Function: ' + (v.name || 'anon') + ']';
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

  // ── Locals ─────────────────────────────────────────────────────────

  /** Get all local and closure variables from the top call frame */
  async getLocals(): Promise<Record<string, unknown>> {
    const frame = this.topFrame()
    if (!frame) return {}

    const out: Record<string, unknown> = {}
    const deepResolves: Promise<void>[] = []

    const processScope = async (objectId: string, target: Record<string, unknown>) => {
      const r = await this.cdp.send('Runtime.getProperties', {
        objectId,
        ownProperties: true,
      }) as any
      for (const p of r.result || []) {
        if (target[p.name] !== undefined) continue
        if (!p.value) { target[p.name] = '[unset]'; continue }
        const v = p.value
        if (v.value !== undefined) {
          target[p.name] = v.value
        } else if (v.type === 'function') {
          target[p.name] = `[Function: ${v.description?.split('(')[0]?.trim() || 'anon'}]`
        } else if (v.type === 'object' && v.objectId) {
          const name = p.name
          deepResolves.push(
            this.evalInFrame(name).then((er: any) => {
              if (er?.result?.value !== undefined) {
                target[name] = er.result.value
              } else {
                target[name] = v.description || `[${v.subtype || v.type}]`
              }
            }).catch(() => {
              target[name] = v.description || `[${v.subtype || v.type}]`
            }),
          )
        } else {
          target[p.name] = v.description || `[${v.type}]`
        }
      }
    }

    const local = frame.scopeChain.find((s: any) => s.type === 'local')
    if (local?.object?.objectId) {
      await processScope(local.object.objectId, out)
    }

    const closureVars: Record<string, unknown> = {}
    const closures = frame.scopeChain.filter((s: any) => s.type === 'closure')
    for (const closure of closures) {
      if (closure.object?.objectId) {
        await processScope(closure.object.objectId, closureVars)
      }
    }
    if (Object.keys(closureVars).length > 0) {
      out.__closure__ = closureVars
    }

    if (deepResolves.length) await Promise.all(deepResolves)
    return out
  }

  // ── Pause management ───────────────────────────────────────────────

  /** Wait for the next raw Debugger.paused event */
  _waitRawPause(): Promise<unknown> {
    if (this.currentPause) return Promise.resolve(this.currentPause)
    return new Promise(res => this.pauseListeners.push(res))
  }

  /** Auto-step out of pry() internal frames */
  async _skipPryFrames(): Promise<void> {
    while (this.currentPause) {
      const top = this.currentPause.callFrames?.[0]
      if (!top) break
      const rawUrl = this.scripts.get(top.location.scriptId)?.url || ''
      const url = rawUrl.split('?')[0]
      if (!url.endsWith('/pry.js') && !url.endsWith('/pry.cjs') && !url.endsWith('/browser.js')) break
      this.currentPause = null
      await this.cdp.send('Debugger.stepOut')
      await this._waitRawPause()
    }
  }

  /** Wait for the next pause, skipping pry() internal frames */
  async waitNextPause(): Promise<unknown> {
    await this._waitRawPause()
    await this._skipPryFrames()
    return this.currentPause
  }

  // ── Stepping ───────────────────────────────────────────────────────

  /** Step over the current statement */
  async stepOver(): Promise<unknown> {
    this.currentPause = null
    this.smartStepper.reset()
    await this.cdp.send('Debugger.stepOver')
    return this.waitNextPause()
  }

  /**
   * Step into the next function call.
   * Uses SmartStepper to auto-step through framework code.
   */
  async stepInto(): Promise<unknown> {
    this.currentPause = null
    await this.cdp.send('Debugger.stepInto')
    await this.waitNextPause()

    // Smart stepping: auto-step out of framework code
    for (let i = 0; i < 10; i++) {
      const frame = this.topFrame()
      if (!frame) break
      const script = this.scripts.get(frame.location.scriptId)
      const dir = this.smartStepper.getStepDirection(script?.url || '')
      if (!dir) break

      this.currentPause = null
      await this.cdp.send('Debugger.stepOut')
      await this.waitNextPause()
    }
    return this.currentPause
  }

  /** Step out of the current function */
  async stepOut(): Promise<unknown> {
    this.currentPause = null
    this.smartStepper.reset()
    await this.cdp.send('Debugger.stepOut')
    return this.waitNextPause()
  }

  /** Resume execution */
  async resume(): Promise<unknown> {
    this.currentPause = null
    this.smartStepper.reset()
    return this.cdp.send('Debugger.resume')
  }

  /** Force a pause */
  async pause(): Promise<unknown> {
    if (this.currentPause) return this.currentPause
    await this.cdp.send('Debugger.pause')
    return this._waitRawPause()
  }

  // ── Breakpoints (delegation) ───────────────────────────────────────

  /**
   * Set a breakpoint. Delegates to BreakpointManager.
   * @deprecated Use `this.breakpoints.set()` directly
   */
  async setBreakpoint(file: string, line: number, condition?: string): Promise<number> {
    return this.breakpoints.set(file, line, condition ? { condition } : {})
  }

  /**
   * Remove a breakpoint. Delegates to BreakpointManager.
   * @deprecated Use `this.breakpoints.remove()` directly
   */
  async removeBreakpoint(id: number): Promise<void> {
    return this.breakpoints.remove(id)
  }

  /**
   * Remove all breakpoints. Delegates to BreakpointManager.
   * @deprecated Use `this.breakpoints.removeAll()` directly
   */
  async removeAllBreakpoints(): Promise<void> {
    return this.breakpoints.removeAll()
  }

  // ── Trace mode ─────────────────────────────────────────────────────

  /** Start tracing: auto-resume on breakpoint hits, buffer entries */
  startTrace(maxBuffer?: number): void {
    this.tracing = true
    this.traceBuffer = []
    if (maxBuffer) this.maxTraceBuffer = maxBuffer
  }

  /** Stop tracing and return all buffered entries */
  stopTrace(): any[] {
    this.tracing = false
    const buffer = this.traceBuffer
    this.traceBuffer = []
    return buffer
  }

  /** Capture a trace entry from the current pause and auto-resume */
  private async _captureTraceHit(): Promise<void> {
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

    this.currentPause = null
    await this.cdp.send('Debugger.resume')
  }
}
