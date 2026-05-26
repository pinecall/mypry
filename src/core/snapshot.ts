/**
 * Snapshot + shared helpers.
 *
 * Mechanical translation from mypry.js lines 219, 246-252, 509-534.
 * DO NOT change behavior — this is load-bearing.
 */

import type { DebuggerSession } from './session.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface SourceWindowLine {
  line: number
  text: string
  current: boolean
}

export interface PausedSnapshot {
  status: 'paused'
  file: string
  line: number
  function: string
  reason: string | null
  source_window: SourceWindowLine[]
  locals: Record<string, unknown>
}

export interface RunningSnapshot {
  status: 'running'
}

export type Snapshot = PausedSnapshot | RunningSnapshot

export function cleanUrl(u: string | undefined): string {
  return (u || '').replace(/^file:\/\//, '')
}

export function formatValue(v: unknown): string {
  if (v === undefined) return 'undefined'
  if (v === null) return 'null'
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'object') { try { return JSON.stringify(v) } catch { return String(v) } }
  return String(v)
}

export async function snapshot(session: DebuggerSession): Promise<Snapshot> {
  const frame = session.topFrame()
  if (!frame) return { status: 'running' }
  const scriptId = frame.location.scriptId
  const s = await session.getSource(scriptId)
  const line = frame.location.lineNumber
  const lines = (s?.source || '').split('\n')
  const ctx = 4
  const start = Math.max(0, line - ctx)
  const end = Math.min(lines.length - 1, line + ctx)
  const sourceWindow: SourceWindowLine[] = []
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

export function emit(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n')
}
