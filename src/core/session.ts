/**
 * DebuggerSession — manages a CDP debugging session.
 *
 * Mechanical translation from mypry.js lines 78-209.
 * DO NOT change behavior — this is load-bearing.
 */

import { CDPClient } from './cdp-client.js'

type PauseListener = (params: unknown) => void

interface ScriptEntry {
  url: string
  source: string | null
  sourceMapURL?: string
}

interface BreakpointEntry {
  file: string
  line: number
  cdpId: string
  condition?: string
}

/* eslint-disable @typescript-eslint/no-explicit-any */

export class DebuggerSession {
  cdp: CDPClient
  scripts: Map<string, ScriptEntry>
  currentPause: any
  pauseListeners: PauseListener[]
  onConsole: ((event: any) => void) | null
  breakpoints: Map<number, BreakpointEntry>
  _nextBpId: number

  // Trace mode — non-blocking observation
  tracing: boolean
  traceBuffer: any[]
  maxTraceBuffer: number
  onTraceHit: ((entry: any) => void) | null

  constructor(cdp: CDPClient) {
    this.cdp = cdp
    this.scripts = new Map()          // scriptId -> {url, source|null}
    this.currentPause = null          // {callFrames, reason, ...}
    this.pauseListeners = []
    this.onConsole = null             // callback for console output forwarding
    this.breakpoints = new Map()      // id -> {file, line, cdpId}
    this._nextBpId = 0
    this.tracing = false
    this.traceBuffer = []
    this.maxTraceBuffer = 100
    this.onTraceHit = null
  }

  async init(): Promise<void> {
    this.cdp.on('Debugger.scriptParsed', (p: any) => {
      this.scripts.set(p.scriptId, { url: p.url, source: null, sourceMapURL: p.sourceMapURL })
    })
    this.cdp.on('Debugger.paused', (p: unknown) => {
      this.currentPause = p

      // Trace mode: capture snapshot and auto-resume
      if (this.tracing) {
        this._captureTraceHit().catch(() => {})
        return
      }

      const ls = this.pauseListeners.splice(0)
      for (const l of ls) l(p)
    })
    this.cdp.on('Debugger.resumed', () => { this.currentPause = null })
    this.cdp.on('Runtime.consoleAPICalled', (p: unknown) => {
      if (this.onConsole) this.onConsole(p)
    })

    await this.cdp.send('Runtime.enable')
    await this.cdp.send('Debugger.enable')
  }

  topFrame(): any { return this.currentPause?.callFrames?.[0] || null }

  async getSource(scriptId: string): Promise<ScriptEntry | null> {
    const entry = this.scripts.get(scriptId)
    if (!entry) return null
    if (entry.source == null) {
      try {
        const r = await this.cdp.send('Debugger.getScriptSource', { scriptId }) as any
        entry.source = r.scriptSource
      } catch { entry.source = '' }
    }
    return entry
  }

  async evalInFrame(expr: string): Promise<any> {
    const frame = this.topFrame()
    if (!frame) {
      // Not paused — use Runtime.evaluate for global scope eval
      return this.cdp.send('Runtime.evaluate', {
        expression: expr,
        returnByValue: true,
      })
    }

    // Always use smart serializer — CDP returnByValue silently returns {}
    // for Vue/Pinia Proxy objects, so we can't rely on it.
    return this.cdp.send('Debugger.evaluateOnCallFrame', {
      callFrameId: frame.callFrameId,
      expression: `(function(__expr) {
        try {
          var v = __expr;
          // Unwrap Vue ref
          if (v && v.__v_isRef) v = v.value;
          // Unwrap Pinia store → raw state
          if (v && v.$state) v = JSON.parse(JSON.stringify(v.$state));
          // Unwrap Vue reactive proxy
          if (v && v.__v_raw) v = v.__v_raw;
          // Primitives
          if (v === null) return null;
          if (v === undefined) return undefined;
          if (typeof v === 'string') return v;
          if (typeof v === 'number' || typeof v === 'boolean') return v;
          if (typeof v === 'function') return '[Function: ' + (v.name || 'anon') + ']';
          // Object/Array — circular-safe JSON
          var seen = new WeakSet();
          return JSON.parse(JSON.stringify(v, function(k, val) {
            if (typeof val === 'object' && val !== null) {
              if (val.__v_isRef) return val.value;
              if (val.__v_raw) val = val.__v_raw;
              if (seen.has(val)) return '[Circular]';
              seen.add(val);
            }
            if (typeof val === 'function') return '[Function: ' + (val.name || 'anon') + ']';
            return val;
          }));
        } catch(e) {
          return '[eval error] ' + e.message;
        }
      })(${expr})`,
      returnByValue: true,
    })
  }

