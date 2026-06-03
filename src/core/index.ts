/**
 * Core re-exports for programmatic use:
 *   import { CDPClient, DebuggerSession, snapshot, discoverTargets } from 'mypry/core'
 */

// Foundation
export { CDPClient } from './cdp-client.js'
export { DebuggerSession } from './session.js'
export { discoverTargets } from './targets.js'

// Types
export type { IScriptEntry, IBreakpointEntry, IResolvedLocation, IScriptMatch } from './types.js'
export { BreakpointKind, ExceptionBreakMode } from './types.js'

// Snapshot
export { snapshot, cleanUrl, formatValue } from './snapshot.js'
export type { Snapshot, PausedSnapshot, RunningSnapshot, SourceWindowLine } from './snapshot.js'

// Source maps
export { resolveOriginalPosition, readOriginalSource } from './sources/index.js'
export type { OriginalPosition } from './sources/index.js'

// Breakpoints
export { BreakpointManager } from './breakpoints/index.js'
export { getConditionFor } from './breakpoints/conditions/index.js'
export type { IBreakpointCondition } from './breakpoints/conditions/index.js'

// Skipper
export { ScriptSkipper, SmartStepper, ExceptionPauseService } from './skipper/index.js'
