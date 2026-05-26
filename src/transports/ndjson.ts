/**
 * ndjson transport — newline-delimited JSON over stdio.
 *
 * ⚠️  AURORA USES THIS TRANSPORT. DO NOT CHANGE BEHAVIOR.
 *
 * Mechanical translation from mypry.js lines 405-534.
 * Every response shape is part of the Aurora contract (Section 5.2).
 */

import readline from 'node:readline'
import type { DebuggerSession } from '../core/session.js'
import { snapshot, cleanUrl, emit } from '../core/snapshot.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function runNdjson(session: DebuggerSession): Promise<void> {
  // If already paused (pry() or --inspect-brk), emit state immediately
  if (session.currentPause) {
    await session._skipPryFrames()
    if (session.topFrame()) await session.getSource(session.topFrame().location.scriptId)
    emit(await snapshot(session))
  } else {
    emit({ status: 'running' })
  }

  session.cdp.onClose(() => { emit({ status: 'terminated' }); process.exit(0) })

  const rl = readline.createInterface({ input: process.stdin })
  for await (const raw of rl) {
    let req: any
    try { req = JSON.parse(raw) }
    catch (e: any) { emit({ error: `invalid json: ${e.message}` }); continue }

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
            new Promise<string>((r) => session.cdp.onClose(() => r('terminated'))),
          ])
          if (result === 'terminated') { emit({ status: 'terminated' }); return }
          await session.getSource(session.topFrame().location.scriptId)
          emit(await snapshot(session))
          break
        }
        case 'eval': {
          const r = await session.evalInFrame(req.expr || '') as any
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
          const frames = (session.currentPause?.callFrames || []).map((f: any) => ({
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
        case 'set_breakpoint': {
          const id = await session.setBreakpoint(req.file, req.line)
          emit({ ok: true, id, file: req.file, line: req.line })
          break
        }
        case 'remove_breakpoint':
          await session.removeBreakpoint(req.id)
          emit({ ok: true }); break
        case 'breakpoints':
          emit({ breakpoints: [...session.breakpoints.entries()].map(([id, bp]) => ({ id, file: bp.file, line: bp.line })) }); break
        case 'pause':
          await session.pause()
          if (session.topFrame()) await session.getSource(session.topFrame().location.scriptId)
          emit(await snapshot(session)); break
        case 'quit':
          emit({ status: 'disconnected' }); return
        default:
          emit({ error: `unknown op: ${op}` })
      }
    } catch (e: any) {
      emit({ error: e.message })
    }
  }
}
