/**
 * Core re-exports for programmatic use:
 *   import { CDPClient, DebuggerSession, snapshot } from 'mypry/core'
 */

export { CDPClient } from './cdp-client.js'
export { DebuggerSession } from './session.js'
export { snapshot, cleanUrl, formatValue, emit } from './snapshot.js'
export type { Snapshot, PausedSnapshot, RunningSnapshot, SourceWindowLine } from './snapshot.js'