  async getLocals(): Promise<Record<string, unknown>> {
    const frame = this.topFrame()
    if (!frame) return {}
    const local = frame.scopeChain.find((s: any) => s.type === 'local')
    if (!local) return {}
    const r = await this.cdp.send('Runtime.getProperties', {
      objectId: local.object.objectId,
      ownProperties: true,
    }) as any
    const out: Record<string, unknown> = {}
    for (const p of r.result || []) {
      if (!p.value) { out[p.name] = '[unset]'; continue }
      if (p.value.value !== undefined) out[p.name] = p.value.value
      else out[p.name] = p.value.description || `[${p.value.type}]`
    }
    return out
  }

  _waitRawPause(): Promise<unknown> {
    if (this.currentPause) return Promise.resolve(this.currentPause)
    return new Promise((res) => this.pauseListeners.push(res))
  }

  async _skipPryFrames(): Promise<void> {
    // When paused inside pry(), auto-step-out so the user lands in their code
    while (this.currentPause) {
      const top = this.currentPause.callFrames?.[0]
      if (!top) break
      const rawUrl = this.scripts.get(top.location.scriptId)?.url || ''
      const url = rawUrl.split('?')[0]  // strip Vite ?t=... cache busters
      if (!url.endsWith('/pry.js') && !url.endsWith('/pry.cjs') && !url.endsWith('/browser.js')) break
      this.currentPause = null
      await this.cdp.send('Debugger.stepOut')
      await this._waitRawPause()
    }
  }

  async waitNextPause(): Promise<unknown> {
    await this._waitRawPause()
    await this._skipPryFrames()
    return this.currentPause
  }

  async stepOver(): Promise<unknown>  { this.currentPause = null; await this.cdp.send('Debugger.stepOver');  return this.waitNextPause() }
  async stepInto(): Promise<unknown>  { this.currentPause = null; await this.cdp.send('Debugger.stepInto');  return this.waitNextPause() }
  async stepOut(): Promise<unknown>   { this.currentPause = null; await this.cdp.send('Debugger.stepOut');   return this.waitNextPause() }
  async resume(): Promise<unknown>    { this.currentPause = null; return this.cdp.send('Debugger.resume') }

  async pause(): Promise<unknown> {
    if (this.currentPause) return this.currentPause
    await this.cdp.send('Debugger.pause')
    return this._waitRawPause()
  }

