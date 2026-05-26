/**
 * Browser-side inline trigger.
 *
 * For frontend code. If a debugger is attached (DevTools, Chrome with
 * --remote-debugging-port, or mypry-attached Chrome), execution pauses.
 * Otherwise this is a no-op.
 *
 * Usage:
 *   import { pry } from 'mypry/browser'
 *   pry()
 *   pry({ message: 'before render' })
 */

export interface BrowserPryOptions {
  message?: string
}

export function pry(opts: BrowserPryOptions = {}): void {
  if (opts.message) console.log(`[mypry] ${opts.message}`)
  // eslint-disable-next-line no-debugger
  debugger
}

export default pry
