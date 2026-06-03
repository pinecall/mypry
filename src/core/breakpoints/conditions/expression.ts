/**
 * Conditional breakpoint using a user-defined expression.
 *
 * Wraps the user expression in try/catch for safe CDP evaluation.
 * Identical to VS Code's approach — prevents debugger crash on bad conditions.
 *
 * @see https://github.com/nicolo-ribaudo/vscode-js-debug — conditions/expression.ts
 */

import type { IBreakpointCondition } from './index.js'

/**
 * Wraps a raw condition expression for safe CDP evaluation.
 *
 * The wrapper catches syntax/runtime errors in the condition itself,
 * logs them to console, and returns `false` (don't pause).
 * This prevents the debugger from crashing on malformed expressions.
 *
 * @example
 * ```ts
 * wrapCondition('user.name === "admin"')
 * // → '(()=>{try{return !!(user.name === "admin");}catch(e){...;return false}})()'
 * ```
 */
export const wrapCondition = (expr: string): string =>
  `(()=>{try{return !!(${expr});}catch(e){` +
  `console.error('Breakpoint condition error: '+(e.message||e));return false}})()`

/**
 * A conditional breakpoint that evaluates a user expression in CDP.
 * The expression is wrapped in try/catch so bad conditions don't crash the debugger.
 */
export class ExpressionCondition implements IBreakpointCondition {
  /** CDP condition — wrapped in try/catch for safety */
  public readonly breakCondition: string

  private constructor(expr: string) {
    this.breakCondition = wrapCondition(expr)
  }

  /** Logpoint/hit-count filtering is done in CDP, so always stay paused */
  shouldStayPaused(): boolean {
    return true
  }

  /**
   * Parse a user condition string into a safe CDP expression.
   *
   * @param expression - Raw JS expression from the user (e.g. `user.name === "admin"`)
   * @returns An {@link ExpressionCondition} with the expression wrapped for safety
   */
  static parse(expression: string): ExpressionCondition {
    return new ExpressionCondition(expression)
  }
}
