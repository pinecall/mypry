/**
 * Turbopack chunk detection.
 *
 * Turbopack (Next.js 14/15 dev) compiles multiple modules into single
 * hash-named chunk files at `.next/server/chunks/_HASH._.js`. The file→chunk
 * mapping lives only in the chunk's sectioned source map (not the URL), so the
 * resolver scans each chunk's map via `resolveSourceToCompiled`. This module
 * just identifies which loaded scripts are Turbopack app chunks worth scanning.
 *
 * @module
 */

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
