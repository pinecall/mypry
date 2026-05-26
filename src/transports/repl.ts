/**
 * Human REPL transport — readline + ANSI colors.
 *
 * Mechanical translation from mypry.js lines 211-403.
 * DO NOT change behavior — this is load-bearing.
 */

import readline from 'node:readline'
import type { DebuggerSession } from '../core/session.js'
import { cleanUrl, formatValue } from '../core/snapshot.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

// ─────────────────────────── ANSI colors ──────────────────────────

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  cyan: '\x1b[36m', yellow: '\x1b[33m', green: '\x1b[32m', red: '\x1b[31m',
}
const ARROW = `${C.bold}${C.yellow}►${C.reset}`

// ─────────────────────────── Renderer ─────────────────────────────

function renderPause(session: DebuggerSession, ctx = 4): string {
  const frame = session.topFrame()
  if (!frame) return `${C.dim}(not paused)${C.reset}\n`
  const scriptId = frame.location.scriptId
  const line = frame.location.lineNumber
  const script = session.scripts.get(scriptId)
  const lines = (script?.source || '').split('\n')
  const start = Math.max(0, line - ctx)
  const end = Math.min(lines.length - 1, line + ctx)
  const fname = cleanUrl(script?.url) || `<scriptId:${scriptId}>`
  const w = String(end + 1).length

  let out = `${C.dim}─── ${fname}:${line + 1}  ${frame.functionName || '<anon>'} ───${C.reset}\n`
  for (let i = start; i <= end; i++) {
    const num = String(i + 1).padStart(w, ' ')
    const text = lines[i] ?? ''
    if (i === line) {
      out += `${ARROW} ${C.bold}${num}${C.reset} │ ${C.yellow}${text}${C.reset}\n`
    } else {
      out += `  ${C.dim}${num} │ ${text}${C.reset}\n`
    }
  }
  return out
}

const HELP = [
  '  n, next              step over',
  '  s, step              step into',
  '  o, out               step out',
  '  c, continue          resume execution',
  '  l, list              show source around current line',
  '  bt, where            show call stack',
  '  locals               list local variables',
  '  break FILE:LINE      set breakpoint (e.g. break src/app.ts:42)',
  '  breakpoints, bl      list breakpoints',
  '  delete N / delete *  remove breakpoint #N or all',
  '  pause                force-pause a running process',
  '  <expression>         evaluate in current frame (the pry trick)',
  '  q, quit              disconnect',
  '',
].join('\n')

// ─────────────────────────── Main loop ────────────────────────────

async function afterStep(session: DebuggerSession): Promise<void> {
  const frame = session.topFrame()
  if (frame) await session.getSource(frame.location.scriptId)
  process.stdout.write(renderPause(session))
}

