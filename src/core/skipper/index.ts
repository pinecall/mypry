/**
 * ScriptSkipper — manages V8 blackbox patterns for stepping.
 *
 * Uses `Debugger.setBlackboxPatterns` to tell V8 to natively skip
 * framework/library code during stepping. This is much more efficient
 * than the previous manual stepOut loop approach.
 *
 * @see https://github.com/nicolo-ribaudo/vscode-js-debug — scriptSkipper/implementation.ts
 * @module
 */

import type { CDPClient } from '../cdp-client.js'
import { DEFAULT_BLACKBOX_PATTERNS, isFrameworkCode } from './patterns.js'

export { isFrameworkCode } from './patterns.js'
export { SmartStepper, shouldStepOver, StepOverReason } from './smart-stepping.js'
export { ExceptionPauseService } from './exception-pause.js'

/**
 * Manages V8 script blackboxing for a debugger session.
 *
 * After calling {@link applyBlackboxPatterns}, V8 natively skips
 * blackboxed scripts during stepping. No manual stepOut needed.
 */
export class ScriptSkipper {
  constructor(private readonly cdp: CDPClient) {}

  /**
   * Apply blackbox patterns to V8.
   *
   * Should be called once after `Debugger.enable()`.
   * V8 will natively skip matching scripts during stepping operations
   * (stepInto, stepOver). This means when you step into a function
   * that goes through node_modules, V8 auto-steps until it reaches
   * non-blackboxed code.
   */
  async applyBlackboxPatterns(): Promise<void> {
    try {
      await this.cdp.send('Debugger.setBlackboxPatterns', {
        patterns: [...DEFAULT_BLACKBOX_PATTERNS],
      })
    } catch {
      // Blackbox patterns may not be supported (older Chrome/Node versions)
      // Fail silently — SmartStepper handles this as a fallback
    }
  }

  /**
   * Check if a URL belongs to framework/library code.
   * Delegates to the pure function in patterns.ts.
   *
   * @param url - Script URL to check
   * @returns `true` if the URL is framework code
   */
  isFrameworkCode(url: string): boolean {
    return isFrameworkCode(url)
  }
}
