/**
 * Source map resolution — resolves original file/line from transpiled code.
 *
 * Used by snapshot() to show TypeScript/JSX source locations instead of
 * compiled JavaScript when source maps are available.
 */

import { SourceMapConsumer, type RawSourceMap } from 'source-map'
import fs from 'node:fs'
import path from 'node:path'

const consumerCache = new Map<string, SourceMapConsumer | null>()

export interface OriginalPosition {
  source: string  // absolute path to original .ts file
  line: number
  column: number | null
}

/**
 * Attempt to load a source map for the given JS file.
 * Tries:
 *   1. Inline sourceMappingURL (data: URI)
 *   2. External .map file relative to the JS file path
 */
async function loadSourceMap(
  sourceCode: string,
  filePath: string
): Promise<SourceMapConsumer | null> {
  if (consumerCache.has(filePath)) return consumerCache.get(filePath)!

  let consumer: SourceMapConsumer | null = null
  try {
    const match = sourceCode.match(/\/\/[#@]\s*sourceMappingURL\s*=\s*(.+?)$/m)
    if (match) {
      const url = match[1].trim()
      if (url.startsWith('data:')) {
        // Inline base64 source map
        const b64 = url.replace(/^data:[^,]+,/, '')
        const json = Buffer.from(b64, 'base64').toString('utf8')
        consumer = await new SourceMapConsumer(JSON.parse(json) as RawSourceMap)
      } else {
        // External file — resolve relative to the JS file
        const dir = path.dirname(filePath)
        const mapPath = path.resolve(dir, url)
        try {
          const mapContent = fs.readFileSync(mapPath, 'utf8')
          consumer = await new SourceMapConsumer(JSON.parse(mapContent) as RawSourceMap)
        } catch {
          // Also try .map appended to JS filename
          try {
            const mapContent = fs.readFileSync(filePath + '.map', 'utf8')
            consumer = await new SourceMapConsumer(JSON.parse(mapContent) as RawSourceMap)
          } catch { /* no map found */ }
        }
      }
    }
  } catch { /* source map parsing failed */ }

  consumerCache.set(filePath, consumer)
  return consumer
}

/**
 * Resolve the original source position from a compiled position.
 *
 * @param filePath  Absolute path to the compiled JS file
 * @param sourceCode  The compiled JS source code
 * @param line  1-based line number in the compiled file
 * @param column  0-based column number (default 0)
 * @returns Original position with absolute path, or null
 */
export async function resolveOriginalPosition(
  filePath: string,
  sourceCode: string,
  line: number,
  column: number = 0
): Promise<OriginalPosition | null> {
  const consumer = await loadSourceMap(sourceCode, filePath)
  if (!consumer) return null

  // Source maps may not have a mapping at column 0 (indented code).
  // Scan columns to find the first valid mapping on this line.
  for (let col = column; col < 80; col++) {
    const pos = consumer.originalPositionFor({ line, column: col })
    if (pos.source && pos.line !== null) {
      const dir = path.dirname(filePath)
      const absoluteSource = path.resolve(dir, pos.source)
      return { source: absoluteSource, line: pos.line, column: pos.column }
    }
  }

  return null
}

/**
 * Read the original .ts source file and return its lines.
 * Returns null if the file can't be read.
 */
export function readOriginalSource(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
}
