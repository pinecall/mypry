/**
 * Breakpoint resolver — resolves user's file:line into CDP-ready locations.
 *
 * Resolution chain (ordered by priority):
 * 1. TypeScript with source map in loaded scripts
 * 2. Turbopack chunk with sectioned source map
 * 3. Direct URL match with source map
 * 4. webpack-internal:// with inline source map (+ HMR-resilient urlRegex)
 * 5. Direct URL match without source map
 * 6. urlRegex fallback (deferred binding for lazy-loaded scripts)
 *
 * @see https://github.com/nicolo-ribaudo/vscode-js-debug — breakpoints/breakpointBase.ts
 * @module
 */

import type { CDPClient } from '../cdp-client.js'
import type { IScriptEntry, IResolvedLocation } from '../types.js'
import { resolveSourceToCompiled, resolveTypeScriptBreakpoint } from '../sources/index.js'
import { findTurbopackChunk } from '../sources/turbopack.js'
import { findWebpackScript } from '../sources/webpack.js'
import { matchScript } from '../sources/script-matcher.js'

/**
 * Resolves a user's file:line into a CDP-ready location.
 *
 * Tries multiple strategies in priority order, falling back
 * to urlRegex deferred binding as a last resort.
 */
export class BreakpointResolver {
  constructor(
    private readonly scripts: ReadonlyMap<string, IScriptEntry>,
    private readonly cdp: CDPClient,
  ) {}

  /**
   * Resolve a file pattern + line into a CDP location.
   *
   * @param filePattern - File path (e.g. "app/api/cart/total/route.ts")
   * @param line0 - 0-based line number
   * @returns Resolved location with CDP method and parameters
   * @throws {Error} if no matching script is found and urlRegex fails
   */
  async resolve(filePattern: string, line0: number): Promise<IResolvedLocation> {
    const basename = filePattern.replace(/^.*[/\\]/, '')
    const isTS = /\.tsx?$/.test(filePattern)

    // 1. TypeScript source map resolution (standalone .ts → .js scripts)
    if (isTS) {
      const resolved = await resolveTypeScriptBreakpoint(this.scripts, filePattern, line0)
      if (resolved) {
        return {
          lineNumber: resolved.jsLine,
          method: 'byUrl',
          urlRegex: escapeRegex(resolved.jsUrl),
        }
      }
    }

    // 2. Turbopack chunk
    const turbo = findTurbopackChunk(this.scripts, filePattern, basename)
    if (turbo && turbo.entry.sourceMapURL) {
      const mapped = await resolveSourceToCompiled(turbo.entry, filePattern, line0)
      if (mapped) {
        return {
          lineNumber: mapped.line,
          method: 'byUrl',
          urlRegex: escapeRegex(turbo.entry.url) + '.*',
        }
      }
    }

    // 3. webpack-internal:// match
    const webpack = findWebpackScript(this.scripts, filePattern, basename)
    if (webpack) {
      let resolvedLine = line0
      if (webpack.entry.sourceMapURL) {
        const mapped = await resolveSourceToCompiled(webpack.entry, filePattern, line0)
        if (mapped) resolvedLine = mapped.line
      }
      // Use setBreakpointByUrl with URL regex — survives HMR
      const baseUrl = webpack.entry.url.replace(/\?.*$/, '')
      return {
        lineNumber: resolvedLine,
        method: 'byUrl',
        urlRegex: escapeRegex(baseUrl),
      }
    }

    // 4-5. Direct URL match
    const match = matchScript(this.scripts, filePattern, basename)
    if (match) {
      if (match.entry.sourceMapURL) {
        let resolvedLine = line0
        const mapped = await resolveSourceToCompiled(match.entry, filePattern, line0)
        if (mapped) resolvedLine = mapped.line

        const baseUrl = match.entry.url.replace(/\?.*$/, '')
        return {
          lineNumber: resolvedLine,
          method: 'byUrl',
          urlRegex: escapeRegex(baseUrl) + '.*',
        }
      }
      // No source map — set by scriptId directly
      return {
        scriptId: match.scriptId,
        lineNumber: line0,
        method: 'byScriptId',
      }
    }

    // 6. urlRegex fallback — CDP binds lazily when matching script loads
    return {
      lineNumber: line0,
      method: 'byUrlRegex',
      urlRegex: escapeRegex(filePattern),
    }
  }
}

/**
 * Escape a string for use in a regex pattern.
 * @internal
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
