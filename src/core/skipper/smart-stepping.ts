/**
 * SmartStepper — auto-steps through framework code during stepInto.
 *
 * When the user steps into a function and lands in node_modules
 * or framework code, this class automatically determines that we
 * should step out. Has a backout threshold to prevent infinite stepping.
 *
 * @see https://github.com/nicolo-ribaudo/vscode-js-debug — smartStepping.ts
 * @module
 */

import { isFrameworkCode } from './patterns.js'

// ── Types ────────────────────────────────────────────────────────────

/** Why we want to step over a call frame */
export const enum StepOverReason {
  /** Don't step — this is user code */
  None,
  /** Step — this is framework/library code */
  FrameworkCode,
}

// ── Pure function ────────────────────────────────────────────────────

/**
 * Check if a single call frame should be stepped over.
 * Pure function — no side effects.
 *
 * @param url - Script URL of the call frame
 * @returns Reason for stepping over, or `None` if it's user code
 */
export function shouldStepOver(url: string): StepOverReason {
  if (isFrameworkCode(url)) return StepOverReason.FrameworkCode
  return StepOverReason.None
}

// ── SmartStepper class ───────────────────────────────────────────────

/**
 * Backout threshold — after this many consecutive auto-steps,
 * give up and step out. Prevents infinite stepping through
 * deeply nested framework code.
 *
 * VS Code uses 256. We use 10 since we have a simpler model.
 */
const BACKOUT_THRESHOLD = 10

/**
 * SmartStepper tracks consecutive auto-step operations and provides
 * the step direction needed to get back to user code.
 *
 * Usage:
 * ```ts
 * const stepper = new SmartStepper()
 * // After each stepInto:
 * const dir = stepper.getStepDirection(topFrameUrl)
 * if (dir) await session.cdp.send('Debugger.stepOut')
 * ```
 */
export class SmartStepper {
  private stepCount = 0

  /** Reset the step counter. Call on resume or breakpoint hit. */
  reset(): void {
    this.stepCount = 0
  }

  /**
   * Determine if the current frame should be auto-stepped through.
   *
   * @param url - Script URL of the top call frame
   * @returns `'out'` to step out, or `undefined` to stay paused (user code)
   */
  getStepDirection(url: string): 'out' | undefined {
    const reason = shouldStepOver(url)
    if (reason === StepOverReason.None) {
      this.reset()
      return undefined
    }

    if (++this.stepCount > BACKOUT_THRESHOLD) {
      this.reset()
      return 'out' // give up — we're stuck in framework code
    }

    return 'out'
  }
}
