/**
 * Breakpoint condition system — determines when a breakpoint should pause.
 *
 * Follows VS Code's pattern: an interface + factory function that picks
 * the right implementation based on breakpoint parameters.
 *
 * @see https://github.com/nicolo-ribaudo/vscode-js-debug — breakpoints/conditions/index.ts
 */

import { ExpressionCondition } from './expression.js'
import { HitCondition } from './hit-count.js'
import { LogpointCondition } from './logpoint.js'

// ── Interface ────────────────────────────────────────────────────────

/**
 * A condition that controls when a breakpoint should pause execution.
 *
 * Two-phase evaluation:
 * 1. `breakCondition` is sent to CDP — Chrome evaluates it on every hit.
 *    If it returns falsy, Chrome auto-continues (never pauses).
 * 2. `shouldStayPaused()` is called server-side after Chrome pauses.
 *    Used by {@link HitCondition} to count hits without CDP globals.
 */
export interface IBreakpointCondition {
  /**
   * CDP condition expression, or `undefined` to always pause in CDP.
   * Sent as the `condition` parameter to `Debugger.setBreakpoint`.
   */
  readonly breakCondition: string | undefined

  /**
   * Server-side check after CDP pauses. Return `false` to auto-resume.
   * Used by hit-count breakpoints to count hits without CDP globals.
   */
  shouldStayPaused(): boolean
}

// ── Constants ────────────────────────────────────────────────────────

/** Condition that always pauses (standard breakpoint) */
export const AlwaysBreak: IBreakpointCondition = {
  breakCondition: undefined,
  shouldStayPaused: () => true,
}

/** Condition that never pauses (internal use) */
export const NeverBreak: IBreakpointCondition = {
  breakCondition: 'false',
  shouldStayPaused: () => false,
}

// ── Factory ──────────────────────────────────────────────────────────

/**
 * Parameters for creating a breakpoint condition.
 * At most one of these should be set.
 */
export interface IBreakpointConditionParams {
  /** JS expression — only pause when truthy */
  condition?: string
  /** Log message instead of pausing (logpoint) */
  logMessage?: string
  /** Hit condition expression (e.g. "> 5", "% 3") */
  hitCount?: string
}

/**
 * Factory: determines which condition type to use
 * based on breakpoint parameters.
 *
 * Priority order (matches VS Code):
 * 1. condition → {@link ExpressionCondition} (wrapped in try/catch)
 * 2. logMessage → {@link LogpointCondition} (logs and continues)
 * 3. hitCount → {@link HitCondition} (server-side counting)
 * 4. none → {@link AlwaysBreak}
 */
export function getConditionFor(params: IBreakpointConditionParams): IBreakpointCondition {
  if (params.condition) return ExpressionCondition.parse(params.condition)
  if (params.logMessage) return LogpointCondition.compile(params.logMessage)
  if (params.hitCount)   return HitCondition.parse(params.hitCount)
  return AlwaysBreak
}

// ── Re-exports ───────────────────────────────────────────────────────

export { ExpressionCondition, wrapCondition } from './expression.js'
export { HitCondition } from './hit-count.js'
export { LogpointCondition } from './logpoint.js'
