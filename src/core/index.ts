/**
 * Core re-exports for programmatic use:
 *   import { CDPClient, DebuggerSession, snapshot, discoverTargets, executeOp } from 'mypry/core'
 */

export { CDPClient } from './cdp-client.js'
export { DebuggerSession } from './session.js'
export { snapshot, cleanUrl, formatValue, emit } from './snapshot.js'
export type { Snapshot, PausedSnapshot, RunningSnapshot, SourceWindowLine } from './snapshot.js'
export { discoverTargets, matchTarget } from './targets.js'
export { executeOp } from './ops.js'
