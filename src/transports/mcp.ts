/**
 * MCP (Model Context Protocol) transport — stdio server.
 *
 * Exposes mypry as an MCP server for Claude Code, Cursor, Antigravity, etc.
 * Invocation: mypry attach --mcp
 *
 * Tool design: "fewer richer tools" — every state-changing tool
 * returns a full snapshot so the agent gets context in one round-trip.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { EventEmitter } from 'node:events'
import type { DebuggerSession } from '../core/session.js'
import { snapshot, cleanUrl } from '../core/snapshot.js'
import { executeOp } from '../core/ops.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface McpServerOptions {
  /** Optional pair-programming side channel — emits every agent action */
  pairChannel?: EventEmitter
  /** Worker sessions (from --workers flag) */
  workerSessions?: Map<string, { info: any, session: DebuggerSession }>
}

const TOOLS = [
  {
    name: 'debugger_state',
    description: 'Get current debugger state — status, file, line, source window, locals, and stack frame info. Use this to orient yourself.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'debugger_step',
    description: 'Step execution: "over" (next line), "into" (enter function), or "out" (exit function). Returns the new state after stepping.',
    inputSchema: {
      type: 'object' as const,
      required: ['mode'],
      properties: {
        mode: { type: 'string', enum: ['over', 'into', 'out'], description: 'Step mode' },
      },
    },
  },
  {
    name: 'debugger_continue',
    description: 'Resume execution until the next breakpoint or program termination. Returns the new state or {status: "terminated"}.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'debugger_eval',
    description: 'Evaluate a JavaScript expression in the current call frame scope. Returns the result value and type.',
    inputSchema: {
      type: 'object' as const,
      required: ['expr'],
      properties: {
        expr: { type: 'string', description: 'JavaScript expression to evaluate' },
        worker: { type: 'string', description: 'Optional: worker sessionId to eval in (from debugger_workers)' },
      },
    },
  },
  {
    name: 'debugger_set_breakpoint',
    description: 'Set a breakpoint at a file and line number. Optionally add a condition — the breakpoint only pauses when the condition expression evaluates to true.',
    inputSchema: {
      type: 'object' as const,
      required: ['file', 'line'],
      properties: {
        file: { type: 'string', description: 'File path or substring to match' },
        line: { type: 'number', description: 'Line number (1-based)' },
        condition: { type: 'string', description: 'Optional JS condition expression — breakpoint only fires when true (e.g. "user.role === \'admin\'"' },
      },
    },
  },
  {
    name: 'debugger_list_breakpoints',
    description: 'List all active breakpoints with their IDs, files, and line numbers.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'debugger_remove_breakpoint',
    description: 'Remove a breakpoint by its numeric ID.',
    inputSchema: {
      type: 'object' as const,
      required: ['id'],
      properties: {
        id: { type: 'number', description: 'Breakpoint ID to remove' },
      },
    },
  },
  {
    name: 'debugger_pause',
    description: 'Force-pause a running program. Returns the state at the pause location.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'debugger_backtrace',
    description: 'Get the current call stack (backtrace) with function names, files, and line numbers.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'debugger_source',
    description: 'Get the full source code of the current file and the current line number.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        file: { type: 'string', description: 'Optional: specific file to view source of' },
      },
    },
  },
  // ─── New: Trace Mode ───
  {
    name: 'debugger_trace_start',
    description: 'Start trace mode — breakpoints will auto-resume and silently collect snapshots instead of pausing. The app keeps running. Use debugger_trace_stop to collect results.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        maxBuffer: { type: 'number', description: 'Max snapshots to keep in buffer (default: 100)' },
      },
    },
  },
  {
    name: 'debugger_trace_stop',
    description: 'Stop trace mode and return all collected snapshot hits. Each hit includes timestamp, file, line, function, and locals.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'debugger_trace_status',
    description: 'Check trace status and peek at collected hits without stopping the trace.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  // ─── New: Workers ───
  {
    name: 'debugger_workers',
    description: 'List all discovered worker threads with their session IDs. Use the sessionId in other tools (via the "worker" parameter) to debug a specific worker.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
]

export async function runMcp(
  session: DebuggerSession,
  opts: McpServerOptions = {}
): Promise<void> {
  const server = new Server(
    { name: 'mypry', version: '0.2.0' },
    { capabilities: { tools: {} } }
  )

  /** Resolve session: main or worker */
  function resolveSession(args: any): DebuggerSession {
    if (args?.worker && opts.workerSessions) {
      const ws = opts.workerSessions.get(args.worker)
      if (!ws) throw new Error(`worker '${args.worker}' not found`)
      return ws.session
    }
    return session
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params
    opts.pairChannel?.emit('agent-action', { tool: name, args })

    let result: unknown
    try {
      switch (name) {
        case 'debugger_state':
          result = await snapshot(session)
          break

        case 'debugger_step': {
          const mode = (args as any).mode
          if (mode === 'over') await session.stepOver()
          else if (mode === 'into') await session.stepInto()
          else if (mode === 'out') await session.stepOut()
          else throw new Error(`invalid step mode: ${mode}`)

          const frame = session.topFrame()
          if (frame) await session.getSource(frame.location.scriptId)
          result = await snapshot(session)
          break
        }

        case 'debugger_continue': {
          await session.resume()
          const outcome = await Promise.race([
            session.waitNextPause().then(() => 'paused'),
            new Promise<string>((r) => session.cdp.onClose(() => r('terminated'))),
          ])
          if (outcome === 'terminated') {
            result = { status: 'terminated' }
          } else {
            const frame = session.topFrame()
            if (frame) await session.getSource(frame.location.scriptId)
            result = await snapshot(session)
          }
          break
        }

        case 'debugger_eval': {
          const targetSession = resolveSession(args)
          const r = await targetSession.evalInFrame((args as any).expr || '') as any
          if (r.exceptionDetails) {
            result = {
              ok: false,
              error: r.exceptionDetails.text,
              description: r.result?.description,
            }
          } else {
            result = {
              ok: true,
              type: r.result.type,
              value: r.result.value !== undefined ? r.result.value : null,
              description: r.result.description ?? null,
            }
          }
          break
        }

        case 'debugger_set_breakpoint': {
          const file = (args as any).file
          const line = (args as any).line
          const condition = (args as any).condition
          const id = await session.setBreakpoint(file, line, condition)
          result = { ok: true, id, file, line, condition: condition || null }
          break
        }

        case 'debugger_list_breakpoints': {
          result = {
            breakpoints: [...session.breakpoints.entries()].map(([id, bp]) => ({
              id,
              file: bp.file,
              line: bp.line,
              condition: bp.condition || null,
            })),
          }
          break
        }

        case 'debugger_remove_breakpoint': {
          await session.removeBreakpoint((args as any).id)
          result = { ok: true }
          break
        }

        case 'debugger_pause': {
          await session.pause()
          const frame = session.topFrame()
          if (frame) await session.getSource(frame.location.scriptId)
          result = await snapshot(session)
          break
        }

        case 'debugger_backtrace': {
          const frames = (session.currentPause?.callFrames || []).map((f: any) => ({
            function: f.functionName || '<anon>',
            file: cleanUrl(session.scripts.get(f.location.scriptId)?.url),
            line: f.location.lineNumber + 1,
          }))
          result = { frames }
          break
        }

        case 'debugger_source': {
          const frame = session.topFrame()
          if (!frame) throw new Error('not paused')
          const s = await session.getSource(frame.location.scriptId)
          result = {
            file: cleanUrl(s?.url),
            source: s?.source || '',
            current_line: frame.location.lineNumber + 1,
          }
          break
        }

        // ─── Trace Mode ───
        case 'debugger_trace_start':
          result = await executeOp(session, 'trace_start', args as any)
          break

        case 'debugger_trace_stop':
          result = await executeOp(session, 'trace_stop')
          break

        case 'debugger_trace_status':
          result = await executeOp(session, 'trace_status')
          break

        // ─── Workers ───
        case 'debugger_workers': {
          const workers = opts.workerSessions || new Map()
          const list = Array.from(workers.entries()).map(([id, { info }]) => ({
            sessionId: id,
            title: info.title,
            url: info.url,
          }))
          result = { workers: list, count: list.length }
          break
        }

        default:
          throw new Error(`unknown tool: ${name}`)
      }
    } catch (err: any) {
      opts.pairChannel?.emit('agent-error', { tool: name, error: err.message })
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ error: err.message }),
        }],
        isError: true,
      }
    }

    opts.pairChannel?.emit('agent-result', { tool: name, result })
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(result, null, 2),
      }],
    }
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

// Exported for embedders: import { startMcpServer } from 'mypry/mcp'
export { runMcp as startMcpServer }