  async setBreakpoint(filePattern: string, line: number, condition?: string): Promise<number> {
    // line is 1-based from user, CDP uses 0-based
    const lineNumber = line - 1
    const isTS = /\.tsx?$/.test(filePattern)
    const basename = filePattern.replace(/^.*[/\\]/, '')

    // ── Turbopack consolidated chunks (highest priority for .ts in Next.js) ──
    // Must run BEFORE source map resolution because _resolveSourceMapBreakpoint
    // can match wrong chunks (e.g. actions stubs instead of actual module code).
    if (isTS) {
      const found = await this._findTurbopackModule(basename)
      if (found) {
        let sourceFuncLine0 = 2 // default for typical route with 1 import
        try {
          const fs = await import('node:fs')
          const sourceContent = fs.readFileSync(found.sourceFile, 'utf-8')
          const sourceLines = sourceContent.split('\n')
          for (let j = 0; j < sourceLines.length; j++) {
            if (sourceLines[j].match(/^\s*(export\s+)?(async\s+)?function\s+\w/)) {
              sourceFuncLine0 = j
              break
            }
          }
        } catch { /* use default */ }

        const offset = found.compiledFuncLine - sourceFuncLine0
        const targetLine = offset + lineNumber
        const bpParams: Record<string, unknown> = {
          location: { scriptId: found.scriptId, lineNumber: targetLine },
        }
        if (condition) bpParams.condition = condition
        try {
          const sr = await this.cdp.send('Debugger.setBreakpoint', bpParams) as any
          const id = ++this._nextBpId
          this.breakpoints.set(id, { file: filePattern, line, cdpId: sr.breakpointId, condition })
          return id
        } catch { /* fall through to source map */ }
      }
    }

    // For TypeScript files, try source map resolution
    if (isTS) {
      const resolved = await this._resolveSourceMapBreakpoint(filePattern, lineNumber)
      if (resolved) {
        const params: Record<string, unknown> = {
          lineNumber: resolved.jsLine,
          urlRegex: resolved.jsUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        }
        if (condition) params.condition = condition
        const r = await this.cdp.send('Debugger.setBreakpointByUrl', params) as any
        const id = ++this._nextBpId
        this.breakpoints.set(id, { file: filePattern, line, cdpId: r.breakpointId, condition })
        return id
      }
    }

    // Fallback: try to match scripts by filename and resolve source maps
    const escaped = filePattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

    // Search loaded scripts for a matching URL
    let matchedScriptId: string | null = null
    let matchedEntry: ScriptEntry | null = null
    let turbopackMatch: { scriptId: string; entry: ScriptEntry } | null = null

    let basenameMatch: { scriptId: string; entry: ScriptEntry } | null = null

    for (const [scriptId, entry] of this.scripts) {
      if (!entry.url) continue
      const urlPath = entry.url.replace(/\?.*$/, '') // strip query params (Vite ?t=xxx)
      const urlBasename = urlPath.replace(/^.*[/\\]/, '')

      // Full path match — prefer highest scriptId (most recent after HMR)
      if (urlPath.endsWith('/' + filePattern)) {
        const idNum = parseInt(scriptId, 10) || 0
        const prevId = matchedScriptId ? (parseInt(matchedScriptId, 10) || 0) : -1
        if (idNum > prevId) {
          matchedScriptId = scriptId
          matchedEntry = entry
        }
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
          if (decoded.includes('/' + filePattern)) {
            const idNum = parseInt(scriptId, 10) || 0
            const prevId = matchedScriptId ? (parseInt(matchedScriptId, 10) || 0) : -1
            if (idNum > prevId) {
              matchedScriptId = scriptId
              matchedEntry = entry
            }
          } else if (decoded.includes('/' + basename)) {
            // Basename-only webpack match — only use if no full match found
            if (!basenameMatch) {
              basenameMatch = { scriptId, entry }
            }
          }
        } catch { /* bad URL encoding */ }
      }

      // Turbopack: the real compiled code lives in chunks with URL-encoded query params
      // URL pattern: .next/.../chunks/[root-of-the-server]__HASH._.js?id=[project]/src/.../route.ts+...
      // We decode the full URL and search for the original filename
      try {
        const decoded = decodeURIComponent(entry.url)
        if (decoded.includes('/' + basename) && decoded.includes('[project]')) {
          // Prefer scripts WITH source maps (they have the real compiled code)
          if (!turbopackMatch || entry.sourceMapURL) {
            turbopackMatch = { scriptId, entry }
          }
        }
      } catch { /* bad URL encoding */ }
    }

