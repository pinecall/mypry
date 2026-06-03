/**
 * Turbopack chunk finder — locates compiled modules in consolidated chunks.
 *
 * Turbopack (Next.js 14/15 dev) compiles multiple modules into single chunk
 * files at `.next/server/chunks/`. The chunk's sectioned source map provides
 * line mappings via SourceMapConsumer.
 *
 * @module
 */

import type { IScriptEntry, IScriptMatch } from '../types.js'

/**
 * Find a Turbopack chunk containing a module matching the given file pattern.
 *
 * Scans loaded scripts for Turbopack-style chunks and checks if they contain
 * the module declaration for the requested file. Prefers highest scriptId
 * (most recent after hot-reload).
 *
 * @param scripts - Map of scriptId → IScriptEntry from CDP
 * @param filePattern - User's file pattern (e.g. "app/api/cart/total/route.ts")
 * @param basename - Just the filename (e.g. "route.ts")
 * @returns Match with scriptId + entry, or null
 */
export function findTurbopackChunk(
  scripts: ReadonlyMap<string, IScriptEntry>,
  filePattern: string,
  basename: string,
): IScriptMatch | null {
  let best: IScriptMatch | null = null
  let bestId = -1

  for (const [scriptId, entry] of scripts) {
    if (!entry.url || !entry.sourceMapURL) continue
    if (!isTurbopackChunkUrl(entry.url)) continue

    // Check if URL query contains the module path (hot-reload chunks)
    try {
      const decoded = decodeURIComponent(entry.url)
      if (decoded.includes('/' + basename) && decoded.includes('[project]')) {
        const idNum = parseInt(scriptId, 10) || 0
        if (idNum > bestId) {
          bestId = idNum
          best = { scriptId, entry }
        }
      }
    } catch { /* bad URL encoding */ }
  }

  return best
}

/**
 * Check if a URL looks like a Turbopack dev chunk.
 *
 * Matches both Next.js 14 and 15 layouts:
 * - `.next/server/chunks/_HASH._.js`
 * - `.next/dev/server/chunks/_HASH._.js`
 */
export function isTurbopackChunkUrl(url: string): boolean {
  if (!url.includes('.next/')) return false
  if (!url.includes('/chunks/')) return false
  if (!url.includes('_.js')) return false
  if (url.includes('node_modules')) return false
  if (url.includes('/ssr/')) return false
  if (url.includes('[turbopack]_runtime')) return false
  return true
}
