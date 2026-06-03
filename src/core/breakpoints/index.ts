/**
 * BreakpointManager — owns breakpoint lifecycle and CDP communication.
 *
 * Thin coordinator: uses {@link BreakpointResolver} for resolution
 * and {@link getConditionFor} for condition processing.
 *
 * @see https://github.com/nicolo-ribaudo/vscode-js-debug — breakpoints.ts
 * @module
 */

import type { CDPClient } from '../cdp-client.js'
import type { IScriptEntry, IBreakpointEntry } from '../types.js'
import { BreakpointKind } from '../types.js'
import { BreakpointResolver } from './resolver.js'
import {
  getConditionFor,
  type IBreakpointCondition,
  type IBreakpointConditionParams,
} from './conditions/index.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Internal breakpoint record — extends user-facing entry with
 * the condition object for server-side hit counting.
 */
interface BreakpointRecord extends IBreakpointEntry {
  readonly conditionObj: IBreakpointCondition
}

/**
 * Manages the lifecycle of breakpoints: set, remove, list.
 *
 * Delegates resolution to {@link BreakpointResolver} and condition
 * processing to the conditions/ module. Owns the Map of active breakpoints.
 */
export class BreakpointManager {
  private readonly entries = new Map<number, BreakpointRecord>()
  private nextId = 0
  private readonly resolver: BreakpointResolver

  constructor(
    private readonly cdp: CDPClient,
    private readonly scripts: ReadonlyMap<string, IScriptEntry>,
  ) {
    this.resolver = new BreakpointResolver(scripts, cdp)
  }

  /**
   * Set a breakpoint at the given file and line.
   *
   * @param file - File path or pattern (e.g. "route.ts", "app/api/cart/total/route.ts")
   * @param line - 1-based line number
   * @param params - Optional condition, logMessage, or hitCount
   * @returns Breakpoint ID (mypry-internal, not CDP)
   */
  async set(
    file: string,
    line: number,
    params: IBreakpointConditionParams = {},
  ): Promise<number> {
    const line0 = line - 1 // CDP is 0-based
    const conditionObj = getConditionFor(params)
    const resolved = await this.resolver.resolve(file, line0)

    // Determine kind for display
    const kind = params.logMessage
      ? BreakpointKind.Logpoint
      : params.hitCount
        ? BreakpointKind.HitCount
        : BreakpointKind.Standard

    // Build CDP params
    let cdpId: string

    if (resolved.method === 'byScriptId' && resolved.scriptId) {
      const cdpParams: Record<string, unknown> = {
        location: { scriptId: resolved.scriptId, lineNumber: resolved.lineNumber },
      }
      if (conditionObj.breakCondition) cdpParams.condition = conditionObj.breakCondition
      const r = await this.cdp.send('Debugger.setBreakpoint', cdpParams) as any
      cdpId = r.breakpointId
    } else {
      // byUrl or byUrlRegex — use setBreakpointByUrl for HMR resilience
      const cdpParams: Record<string, unknown> = {
        lineNumber: resolved.lineNumber,
        urlRegex: resolved.urlRegex,
      }
      if (conditionObj.breakCondition) cdpParams.condition = conditionObj.breakCondition
      const r = await this.cdp.send('Debugger.setBreakpointByUrl', cdpParams) as any

      // Check if urlRegex bound to any location
      if (!r.locations?.length && resolved.method !== 'byUrlRegex') {
        // BP registered but didn't bind — try scriptId fallback if available
        if (resolved.scriptId) {
          await this.cdp.send('Debugger.removeBreakpoint', { breakpointId: r.breakpointId }).catch(() => {})
          const fallbackParams: Record<string, unknown> = {
            location: { scriptId: resolved.scriptId, lineNumber: resolved.lineNumber },
          }
          if (conditionObj.breakCondition) fallbackParams.condition = conditionObj.breakCondition
          const fr = await this.cdp.send('Debugger.setBreakpoint', fallbackParams) as any
          cdpId = fr.breakpointId
        } else {
          // Pure urlRegex — no fallback possible
          cdpId = r.breakpointId
        }
      } else if (!r.locations?.length && resolved.method === 'byUrlRegex') {
        // urlRegex fallback didn't bind — file doesn't exist
        const scriptCount = this.scripts.size
        throw new Error(
          `No script matching "${file}" found (searched ${scriptCount} loaded scripts). ` +
          `The file may not have been loaded yet — trigger a request to the route/endpoint first, ` +
          `then retry set_breakpoint. If using Next.js, make sure to connect to the router ` +
          `server port (usually inspector port + 1).`,
        )
      } else {
        cdpId = r.breakpointId
      }
    }

    // For urlRegex fallback: check if it bound at all
    if (!cdpId) {
      const scriptCount = this.scripts.size
      throw new Error(
        `No script matching "${file}" found (searched ${scriptCount} loaded scripts). ` +
        `The file may not have been loaded yet — trigger a request to the route/endpoint first, ` +
        `then retry set_breakpoint. If using Next.js, make sure to connect to the router ` +
        `server port (usually inspector port + 1).`,
      )
    }

    const id = ++this.nextId
    this.entries.set(id, {
      id,
      file,
      line,
      cdpId,
      condition: params.condition || params.logMessage || params.hitCount,
      kind,
      conditionObj,
    })
    return id
  }

  /**
   * Remove a breakpoint by its mypry ID.
   * @throws {Error} if no breakpoint with that ID exists
   */
  async remove(id: number): Promise<void> {
    const bp = this.entries.get(id)
    if (!bp) throw new Error(`no breakpoint #${id}`)
    await this.cdp.send('Debugger.removeBreakpoint', { breakpointId: bp.cdpId })
    this.entries.delete(id)
  }

  /** Remove all breakpoints. */
  async removeAll(): Promise<void> {
    for (const [, bp] of this.entries) {
      try {
        await this.cdp.send('Debugger.removeBreakpoint', { breakpointId: bp.cdpId })
      } catch { /* ignore */ }
    }
    this.entries.clear()
  }

  /**
   * List all active breakpoints.
   * @returns Array of user-facing breakpoint entries
   */
  list(): IBreakpointEntry[] {
    return [...this.entries.values()].map(({ conditionObj: _, ...entry }) => entry)
  }

  /**
   * Check if a hit-count breakpoint should stay paused.
   *
   * Called by session after CDP pauses on a breakpoint.
   * Returns `false` if the breakpoint's server-side condition
   * (e.g. hit count) says to auto-resume.
   *
   * @param cdpBreakpointId - CDP breakpoint ID from the pause event
   * @returns `true` to stay paused, `false` to auto-resume
   */
  shouldStayPaused(cdpBreakpointId: string): boolean {
    for (const bp of this.entries.values()) {
      if (bp.cdpId === cdpBreakpointId) {
        return bp.conditionObj.shouldStayPaused()
      }
    }
    // Unknown breakpoint (e.g. debugger statement) — always pause
    return true
  }

  /** Get the raw entries map (for backward compatibility with toolkit) */
  get entriesMap(): ReadonlyMap<number, IBreakpointEntry> {
    return this.entries
  }
}