    // Use basename match as fallback if no full-path match found
    if (!matchedScriptId && basenameMatch) {
      matchedScriptId = basenameMatch.scriptId
      matchedEntry = basenameMatch.entry
    }
    // Use Turbopack match as fallback (old format: filename in URL)
    if (!matchedScriptId && turbopackMatch) {
      matchedScriptId = turbopackMatch.scriptId
      matchedEntry = turbopackMatch.entry
    }

    // If we matched a script via URL, set breakpoint
    if (matchedScriptId && matchedEntry) {
      // If it has a source map, resolve the line number
      if (matchedEntry.sourceMapURL) {
        let resolvedLine = lineNumber
        try {
          const mapped = await this._resolveInlineSourceMap(matchedEntry, filePattern, lineNumber)
          if (mapped != null) resolvedLine = mapped.line
        } catch { /* use original line */ }

        // For webpack-internal scripts, use setBreakpointByUrl with the full URL
        // as regex. This is MORE resilient to HMR than setBreakpoint-by-scriptId,
        // because CDP auto-resolves the regex when new scripts appear after hot reload.
        // Fall back to scriptId only if urlRegex silently fails to bind.
        if (matchedEntry.url.includes('webpack-internal://')) {
          const baseUrl = matchedEntry.url.replace(/\?.*$/, '')
          const urlRegex = baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          const byUrlParams: Record<string, unknown> = {
            lineNumber: resolvedLine,
            urlRegex,
          }
          if (condition) byUrlParams.condition = condition
          try {
            const sr = await this.cdp.send('Debugger.setBreakpointByUrl', byUrlParams) as any
            // Check if it actually bound to a location (locations array non-empty)
            if (sr.locations && sr.locations.length > 0) {
              const id = ++this._nextBpId
              this.breakpoints.set(id, { file: filePattern, line, cdpId: sr.breakpointId, condition })
              return id
            }
            // urlRegex registered but didn't bind — remove and try scriptId
            await this.cdp.send('Debugger.removeBreakpoint', { breakpointId: sr.breakpointId }).catch(() => {})
          } catch { /* fall through */ }

          // Fallback: setBreakpoint by scriptId (won't survive HMR but works now)
          const bpParams: Record<string, unknown> = {
            location: { scriptId: matchedScriptId, lineNumber: resolvedLine },
          }
          if (condition) bpParams.condition = condition
          try {
            const sr = await this.cdp.send('Debugger.setBreakpoint', bpParams) as any
            const id = ++this._nextBpId
            this.breakpoints.set(id, { file: filePattern, line, cdpId: sr.breakpointId, condition })
            return id
          } catch { /* fall through to generic urlRegex */ }
        }

        const baseUrl = matchedEntry.url.replace(/\?.*$/, '')
        const scriptUrl = baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '.*'
        const bpParams: Record<string, unknown> = {
          lineNumber: resolvedLine,
          urlRegex: scriptUrl,
        }
        if (condition) bpParams.condition = condition
        const sr = await this.cdp.send('Debugger.setBreakpointByUrl', bpParams) as any
        const id = ++this._nextBpId
        this.breakpoints.set(id, { file: filePattern, line, cdpId: sr.breakpointId, condition })
        return id
      }

      // No source map — set breakpoint by scriptId directly
      const bpParams: Record<string, unknown> = {
        location: { scriptId: matchedScriptId, lineNumber },
      }
      if (condition) bpParams.condition = condition
      try {
        const sr = await this.cdp.send('Debugger.setBreakpoint', bpParams) as any
        const id = ++this._nextBpId
        this.breakpoints.set(id, { file: filePattern, line, cdpId: sr.breakpointId, condition })
        return id
      } catch { /* fall through */ }
    }

