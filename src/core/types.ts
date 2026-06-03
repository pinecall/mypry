/**
 * Shared type definitions for the mypry debugger core.
 *
 * All interfaces use `I` prefix (VS Code convention).
 * All enums use `const enum` for zero-cost at runtime.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── Script & Source ──────────────────────────────────────────────────

/** Script entry cached from Debugger.scriptParsed */
export interface IScriptEntry {
  readonly url: string
  source: string | null
  readonly sourceMapURL?: string
}

// ── Breakpoints ──────────────────────────────────────────────────────

/** The kind of breakpoint set by the user */
export const enum BreakpointKind {
  Standard = 'breakpoint',
  Logpoint = 'logpoint',
  HitCount = 'hitcount',
}

/** A user-facing breakpoint record */
export interface IBreakpointEntry {
  readonly id: number
  readonly file: string
  readonly line: number               // 1-based (user-facing)
  readonly cdpId: string
  readonly condition?: string
  readonly kind: BreakpointKind
}

/**
 * Result from the breakpoint resolver — tells the manager
 * which CDP method to use and with what parameters.
 */
export interface IResolvedLocation {
  readonly scriptId?: string
  readonly lineNumber: number          // 0-based (CDP)
  readonly columnNumber?: number
  readonly method: 'byUrl' | 'byScriptId' | 'byUrlRegex'
  readonly urlRegex?: string
}

/** Match result from script-matcher */
export interface IScriptMatch {
  readonly scriptId: string
  readonly entry: IScriptEntry
}

// ── Exception Handling ───────────────────────────────────────────────

/** Exception breakpoint modes */
export const enum ExceptionBreakMode {
  None = 'none',
  Uncaught = 'uncaught',
  All = 'all',
}
