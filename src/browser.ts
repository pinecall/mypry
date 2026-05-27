/**
 * Browser-side inline trigger.
 *
 * Drops a `debugger` statement. When Chrome is launched with
 * --remote-debugging-port, mypry can attach via CDP and provide
 * the full debugging experience (source, step, eval, locals).
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
