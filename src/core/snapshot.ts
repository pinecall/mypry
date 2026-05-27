/**
 * Snapshot + shared helpers.
 *
 * Builds the state object that all transports return to agents/clients.
 * Resolves source maps so TypeScript projects show .ts paths + line numbers.
 */

import type { DebuggerSession } from './session.js'
import { resolveOriginalPosition, readOriginalSource } from './sourcemap.js'

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
  const compiledLine = frame.location.lineNumber   // 0-based
  const compiledFile = cleanUrl(s?.url)
  const compiledSource = s?.source || ''

  // Try source map resolution: dist/foo.js → src/foo.ts
  let file = compiledFile
  let line1 = compiledLine + 1  // 1-based
  let sourceLines = compiledSource.split('\n')

  const original = await resolveOriginalPosition(compiledFile, compiledSource, line1, 0)
  if (original) {
    file = original.source
    line1 = original.line
    // Read the original .ts source for the source window
    const origSource = readOriginalSource(original.source)
    if (origSource) {
      sourceLines = origSource.split('\n')
    }
  }

  // Build source window (±4 lines around current)
  const ctx = 4
  const currentIdx = line1 - 1  // 0-based index
  const start = Math.max(0, currentIdx - ctx)
  const end = Math.min(sourceLines.length - 1, currentIdx + ctx)
  const sourceWindow: SourceWindowLine[] = []
  for (let i = start; i <= end; i++) {
    sourceWindow.push({ line: i + 1, text: sourceLines[i] ?? '', current: i === currentIdx })
  }

  return {
    status: 'paused',
    file,
    line: line1,
    function: frame.functionName || '<anon>',
    reason: session.currentPause?.reason || null,
    source_window: sourceWindow,
    locals: await session.getLocals(),
  }
}

export function emit(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n')
}
