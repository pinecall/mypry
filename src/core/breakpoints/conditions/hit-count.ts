/**
 * Hit count breakpoint — pauses on the Nth hit.
 *
 * Unlike the previous CDP-based counting (globalThis.__mypry_hit_xxx),
 * this counts server-side so it works reliably across HMR reloads.
 *
 * Supports: `= N`, `> N`, `>= N`, `< N`, `<= N`, `% N` (modulo).
 * Also accepts bare numbers: `5` is treated as `= 5`.
 *
 * @see https://github.com/nicolo-ribaudo/vscode-js-debug — conditions/hitCount.ts
 */

import type { IBreakpointCondition } from './index.js'

/**
 * Regex to match hit condition expressions.
 * Captures: operator (group 1, optional) and constant (group 2).
 */
const hitConditionRe = /^(>|>=|={1,3}|<|<=|%)?\s*([0-9]+)$/

/**
 * A hit count breakpoint. Counts pause events server-side and applies
 * a predicate to decide whether to stay paused.
 *
 * This is more reliable than CDP condition-based counting because:
 * 1. It survives HMR/hot-reload (counters don't leak into globalThis)
 * 2. It handles `%` (modulo) which CDP conditions can't express simply
 */
export class HitCondition implements IBreakpointCondition {
  /**
   * No CDP condition — we always pause and check server-side.
   * This means CDP pauses every time, but we auto-resume if predicate fails.
   */
  public readonly breakCondition = undefined

  private hits = 0

  private constructor(private readonly predicate: (n: number) => boolean) {}

  /**
   * Check if we should stay paused on this hit.
   * Increments the counter and applies the predicate.
   */
  shouldStayPaused(): boolean {
    return this.predicate(++this.hits)
  }

  /**
   * Parse a hit condition expression like `> 5` or `% 3`.
   *
   * @param expression - Hit condition string (e.g. "> 42", "% 10", "5")
   * @returns A {@link HitCondition} with the appropriate predicate
   * @throws {Error} if the expression format is invalid
   */
  static parse(expression: string): HitCondition {
    const parts = hitConditionRe.exec(expression.trim())
    if (!parts) {
      throw new Error(
        `Invalid hit condition: "${expression}". ` +
        `Expected format: [operator] number (e.g. "> 5", "% 3", "= 10")`,
      )
    }

    const [, op = '=', valueStr] = parts
    const value = Number(valueStr)
    return new HitCondition(makePredicate(op, value))
  }
}

/**
 * Creates a predicate function from an operator and value.
 * @internal
 */
function makePredicate(op: string, value: number): (n: number) => boolean {
  switch (op) {
    case '=':
    case '==':
    case '===': return n => n === value
    case '>':   return n => n > value
    case '>=':  return n => n >= value
    case '<':   return n => n < value
    case '<=':  return n => n <= value
    case '%':   return n => n % value === 0
    default:    throw new Error(`Unknown hit condition operator: "${op}"`)
  }
}
