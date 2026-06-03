/**
 * Exception pause service — manages exception breakpoint filtering.
 *
 * Separate from ScriptSkipper because exception handling has its own
 * lifecycle (caught vs uncaught, stack inspection). Follows VS Code's
 * ExceptionPauseService pattern.
 *
 * @see https://github.com/nicolo-ribaudo/vscode-js-debug — exceptionPauseService.ts
 * @module
 */

import type { CDPClient } from '../cdp-client.js'
import type { IScriptEntry } from '../types.js'
import { ExceptionBreakMode } from '../types.js'
import { isFrameworkCode } from './patterns.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Manages exception breakpoint state and filtering.
 *
 * When the user enables "pause on exceptions", CDP will pause on
 * ALL exceptions, including ones inside node_modules and framework
 * code. This service filters those out.
 */
export class ExceptionPauseService {
  private mode: ExceptionBreakMode = ExceptionBreakMode.None

  constructor(
    private readonly cdp: CDPClient,
    private readonly scripts: ReadonlyMap<string, IScriptEntry>,
  ) {}

  /** Get the current exception break mode */
  getMode(): string {
    return this.mode
  }

  /**
   * Update exception breakpoint mode and apply to CDP.
   *
   * @param mode - 'none', 'uncaught', or 'all'
   */
  async setMode(mode: string): Promise<void> {
    this.mode = mode as ExceptionBreakMode
    await this.cdp.send('Debugger.setPauseOnExceptions', { state: mode })
  }

  /**
   * Determine if an exception pause should be shown to the user.
   *
   * Filters out exceptions from framework code. Unlike the old
   * implementation that only checked the top frame, this checks
   * the top frame's script URL against framework patterns.
   *
   * @param reason - CDP pause reason ('exception' or 'promiseRejection')
   * @param callFrames - Full call stack from the pause event
   * @returns `true` if we should stay paused, `false` to auto-resume
   */
  shouldPauseAt(reason: string, callFrames: any[]): boolean {
    if (this.mode === ExceptionBreakMode.None) return false
    if (reason !== 'exception' && reason !== 'promiseRejection') return false
    if (!callFrames.length) return false

    // Check the top frame — if it's framework code, skip
    const topScriptId = callFrames[0]?.location?.scriptId
    const topScript = topScriptId ? this.scripts.get(topScriptId) : null
    if (topScript && isFrameworkCode(topScript.url)) return false

    return true
  }
}
