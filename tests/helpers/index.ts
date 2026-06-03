/**
 * Test helpers for spawning targets and attaching mypry.
 *
 * Uses node:test compatible patterns. All helpers are synchronous-API
 * friendly but return Promises for the async operations.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Find project root (works from both test/helpers and dist-test/test/helpers)
import { existsSync } from 'node:fs'
function findProjectRoot(dir: string): string {
  for (let levels = 1; levels <= 5; levels++) {
    const candidate = path.resolve(dir, ...Array(levels).fill('..'))
    if (existsSync(path.join(candidate, 'package.json'))) return candidate
  }
  throw new Error('could not find project root from ' + dir)
}
const PROJECT_ROOT = findProjectRoot(__dirname)
const MYPRY_CLI = path.join(PROJECT_ROOT, 'mypry.js')
const FIXTURES_DIR = path.join(PROJECT_ROOT, 'test', 'fixtures')

// ─── Target spawning ───

export interface SpawnedTarget {
  proc: ChildProcess
  exit: () => Promise<void>
}

export async function spawnTarget(
  fixtureName: string,
  opts: { port: number }
): Promise<SpawnedTarget> {
  const fixturePath = path.resolve(FIXTURES_DIR, fixtureName)
  const proc = spawn('node', [fixturePath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PRY_PORT: String(opts.port) },
  })

  // Wait for inspector to be ready
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('target did not start inspector')), 10000)
    proc.stderr!.on('data', (buf: Buffer) => {
      if (buf.toString().includes('waiting for client')) {
        clearTimeout(timeout)
        resolve()
      }
    })
    proc.on('exit', (code) => {
      clearTimeout(timeout)
      reject(new Error(`target exited early with code ${code}`))
    })
  })

  return {
    proc,
    exit: () => new Promise((resolve) => {
      if (proc.killed || proc.exitCode !== null) return resolve()
      proc.on('exit', () => resolve())
      proc.kill()
    }),
  }
}

// ─── Mypry client ───

export interface MypryClient {
  proc: ChildProcess
  nextLine: (timeoutMs?: number) => Promise<any>
  command: (cmd: Record<string, unknown>) => Promise<any>
  exit: () => Promise<void>
}

export async function attachMypry(
  opts: { port: number; host?: string }
): Promise<MypryClient> {
  const proc = spawn('node', [
    MYPRY_CLI, 'attach', '--json',
    '--host', opts.host || '127.0.0.1',
    '--port', String(opts.port),
  ], { stdio: ['pipe', 'pipe', 'pipe'] })

  const lineQueue: any[] = []
  const lineWaiters: Array<(data: any) => void> = []

  const rl: Interface = createInterface({ input: proc.stdout! })
  rl.on('line', (raw: string) => {
    let parsed: any
    try { parsed = JSON.parse(raw) } catch { return }
    if (lineWaiters.length) lineWaiters.shift()!(parsed)
    else lineQueue.push(parsed)
  })

  // Also listen for process exit to unblock waiters
  proc.on('exit', () => {
    while (lineWaiters.length) {
      lineWaiters.shift()!({ _exited: true, status: 'terminated' })
    }
  })

  const nextLine = (timeoutMs = 10000): Promise<any> => new Promise((resolve, reject) => {
    if (lineQueue.length) return resolve(lineQueue.shift())
    const timer = setTimeout(() => reject(new Error('timeout waiting for mypry response')), timeoutMs)
    lineWaiters.push((data) => { clearTimeout(timer); resolve(data) })
  })

  const command = (cmd: Record<string, unknown>): Promise<any> => {
    proc.stdin!.write(JSON.stringify(cmd) + '\n')
    return nextLine()
  }

  const exit = (): Promise<void> => new Promise((resolve) => {
    if (proc.killed || proc.exitCode !== null) return resolve()
    const timer = setTimeout(() => { proc.kill(); resolve() }, 3000)
    proc.on('exit', () => { clearTimeout(timer); resolve() })
    // Try graceful quit first
    try { proc.stdin!.write(JSON.stringify({ op: 'quit' }) + '\n') } catch {}
  })

  return { proc, nextLine, command, exit }
}
