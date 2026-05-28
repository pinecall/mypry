/**
 * Shared op dispatch — used by both ndjson.ts and http.ts.
 *
 * Centralizes the Aurora protocol implementation so both transports
 * behave identically for the same ops.
 */

import type { DebuggerSession } from './session.js'
import { snapshot, cleanUrl } from './snapshot.js'
import { resolveOriginalPosition, readOriginalSource } from './sourcemap.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Resolve a script location to its original .ts path via source maps.
 */
async function resolveFrame(session: DebuggerSession, scriptId: string, lineNumber: number): Promise<{ file: string; line: number }> {
  const script = session.scripts.get(scriptId)
  const compiledFile = cleanUrl(script?.url)
  const compiledLine = lineNumber + 1

  if (script?.source) {
    const orig = await resolveOriginalPosition(compiledFile, script.source, compiledLine, 0)
    if (orig) return { file: orig.source, line: orig.line }
  }

  return { file: compiledFile, line: compiledLine }
}

export async function executeOp(
  session: DebuggerSession,
  op: string,
  params: Record<string, any> = {}
): Promise<any> {
  switch (op) {
    case 'state':
      return snapshot(session)

    case 'step_over':
      await session.stepOver()
      if (session.topFrame()) await session.getSource(session.topFrame().location.scriptId)
      return snapshot(session)

    case 'step_into':
      await session.stepInto()
      if (session.topFrame()) await session.getSource(session.topFrame().location.scriptId)
      return snapshot(session)

    case 'step_out':
      await session.stepOut()
      if (session.topFrame()) await session.getSource(session.topFrame().location.scriptId)
      return snapshot(session)

    case 'continue': {
      await session.resume()
      return { status: 'running' }
    }

    case 'eval': {
      const r = await session.evalInFrame(params.expr || '') as any
      if (r.exceptionDetails) {
        return { ok: false, error: r.exceptionDetails.text, description: r.result?.description }
      }
      return {
        ok: true,
        type: r.result.type,
        value: r.result.value !== undefined ? r.result.value : null,
        description: r.result.description ?? null,
      }
    }

    case 'locals':
      return { locals: await session.getLocals() }

    case 'backtrace': {
      const rawFrames = session.currentPause?.callFrames || []
      const frames = await Promise.all(rawFrames.map(async (f: any) => {
        // Load source if needed (for source map resolution)
        await session.getSource(f.location.scriptId)
        const resolved = await resolveFrame(session, f.location.scriptId, f.location.lineNumber)
        return {
          function: f.functionName || '<anon>',
          file: resolved.file,
          line: resolved.line,
        }
      }))
      return { frames }
    }

    case 'source': {
      const f = session.topFrame()
      if (!f) return { error: 'not paused' }
      const s = await session.getSource(f.location.scriptId)
      const compiledFile = cleanUrl(s?.url)
      const compiledLine = f.location.lineNumber + 1

      // Try source map resolution
      let file = compiledFile
      let source = s?.source || ''
      let currentLine = compiledLine

      if (s?.source) {
        const orig = await resolveOriginalPosition(compiledFile, s.source, compiledLine, 0)
        if (orig) {
          file = orig.source
          currentLine = orig.line
          const origSource = readOriginalSource(orig.source)
          if (origSource) source = origSource
        }
      }

      return { file, source, current_line: currentLine }
    }

    case 'set_breakpoint': {
      const id = await session.setBreakpoint(params.file, params.line, params.condition)
      return { ok: true, id, file: params.file, line: params.line, condition: params.condition || null }
    }

    case 'remove_breakpoint':
      await session.removeBreakpoint(params.id)
      return { ok: true }

    case 'breakpoints':
      return {
        breakpoints: [...session.breakpoints.entries()].map(([id, bp]) => ({
          id, file: bp.file, line: bp.line,
        })),
      }

    case 'pause':
      await session.pause()
      if (session.topFrame()) await session.getSource(session.topFrame().location.scriptId)
      return snapshot(session)

    case 'trace_start': {
      const maxBuffer = params.maxBuffer || 100
      session.startTrace(maxBuffer)
      return { ok: true, tracing: true, maxBuffer }
    }

    case 'trace_stop': {
      const hits = session.stopTrace()
      return { ok: true, tracing: false, hits, count: hits.length }
    }

    case 'trace_status':
      return {
        tracing: session.tracing,
        count: session.traceBuffer.length,
        hits: session.traceBuffer,
      }

    case 'quit':
      return { status: 'disconnected' }

    case 'workers':
      // Handled by HTTP layer (needs workerSessions context)
      return { workers: [], count: 0, _needs_context: true }

    default:
      return { error: `unknown op: ${op}` }
  }
}
