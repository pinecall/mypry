/**
 * Source map resolution — resolves original file/line from transpiled code.
 *
 * Used by snapshot() to show TypeScript/JSX source locations instead of
 * compiled JavaScript when source maps are available.
 */

import { SourceMapConsumer, type RawSourceMap } from 'source-map'
import fs from 'node:fs'

const consumerCache = new Map<string, SourceMapConsumer | null>()

export interface OriginalPosition {
  source: string | null
  line: number | null
  column: number | null
}

/**
 * Attempt to load a source map for the given JS file.
 * Looks for inline `//# sourceMappingURL=` and tries to load the map.
 * Returns null if no map is found.
 */
async function loadSourceMap(source: string): Promise<SourceMapConsumer | null> {
  if (consumerCache.has(source)) return consumerCache.get(source)!

  let consumer: SourceMapConsumer | null = null
  try {
    // Look for sourceMappingURL in the source
    const match = source.match(/\/\/[#@]\s*sourceMappingURL\s*=\s*(.+?)$/m)
    if (match) {
      const url = match[1].trim()
      if (url.startsWith('data:')) {
        // Inline base64 source map
        const b64 = url.replace(/^data:[^,]+,/, '')
        const json = Buffer.from(b64, 'base64').toString('utf8')
        consumer = await new SourceMapConsumer(JSON.parse(json) as RawSourceMap)
      } else {
        // External file — try to read it
        try {
          const mapContent = fs.readFileSync(url, 'utf8')
          consumer = await new SourceMapConsumer(JSON.parse(mapContent) as RawSourceMap)
        } catch {
          // File might be relative or not found — that's OK
        }
      }
    }
  } catch {
    // Source map parsing failed — ignore
  }

  consumerCache.set(source, consumer)
  return consumer
}

/**
 * Resolve the original source position from a compiled position.
 * Returns the original position if a source map is available, or null.
 */
export async function resolveOriginalPosition(
  compiledSource: string,
  line: number,
  column: number
): Promise<OriginalPosition | null> {
  const consumer = await loadSourceMap(compiledSource)
  if (!consumer) return null

  const pos = consumer.originalPositionFor({ line, column })
  if (!pos.source) return null

  return {
    source: pos.source,
    line: pos.line,
    column: pos.column,
  }
}
