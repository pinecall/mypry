/**
 * Core re-exports for programmatic use:
 *   import { CDPClient, DebuggerSession, snapshot, discoverTargets } from 'mypry/core'
 */

export { CDPClient } from './cdp-client.js'
export { DebuggerSession } from './session.js'
export { snapshot, cleanUrl, formatValue } from './snapshot.js'
export type { Snapshot, PausedSnapshot, RunningSnapshot, SourceWindowLine } from './snapshot.js'
export { discoverTargets } from './targets.js'
