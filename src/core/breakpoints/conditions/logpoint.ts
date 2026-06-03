/**
 * Logpoint — evaluates console.log() and continues execution.
 *
 * The CDP condition ends with `, false` which tells Chrome to
 * never actually pause on this breakpoint. The log output appears
 * in the debug console.
 *
 * Supports `{expression}` interpolation in the message template.
 *
 * @see https://github.com/nicolo-ribaudo/vscode-js-debug — conditions/logPoint.ts
 */

import type { IBreakpointCondition } from './index.js'

/**
 * A logpoint condition that logs a message and continues execution.
 * The trailing `, false` in the CDP condition means Chrome never pauses.
 */
export class LogpointCondition implements IBreakpointCondition {
  /** CDP condition — logs and returns false (never pauses) */
  public readonly breakCondition: string

  private constructor(cdpCondition: string) {
    this.breakCondition = cdpCondition
  }

  /** Logpoints never stay paused — they just log */
  shouldStayPaused(): boolean {
    return false
  }

  /**
   * Compile a log message into a CDP condition.
   *
   * Supports `{expression}` interpolation syntax:
   * ```
   * "user={user.email} count={items.length}"
   * → console.log(`[logpoint] user=${user.email} count=${items.length}`), false
   * ```
   *
   * @param message - Log message template with optional `{expr}` interpolations
   * @returns A {@link LogpointCondition} that logs and continues
   */
  static compile(message: string): LogpointCondition {
    // Convert {expr} interpolation to template literal syntax
    const template = message.replace(/\{([^}]+)\}/g, '${$1}')
    // Escape backticks in the message
    const escaped = template.replace(/`/g, '\\`')
    const condition = `(console.log(\`[logpoint] ${escaped}\`), false)`
    return new LogpointCondition(condition)
  }
}
