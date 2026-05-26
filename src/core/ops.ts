/**
 * Shared op dispatch — used by both ndjson.ts and http.ts.
 *
 * Centralizes the Aurora protocol implementation so both transports
 * behave identically for the same ops.
 */

import type { DebuggerSession } from './session.js'
import { snapshot, cleanUrl } from './snapshot.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

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
      const result = await Promise.race([
        session.waitNextPause().then(() => 'paused'),
        new Promise<string>((r) => session.cdp.onClose(() => r('terminated'))),
      ])
      if (result === 'terminated') return { status: 'terminated' }
      if (session.topFrame()) await session.getSource(session.topFrame().location.scriptId)
      return snapshot(session)
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
      const frames = (session.currentPause?.callFrames || []).map((f: any) => ({
        function: f.functionName || '<anon>',
        file: cleanUrl(session.scripts.get(f.location.scriptId)?.url),
        line: f.location.lineNumber + 1,
      }))
      return { frames }
    }

    case 'source': {
      const f = session.topFrame()
      if (!f) return { error: 'not paused' }
      const s = await session.getSource(f.location.scriptId)
      return {
        file: cleanUrl(s?.url),
        source: s?.source || '',
        current_line: f.location.lineNumber + 1,
      }
    }

    case 'set_breakpoint': {
      const id = await session.setBreakpoint(params.file, params.line)
      return { ok: true, id, file: params.file, line: params.line }
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

    case 'quit':
      return { status: 'disconnected' }

    default:
      return { error: `unknown op: ${op}` }
  }
}
