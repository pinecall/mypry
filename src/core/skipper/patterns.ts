/**
 * Blackbox pattern definitions for V8's Debugger.setBlackboxPatterns.
 *
 * V8 natively skips blackboxed scripts during stepping — much more
 * efficient than our previous manual stepOut loop. When a user steps
 * into blackboxed code, V8 automatically steps through it.
 *
 * @module
 */

/**
 * Default patterns for V8's `Debugger.setBlackboxPatterns`.
 * These are regex patterns — V8 matches them against script URLs.
 */
export const DEFAULT_BLACKBOX_PATTERNS: readonly string[] = [
  // Node.js third-party modules
  '/node_modules/',
  // Node.js internal modules (node:fs, node:http, etc.)
  '^node:',
  // Node.js internal implementation files
  '^internal/',
  // Next.js framework internals
  '/next/dist/',
  'next-server',
  // Webpack runtime (not user modules compiled by webpack)
  'webpack/runtime/',
  'webpack/bootstrap',
  // Turbopack runtime
  '\\[turbopack\\]',
]

/**
 * Framework/library URL patterns checked by `isFrameworkCode()`.
 * These use substring/prefix matching for performance (not regex).
 */
const FRAMEWORK_PATTERNS: readonly { match: 'includes' | 'startsWith'; pattern: string }[] = [
  { match: 'includes',   pattern: 'node_modules/' },
  { match: 'includes',   pattern: 'node_modules\\' },
  { match: 'startsWith', pattern: 'node:' },
  { match: 'startsWith', pattern: 'internal/' },
  { match: 'includes',   pattern: 'webpack/runtime/' },
  { match: 'includes',   pattern: 'webpack/bootstrap' },
  { match: 'includes',   pattern: '/next/dist/' },
  { match: 'includes',   pattern: 'next-server' },
  { match: 'includes',   pattern: '[turbopack]_runtime' },
]

/**
 * Check if a URL belongs to framework/library code (not user code).
 *
 * Uses fast substring/prefix matching — no regex overhead.
 * Returns true for node_modules, Node.js internals, Next.js,
 * webpack runtime, and Turbopack runtime.
 *
 * @param url - Script URL to check
 * @param extraPatterns - Additional patterns to check (optional)
 * @returns `true` if the URL is framework code
 */
export function isFrameworkCode(url: string, extraPatterns?: readonly string[]): boolean {
  if (!url) return true // no URL = eval'd code = framework

  for (const { match, pattern } of FRAMEWORK_PATTERNS) {
    if (match === 'includes' ? url.includes(pattern) : url.startsWith(pattern)) {
      return true
    }
  }

  // webpack-internal scripts from node_modules
  if (url.includes('webpack-internal://') && url.includes('/node_modules/')) {
    return true
  }

  // Extra patterns (user-configured)
  if (extraPatterns) {
    for (const p of extraPatterns) {
      if (url.includes(p)) return true
    }
  }

  return false
}