    // No source map — use urlRegex directly (plain .js files)
    const params: Record<string, unknown> = {
      lineNumber,
      urlRegex: escaped,
    }
    if (condition) params.condition = condition
    const r = await this.cdp.send('Debugger.setBreakpointByUrl', params) as any
    const id = ++this._nextBpId
    this.breakpoints.set(id, { file: filePattern, line, cdpId: r.breakpointId, condition })
    return id
  }

  /**
   * Resolve a source line → generated line using a script's inline source map.
   * Handles Vite/Webpack transforms (JSX → _jsxDEV, etc.) that shift line numbers.
   */
  private async _resolveInlineSourceMap(
    entry: ScriptEntry,
    filePattern: string,
    sourceLine0: number, // 0-based
  ): Promise<{ line: number; column: number } | null> {
    if (!entry.sourceMapURL) return null

    let mapContent: string | null = null

    if (entry.sourceMapURL.startsWith('data:')) {
      const b64 = entry.sourceMapURL.split(',')[1]
      if (!b64) return null
      mapContent = Buffer.from(b64, 'base64').toString()
    } else {
      // For non-inline maps, try fetching via CDP
      try {
        const { readFileSync } = await import('fs')
        const { resolve, dirname } = await import('path')
        let scriptPath = entry.url.replace(/^file:\/\//, '').replace(/\?.*$/, '')
        if (process.platform === 'win32' && scriptPath.startsWith('/'))
          scriptPath = scriptPath.slice(1)
        const mapPath = resolve(dirname(scriptPath), entry.sourceMapURL)
        mapContent = readFileSync(mapPath, 'utf8')
      } catch { return null }
    }

    if (!mapContent) return null

    const rawMap = JSON.parse(mapContent)
    const basename = filePattern.replace(/^.*[/\\]/, '')

    // Find the source file name in the map (or in sections for indexed/sectioned maps)
    let matchedSource: string | null = null

    // Standard source maps: sources at root level
    const rootSources: string[] = rawMap.sources || []
    for (const s of rootSources) {
      // Strip query params (webpack adds cache busters like ?47a1 to source names)
      const sClean = s.replace(/\?.*$/, '')
      const sBasename = sClean.replace(/^.*[/\\]/, '')
      if (sBasename === basename || sClean.endsWith(filePattern) || filePattern.endsWith(sClean)) {
        matchedSource = s  // use original name for source map lookup
        break
      }
    }

    // Sectioned/indexed source maps (Turbopack): sources are inside sections[*].map.sources
    if (!matchedSource && rawMap.sections) {
      for (const section of rawMap.sections) {
        const sectionSources: string[] = section.map?.sources || []
        for (const s of sectionSources) {
          const sBasename = s.replace(/^.*[/\\]/, '')
          if (sBasename === basename || s.endsWith(filePattern) || filePattern.endsWith(s)) {
            matchedSource = s
            break
          }
        }
        if (matchedSource) break
      }
    }

    if (!matchedSource) return null

    const { SourceMapConsumer } = await import('source-map')
    const consumer = await new SourceMapConsumer(rawMap)
    try {
      const gen = consumer.generatedPositionFor({
        source: matchedSource,
        line: sourceLine0 + 1, // source-map lib uses 1-based
        column: 0,
      })
      if (gen.line != null) return { line: gen.line - 1, column: gen.column ?? 0 } // back to 0-based
    } finally {
      consumer.destroy()
    }
    return null
  }
  /**
   * Scan Turbopack consolidated chunks for a module matching `basename`.
   * Returns the scriptId, compiled function line, and source file path.
   */
  private async _findTurbopackModule(basename: string): Promise<{
    scriptId: string
    compiledFuncLine: number
    sourceFile: string
  } | null> {
    const basenameNoExt = basename.replace(/\.tsx?$/, '')
    let best: { scriptId: string; compiledFuncLine: number; sourceFile: string } | null = null
    let bestScriptIdNum = -1

    for (const [scriptId, entry] of this.scripts) {
      if (!entry.url) continue
      // Only scan Turbopack dev chunks
      if (!entry.url.includes('.next/dev/server/chunks/')) continue
      if (entry.url.includes('node_modules')) continue
      if (entry.url.includes('/ssr/')) continue

      try {
        // Check two patterns:
        // 1. Initial: source contains "[project]/.../<basename>" module declaration
        // 2. Hot-reload: URL query param contains the module path (URL-encoded)
        const decodedUrl = decodeURIComponent(entry.url)
        const isHotReloaded = decodedUrl.includes('?id=') && decodedUrl.includes(basename)

        const source = await this.getSource(scriptId)
        if (!source?.source) continue

        let moduleStartLine = -1
        const lines = source.source.split('\n')

        if (!isHotReloaded) {
          // Pattern 1: Full chunk with module declaration
          if (!source.source.includes('[project]/')) continue
          if (!source.source.includes('/' + basenameNoExt)) continue

          for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(basename) && lines[i].includes('[project]')) {
              moduleStartLine = i
              break
            }
          }
          if (moduleStartLine === -1) continue
        }
        // For hot-reloaded chunks, moduleStartLine stays -1 (no wrapper)

        // Find the first function definition
        const searchStart = moduleStartLine >= 0 ? moduleStartLine + 1 : 0
        let compiledFuncLine = -1
        for (let i = searchStart; i < Math.min(searchStart + 30, lines.length); i++) {
          if (lines[i].match(/^\s*(async\s+)?function\s+\w/)) {
            compiledFuncLine = i
            break
          }
        }
        if (compiledFuncLine === -1) continue

        // Derive source file path
        let sourceFile: string | null = null
        const { join } = await import('node:path')

        if (moduleStartLine >= 0) {
          // Extract from module declaration: "[project]/src/.../route.ts ..."
          const declLine = lines[moduleStartLine]
          const pathMatch = declLine.match(/\[project\]\/([^\s"[\]]+)/)
          if (!pathMatch) continue
          const chunkPath = entry.url.replace(/^file:\/\//, '').replace(/\?.*$/, '')
          const nextIdx = chunkPath.indexOf('.next/')
          if (nextIdx === -1) continue
          sourceFile = join(chunkPath.substring(0, nextIdx), pathMatch[1])
        } else if (isHotReloaded) {
          // Extract from URL query: ?id=[project]/src/.../route.ts+...
          const idMatch = decodedUrl.match(/\[project\]\/([^\s+[\]]+)/)
          if (!idMatch) continue
          const chunkPath = entry.url.replace(/^file:\/\//, '').replace(/\?.*$/, '')
          const nextIdx = chunkPath.indexOf('.next/')
          if (nextIdx === -1) continue
          sourceFile = join(chunkPath.substring(0, nextIdx), idMatch[1])
        }
        if (!sourceFile) continue

        // Always prefer the highest scriptId (most recent after hot-reload)
        const idNum = parseInt(scriptId, 10) || 0
        if (idNum > bestScriptIdNum) {
          bestScriptIdNum = idNum
          best = { scriptId, compiledFuncLine, sourceFile }
        }
      } catch { /* skip */ }
    }

    return best
  }

  /**
   * Resolve a TypeScript breakpoint to compiled JS coordinates.
   * Finds the .js script whose source map references our .ts file,
   * then reverse-maps the TS line to the JS line.
   */
  private async _resolveSourceMapBreakpoint(
    tsFile: string,
    tsLine0: number,
  ): Promise<{ jsUrl: string; jsLine: number } | null> {
    // Normalize: "auth.service.ts" or "src/auth/auth.service.ts"
    const tsBasename = tsFile.replace(/^.*[\\/]/, '')

    // Find a script whose source map references this .ts file
    for (const [scriptId, entry] of this.scripts) {
      if (!entry.sourceMapURL || !entry.url) continue
      // Only check .js files, skip node_modules (framework internals match too broadly)
      if (!/\.js(\?.*)?$/.test(entry.url)) continue
      if (entry.url.includes('node_modules')) continue

      try {
        // Resolve source map URL (can be relative to script URL or inline)
        let mapContent: string | null = null

        if (entry.sourceMapURL.startsWith('data:')) {
          // Inline source map
          const b64 = entry.sourceMapURL.split(',')[1]
          mapContent = Buffer.from(b64, 'base64').toString()
        } else {
          // File-based source map — read from disk
          const { readFileSync } = await import('fs')
          const { resolve, dirname } = await import('path')

          // Script URL is file:// or absolute path
          let scriptPath = entry.url.replace(/^file:\/\//, '')
          // Handle Windows-style paths
          if (process.platform === 'win32' && scriptPath.startsWith('/'))
            scriptPath = scriptPath.slice(1)

          const mapPath = resolve(dirname(scriptPath), entry.sourceMapURL)
          mapContent = readFileSync(mapPath, 'utf8')
        }

        if (!mapContent) continue

        const rawMap = JSON.parse(mapContent)
        // Check if any source in the map matches our TS file
        const sources: string[] = rawMap.sources || []
        const matchIdx = sources.findIndex((s: string) => {
          const sBasename = s.replace(/^.*[\\/]/, '')
          return sBasename === tsBasename || s.endsWith(tsFile) || tsFile.endsWith(s)
        })
        if (matchIdx === -1) continue

        // Found it! Now reverse-map the TS line to JS line using source-map
        const { SourceMapConsumer } = await import('source-map')
        const consumer = await new SourceMapConsumer(rawMap)
        try {
          // Find the generated position for this original position
          const gen = consumer.generatedPositionFor({
            source: sources[matchIdx],
            line: tsLine0 + 1, // source-map lib uses 1-based
            column: 0,
          })
          if (gen.line != null) {
            return { jsUrl: entry.url, jsLine: gen.line - 1 } // back to 0-based
          }
        } finally {
          consumer.destroy()
        }
      } catch {
        // Skip this script if source map can't be read/parsed
        continue
      }
    }
    return null
  }

  async removeBreakpoint(id: number): Promise<void> {
    const bp = this.breakpoints.get(id)
    if (!bp) throw new Error(`no breakpoint #${id}`)
    await this.cdp.send('Debugger.removeBreakpoint', { breakpointId: bp.cdpId })
    this.breakpoints.delete(id)
  }

  async removeAllBreakpoints(): Promise<void> {
    for (const [, bp] of this.breakpoints) {
      try { await this.cdp.send('Debugger.removeBreakpoint', { breakpointId: bp.cdpId }) } catch {}
    }
    this.breakpoints.clear()
  }

  // ── Trace mode ──

  async _captureTraceHit(): Promise<void> {
    const frame = this.topFrame()
    if (!frame) { await this.resume(); return }

    const scriptId = frame.location.scriptId
    const s = await this.getSource(scriptId)
    const line = frame.location.lineNumber + 1

    const entry = {
      timestamp: Date.now(),
      file: (s?.url || '').replace(/^file:\/\//, ''),
      line,
      function: frame.functionName || '<anon>',
      locals: await this.getLocals(),
    }

    if (this.traceBuffer.length < this.maxTraceBuffer) {
      this.traceBuffer.push(entry)
    }
    if (this.onTraceHit) this.onTraceHit(entry)

    // Auto-resume — don't block execution
    this.currentPause = null
    await this.cdp.send('Debugger.resume')
  }

  startTrace(maxBuffer?: number): void {
    this.tracing = true
    this.traceBuffer = []
    if (maxBuffer) this.maxTraceBuffer = maxBuffer
  }

  stopTrace(): any[] {
    this.tracing = false
    const buffer = this.traceBuffer
    this.traceBuffer = []
    return buffer
  }
}