export async function runRepl(session: DebuggerSession): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const ask = (q: string): Promise<string> => new Promise((res, rej) => {
    rl.question(q, (ans) => res(ans))
    rl.once('close', () => rej(new Error('stdin closed')))
  })

  // Forward console output from the target to this terminal
  session.onConsole = (event: any) => {
    const args = (event.args || []).map((a: any) => {
      if (a.value !== undefined) return formatValue(a.value)
      return a.description || `[${a.type}]`
    })
    const text = args.join(' ')
    if (text.includes('SecurityWarning') || text.includes('DeprecationWarning')) return
    const tag = event.type === 'log' ? '' : `.${event.type}`
    process.stdout.write(`${C.dim}[console${tag}]${C.reset} ${text}\n`)
  }

  // Handle --inspect mode: process may already be running (not paused)
  if (session.currentPause) {
    await session._skipPryFrames()
    if (session.topFrame()) {
      await session.getSource(session.topFrame().location.scriptId)
      process.stdout.write(renderPause(session))
    }
  } else {
    process.stdout.write(
      `${C.dim}(target is running — set breakpoints or type ${C.reset}pause${C.dim} to stop it)${C.reset}\n`
    )
  }

  session.cdp.onClose(() => {
    process.stdout.write(`\n${C.dim}(target disconnected)${C.reset}\n`)
    rl.close()
    process.exit(0)
  })

  while (true) {
    let line: string
    const prompt = session.currentPause
      ? `${C.green}(mypry)${C.reset} `
      : `${C.yellow}(mypry|running)${C.reset} `
    try { line = await ask(prompt) } catch { break }
    const cmd = (line || '').trim()
    if (!cmd) continue

    try {
      const lc = cmd.toLowerCase()
      // ── commands that always work (paused or running) ──
      if (lc === 'q' || lc === 'quit' || lc === 'exit') break
      else if (lc === 'help' || lc === '?') process.stdout.write(HELP)
      else if (lc.startsWith('break ') || lc.startsWith('b ')) {
        const arg = cmd.slice(cmd.indexOf(' ') + 1).trim()
        const m = arg.match(/^(.+):(\d+)$/)
        if (!m) { process.stdout.write(`${C.red}usage: break file:line${C.reset}\n`); continue }
        const id = await session.setBreakpoint(m[1], parseInt(m[2]))
        process.stdout.write(`${C.green}breakpoint #${id}${C.reset} → ${m[1]}:${m[2]}\n`)
      }
      else if (lc === 'breakpoints' || lc === 'bl') {
        if (!session.breakpoints.size) { process.stdout.write(`${C.dim}(no breakpoints)${C.reset}\n`); continue }
        for (const [id, bp] of session.breakpoints) {
          process.stdout.write(`  ${C.cyan}#${id}${C.reset} ${bp.file}:${bp.line}\n`)
        }
      }
      else if (lc.startsWith('delete ') || lc.startsWith('del ')) {
        const arg = cmd.slice(cmd.indexOf(' ') + 1).trim()
        if (arg === '*' || arg === 'all') {
          await session.removeAllBreakpoints()
          process.stdout.write(`${C.dim}(all breakpoints removed)${C.reset}\n`)
        } else {
          await session.removeBreakpoint(parseInt(arg))
          process.stdout.write(`${C.dim}(breakpoint #${arg} removed)${C.reset}\n`)
        }
      }
      else if (lc === 'pause') {
        if (session.currentPause) { process.stdout.write(`${C.dim}(already paused)${C.reset}\n`); continue }
        await session.pause()
        await afterStep(session)
      }
      // ── commands that require paused state ──
      else if (!session.currentPause) {
        process.stdout.write(`${C.dim}(not paused — use ${C.reset}break file:line${C.dim} then wait, or ${C.reset}pause${C.dim})${C.reset}\n`)
      }
      else if (lc === 'n' || lc === 'next')      { await session.stepOver(); await afterStep(session) }
      else if (lc === 's' || lc === 'step')      { await session.stepInto(); await afterStep(session) }
      else if (lc === 'o' || lc === 'out')       { await session.stepOut();  await afterStep(session) }
      else if (lc === 'c' || lc === 'continue')  {
        await session.resume()
        process.stdout.write(`${C.dim}(running...)${C.reset}\n`)
        await session.waitNextPause()
        await afterStep(session)
      }
      else if (lc === 'l' || lc === 'list')      process.stdout.write(renderPause(session, 8))
      else if (lc === 'bt' || lc === 'where' || lc === 'backtrace') {
        const frames = session.currentPause?.callFrames || []
        for (let i = 0; i < frames.length; i++) {
          const f = frames[i]
          const u = cleanUrl(session.scripts.get(f.location.scriptId)?.url)
          const marker = i === 0 ? ARROW : ' '
          process.stdout.write(`  ${marker} ${i}: ${C.cyan}${f.functionName || '<anon>'}${C.reset} ${C.dim}${u}:${f.location.lineNumber + 1}${C.reset}\n`)
        }
      }
      else if (lc === 'locals') {
        const locals = await session.getLocals()
        for (const [k, v] of Object.entries(locals)) {
          process.stdout.write(`  ${C.cyan}${k}${C.reset} = ${formatValue(v)}\n`)
        }
      }
      else {
        const r = await session.evalInFrame(cmd) as any
        if (r.exceptionDetails) {
          process.stdout.write(`${C.red}!! ${r.exceptionDetails.text}${C.reset}\n`)
          if (r.result?.description) process.stdout.write(`   ${r.result.description}\n`)
        } else {
          const val = r.result.value !== undefined ? r.result.value : r.result.description
          process.stdout.write(`${C.dim}=>${C.reset} ${formatValue(val)}\n`)
        }
      }
    } catch (e: any) {
      process.stdout.write(`${C.red}error: ${e.message}${C.reset}\n`)
    }
  }
  rl.close()
}
