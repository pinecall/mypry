/**
 * Source map resolution — resolves positions between original and compiled code.
 *
 * Handles all source map formats:
 * - Inline data: URIs (Vite, webpack-dev-server)
 * - External .map files (tsc, Next.js production)
 * - Standard maps (single sources array)
 * - Sectioned/indexed maps (Turbopack consolidated chunks)
 *
 * @module
 */

import type { IScriptEntry } from '../types.js'

// Re-export the existing snapshot-side resolution
export {
  resolveOriginalPosition,
  readOriginalSource,
  type OriginalPosition,
} from '../sourcemap.js'

/**
 * Resolve a source-file position to a compiled/generated position.
 *
 * Used by the breakpoint resolver: given "route.ts line 9", finds
 * the corresponding line in the compiled .js chunk.
 *
 * Handles both standard and sectioned (Turbopack) source maps.
 *
 * @param entry - Script entry with sourceMapURL
 * @param filePattern - Original file path or basename (e.g. "route.ts")
 * @param sourceLine0 - 0-based line number in the original source
 * @returns Generated position (0-based), or null if no mapping found
 */
export async function resolveSourceToCompiled(
  entry: IScriptEntry,
  filePattern: string,
  sourceLine0: number,
): Promise<{ line: number; column: number } | null> {
  if (!entry.sourceMapURL) return null

  const mapContent = await loadSourceMapContent(entry)
  if (!mapContent) return null

  const rawMap = JSON.parse(mapContent)
  const basename = filePattern.replace(/^.*[/\\]/, '')

  // Find the source file name in the map
  const matchedSource = findSourceInMap(rawMap, filePattern, basename)
  if (!matchedSource) return null

  const { SourceMapConsumer } = await import('source-map')
  const consumer = await new SourceMapConsumer(rawMap)
  try {
    const gen = consumer.generatedPositionFor({
      source: matchedSource,
      line: sourceLine0 + 1,  // source-map lib uses 1-based
      column: 0,
    })
    if (gen.line != null) {
      return { line: gen.line - 1, column: gen.column ?? 0 } // back to 0-based
    }
  } finally {
    consumer.destroy()
  }
  return null
}

/**
 * Find a compiled .js script whose source map references a given .ts file,
 * and resolve the original line to the compiled line.
 *
 * Used for TypeScript breakpoints where we need to find which .js script
 * contains the compiled version of a .ts file.
 *
 * @param scripts - All loaded scripts
 * @param tsFile - TypeScript file pattern (e.g. "auth.service.ts")
 * @param tsLine0 - 0-based line number in the .ts file
 * @returns The compiled .js URL and 0-based line, or null
 */
export async function resolveTypeScriptBreakpoint(
  scripts: ReadonlyMap<string, IScriptEntry>,
  tsFile: string,
  tsLine0: number,
): Promise<{ jsUrl: string; jsLine: number } | null> {
  const tsBasename = tsFile.replace(/^.*[\\/]/, '')

  for (const [, entry] of scripts) {
    if (!entry.sourceMapURL || !entry.url) continue
    // Only check .js files, skip node_modules
    if (!/\.js(\?.*)?$/.test(entry.url)) continue
    if (entry.url.includes('node_modules')) continue

    try {
      const mapContent = await loadSourceMapContent(entry)
      if (!mapContent) continue

      const rawMap = JSON.parse(mapContent)
      const sources: string[] = rawMap.sources || []

      const matchIdx = sources.findIndex((s: string) => {
        const sBasename = s.replace(/^.*[\\/]/, '')
        return sBasename === tsBasename || s.endsWith(tsFile) || tsFile.endsWith(s)
      })
      if (matchIdx === -1) continue

      const { SourceMapConsumer } = await import('source-map')
      const consumer = await new SourceMapConsumer(rawMap)
      try {
        const gen = consumer.generatedPositionFor({
          source: sources[matchIdx],
          line: tsLine0 + 1,
          column: 0,
        })
        if (gen.line != null) {
          return { jsUrl: entry.url, jsLine: gen.line - 1 }
        }
      } finally {
        consumer.destroy()
      }
    } catch {
      continue
    }
  }
  return null
}

// ── Internal helpers ─────────────────────────────────────────────────

/**
 * Load source map content from an entry's sourceMapURL.
 * Handles inline data: URIs and external .map files.
 */
async function loadSourceMapContent(entry: IScriptEntry): Promise<string | null> {
  if (!entry.sourceMapURL) return null

  if (entry.sourceMapURL.startsWith('data:')) {
    const b64 = entry.sourceMapURL.split(',')[1]
    if (!b64) return null
    return Buffer.from(b64, 'base64').toString()
  }

  // External .map file — read from disk
  try {
    const { readFileSync } = await import('fs')
    const { resolve, dirname } = await import('path')
    let scriptPath = entry.url.replace(/^file:\/\//, '').replace(/\?.*$/, '')
    if (process.platform === 'win32' && scriptPath.startsWith('/')) {
      scriptPath = scriptPath.slice(1)
    }
    const mapPath = resolve(dirname(scriptPath), entry.sourceMapURL)
    return readFileSync(mapPath, 'utf8')
  } catch {
    return null
  }
}

/**
 * Find a matching source filename inside a source map.
 * Handles both standard maps and sectioned/indexed maps (Turbopack).
 */
function findSourceInMap(
  rawMap: { sources?: string[]; sections?: Array<{ map?: { sources?: string[] } }> },
  filePattern: string,
  basename: string,
): string | null {
  // Standard source maps: sources at root level
  const rootSources: string[] = rawMap.sources || []
  for (const s of rootSources) {
    if (sourceMatches(s, filePattern, basename)) return s
  }

  // Sectioned/indexed source maps (Turbopack): sources inside sections[*].map.sources
  if (rawMap.sections) {
    for (const section of rawMap.sections) {
      const sectionSources: string[] = section.map?.sources || []
      for (const s of sectionSources) {
        if (sourceMatches(s, filePattern, basename)) return s
      }
    }
  }

  return null
}

/**
 * Check if a source map source name matches a file pattern.
 * Strips query params (webpack adds cache busters like ?47a1).
 */
function sourceMatches(source: string, filePattern: string, basename: string): boolean {
  const clean = source.replace(/\?.*$/, '')
  const sBasename = clean.replace(/^.*[/\\]/, '')
  return sBasename === basename || clean.endsWith(filePattern) || filePattern.endsWith(clean)
}
