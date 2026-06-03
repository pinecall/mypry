/**
 * Script URL matching — finds the best script for a given file pattern.
 *
 * Priority order:
 * 1. Full path match (highest scriptId wins — most recent after HMR)
 * 2. webpack-internal:// match (decoded URL contains file path)
 * 3. Basename-only match (lower priority)
 *
 * @module
 */

import type { IScriptEntry, IScriptMatch } from '../types.js'

/**
 * Find the best matching script for a file pattern.
 *
 * Scans all loaded scripts and returns the best match based on priority.
 * For scripts with the same match type, prefers the highest scriptId
 * (most recent after HMR/hot-reload).
 *
 * @param scripts - Map of scriptId → IScriptEntry from CDP
 * @param filePattern - User's file pattern (e.g. "app/api/cart/total/route.ts")
 * @param basename - Just the filename (e.g. "route.ts")
 * @returns Best match, or null if no script matches
 */
export function matchScript(
  scripts: ReadonlyMap<string, IScriptEntry>,
  filePattern: string,
  basename: string,
): IScriptMatch | null {
  let bestMatch: IScriptMatch | null = null
  let bestMatchId = -1
  let basenameMatch: IScriptMatch | null = null

  for (const [scriptId, entry] of scripts) {
    if (!entry.url) continue

    const urlPath = entry.url.replace(/\?.*$/, '') // strip query params (Vite ?t=xxx)
    const urlBasename = urlPath.replace(/^.*[/\\]/, '')
    const idNum = parseInt(scriptId, 10) || 0

    // Full path match — prefer highest scriptId (most recent after HMR)
    if (urlPath.endsWith('/' + filePattern) && idNum > bestMatchId) {
      bestMatchId = idNum
      bestMatch = { scriptId, entry }
    }

    // Basename-only match (lower priority — keep scanning for full path)
    if (urlBasename === basename && !basenameMatch) {
      basenameMatch = { scriptId, entry }
    }

    // webpack-internal: Next.js compiles routes into scripts whose URL contains
    // the original file path after "webpack:/" or directly as the module path.
    // Example: webpack-internal:///(rsc)/./app/api/cart/total/route.ts
    if (entry.url.includes('webpack-internal://')) {
      try {
        const decoded = decodeURIComponent(entry.url)
        // Full filePattern match is highest priority
        if (decoded.includes('/' + filePattern) && idNum > bestMatchId) {
          bestMatchId = idNum
          bestMatch = { scriptId, entry }
        } else if (decoded.includes('/' + basename) && !basenameMatch) {
          basenameMatch = { scriptId, entry }
        }
      } catch { /* bad URL encoding */ }
    }
  }

  return bestMatch || basenameMatch
}
