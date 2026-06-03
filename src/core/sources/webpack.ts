/**
 * webpack-internal:// script finder.
 *
 * Next.js (webpack mode) compiles routes into scripts whose URL contains
 * the original file path after "webpack-internal://".
 * Example: `webpack-internal:///(rsc)/./app/api/cart/total/route.ts`
 *
 * @module
 */

import type { IScriptEntry, IScriptMatch } from '../types.js'

/**
 * Find a webpack-internal script matching a file pattern.
 *
 * Handles URL-encoded paths and prefers the highest scriptId
 * (most recent after HMR).
 *
 * @param scripts - Map of scriptId → IScriptEntry from CDP
 * @param filePattern - User's file pattern (e.g. "app/api/cart/total/route.ts")
 * @param basename - Just the filename (e.g. "route.ts")
 * @returns Match with scriptId + entry, or null
 */
export function findWebpackScript(
  scripts: ReadonlyMap<string, IScriptEntry>,
  filePattern: string,
  basename: string,
): IScriptMatch | null {
  let best: IScriptMatch | null = null
  let bestId = -1

  for (const [scriptId, entry] of scripts) {
    if (!entry.url || !entry.url.includes('webpack-internal://')) continue
    if (!entry.sourceMapURL) continue

    try {
      const decoded = decodeURIComponent(entry.url)
      const idNum = parseInt(scriptId, 10) || 0

      // Full filePattern match is highest priority
      if (decoded.includes('/' + filePattern) && idNum > bestId) {
        bestId = idNum
        best = { scriptId, entry }
      } else if (decoded.includes('/' + basename) && !best) {
        best = { scriptId, entry }
      }
    } catch { /* bad URL encoding */ }
  }

  return best
}
