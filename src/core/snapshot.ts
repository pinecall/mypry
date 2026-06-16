/**
 * Snapshot + shared helpers.
 *
 * Builds the state object that all transports return to agents/clients.
 * Resolves source maps so TypeScript projects show .ts paths + line numbers.
 */

import type { DebuggerSession } from './session.js'
import { resolveOriginalPosition, readOriginalSource } from './sourcemap.js'
import { isFrameworkCode } from './skipper/patterns.js'
import { DEFAULT_LIMITS, type SerializeLimits } from './serialize.js'
import { existsSync } from 'node:fs'
import { resolve as pathResolve } from 'node:path'

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
  call_stack: Array<{ function: string; file: string; line: number }>
  return_value?: unknown
  /** Full, unbounded value of an `expand` path (drill-down on demand). */
  expanded?: { path: string; value: unknown }
}

/** Options controlling how a pause snapshot is built. */
export interface SnapshotOpts {
  /** Serialization limits for locals (defaults to {@link DEFAULT_LIMITS}). */
  limits?: SerializeLimits
  /** Include framework (node_modules/internal) call-stack frames. Default: false. */
  fullStack?: boolean
  /** Evaluate this path unbounded and attach the result as `expanded`. */
  expand?: string
}

export interface RunningSnapshot {
  status: 'running'
}

export type Snapshot = PausedSnapshot | RunningSnapshot

export function cleanUrl(u: string | undefined): string {
  if (!u) return ''

  // Strip file:// protocol
  let cleaned = u.replace(/^file:\/\//, '')

  // Handle webpack-internal:// URLs from Next.js
  // e.g. webpack-internal:///(rsc)/./app/api/cart/total/route.ts
  const wpMatch = cleaned.match(/^webpack-internal:\/\/\/.*?\/\.\/(.+?)(?:\?.*)?$/)
  if (wpMatch) {
    const relPath = wpMatch[1]
    // Try to resolve to an absolute path on disk
    const cwd = process.cwd()
    const candidates = [cwd]
    let dir = cwd
    for (let i = 0; i < 5; i++) {
      dir = pathResolve(dir, '..')
      candidates.push(dir)
    }
    for (const root of candidates) {
      const candidate = pathResolve(root, relPath)
      if (existsSync(candidate)) return candidate
    }
    // Couldn't resolve — return the relative path (still better than the URL)
    return relPath
  }

  // Handle Vite dev server URLs: http://localhost:PORT/src/... → /PROJECT_ROOT/src/...
  // These appear when debugging Chrome with Vite running
  const viteMatch = cleaned.match(/^https?:\/\/localhost:\d+\/(.+)/)
  if (viteMatch) {
    // Strip query params (?t=timestamp from HMR, ?v=hash from deps)
    cleaned = viteMatch[1].replace(/\?.*$/, '')

    // For source files (src/..., not node_modules), try to resolve to filesystem
    // The Vite root is the cwd of the server
    if (!cleaned.startsWith('/')) {
      // Try candidate roots — check if the file exists on disk
      // Vite serves files relative to its project root
      const candidates = [
        process.cwd(),
        process.env.VITE_ROOT || '',
        // Common patterns: search parent dirs for the file
      ]

      // Also try to find the file by walking up from cwd
      let dir = process.cwd()
      for (let i = 0; i < 5; i++) {
        candidates.push(dir)
        dir = pathResolve(dir, '..')
      }

      for (const root of candidates) {
        if (!root) continue
        const candidate = pathResolve(root, cleaned)
        if (existsSync(candidate)) return candidate
      }
    }
  }

  return cleaned
}

export function formatValue(v: unknown): string {
  if (v === undefined) return 'undefined'
  if (v === null) return 'null'
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'object') { try { return JSON.stringify(v) } catch { return String(v) } }
  return String(v)
}

export async function snapshot(session: DebuggerSession, opts: SnapshotOpts = {}): Promise<Snapshot> {
  const limits = opts.limits ?? DEFAULT_LIMITS
  const frame = session.topFrame()
  if (!frame) return { status: 'running' }
  const scriptId = frame.location.scriptId
  const s = await session.getSource(scriptId)
  const compiledLine = frame.location.lineNumber   // 0-based
  const rawUrl = s?.url || ''
  const compiledSource = s?.source || ''

  // Try source map resolution using the RAW URL (needs protocol info for webpack-internal detection)
  let file = cleanUrl(rawUrl)
  let line1 = compiledLine + 1  // 1-based
  let sourceLines = compiledSource.split('\n')

  const original = await resolveOriginalPosition(rawUrl, compiledSource, line1, 0)
  if (original) {
    file = original.source
    line1 = original.line
    // Read the original .ts source for the source window
    // Priority: disk file → source map's embedded sourcesContent
    const origSource = readOriginalSource(original.source) || original.sourceContent
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

  // Build call stack. Default: justMyCode — keep the top frame (where we're
  // paused) plus any non-framework frames; drop node_modules/internal noise.
  // `fullStack:true` opts back into the raw chain.
  const callStack: Array<{ function: string; file: string; line: number }> = []
  const allFrames = session.currentPause?.callFrames || []
  for (let i = 0; i < Math.min(allFrames.length, 12); i++) {
    const f = allFrames[i]
    const fScript = session.scripts.get(f.location.scriptId)
    const rawUrl = fScript?.url || ''
    if (!opts.fullStack && i !== 0 && isFrameworkCode(rawUrl)) continue
    callStack.push({
      function: f.functionName || '<anon>',
      file: cleanUrl(rawUrl),
      line: f.location.lineNumber + 1,
    })
  }

  const result: PausedSnapshot = {
    status: 'paused',
    file,
    line: line1,
    function: frame.functionName || '<anon>',
    reason: session.currentPause?.reason || null,
    source_window: sourceWindow,
    locals: await session.getLocals(limits),
    call_stack: callStack,
  }

  // Drill-down: expand one path unbounded (the agent asked for it explicitly).
  if (opts.expand) {
    try {
      const er = await session.evalInFrame(opts.expand) as any
      const value = er?.result?.value !== undefined ? er.result.value : (er?.result?.description ?? null)
      result.expanded = { path: opts.expand, value }
    } catch (e: any) {
      result.expanded = { path: opts.expand, value: `[expand error] ${e?.message ?? e}` }
    }
  }

  // Include return value if available (after step-over of a function call)
  if (frame.returnValue && frame.returnValue.type !== 'undefined') {
    try {
      const rv = frame.returnValue
      if (rv.value !== undefined) {
        result.return_value = rv.value
      } else if (rv.description) {
        result.return_value = rv.description
      }
    } catch { /* ignore */ }
  }

  return result
}
