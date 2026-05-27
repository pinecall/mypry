/**
 * MCP Bridge — stateless proxy to mypry HTTP daemon.
 *
 * This is a thin MCP server that translates tool calls into HTTP requests
 * to a running mypry daemon. It starts instantly (never blocks) and
 * requires zero state management.
 *
 * Architecture:
 *   Antigravity → (stdio) → MCP Bridge → (HTTP) → mypry daemon → (CDP) → Node.js
 *
 * Start the daemon first:
 *   mypry attach --http-only --port 9229 --http=3098 --workers
 *
 * Then this bridge connects to http://127.0.0.1:3098
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

const DAEMON = process.env.MYPRY_URL || 'http://127.0.0.1:3098'

const TOOLS = [
  { name: 'debugger_state',             op: null, method: 'GET',  path: '/state',       description: 'Get current debugger state — status, file, line, source window, locals.' },
  { name: 'debugger_eval',              op: 'eval',               description: 'Evaluate a JS expression in the current scope.',                 params: ['expr', 'worker'] },
  { name: 'debugger_continue',          op: 'continue',           description: 'Resume execution. Blocks until the next breakpoint fires.',       wait: true },
  { name: 'debugger_step',              op: null,                 description: 'Step: "over", "into", or "out". Returns new state.',              params: ['mode'] },
  { name: 'debugger_pause',             op: 'pause',              description: 'Force-pause a running process.' },
  { name: 'debugger_set_breakpoint',    op: 'set_breakpoint',     description: 'Set a breakpoint. Optional condition expression.',                params: ['file', 'line', 'condition'] },
  { name: 'debugger_remove_breakpoint', op: 'remove_breakpoint',  description: 'Remove a breakpoint by ID.',                                     params: ['id'] },
  { name: 'debugger_list_breakpoints',  op: null, method: 'GET',  path: '/breakpoints', description: 'List all active breakpoints.' },
  { name: 'debugger_backtrace',         op: null, method: 'GET',  path: '/backtrace',   description: 'Get the call stack.' },
  { name: 'debugger_source',            op: 'source',             description: 'Get source code of current file.',                               params: ['file'] },
  { name: 'debugger_trace_start',       op: 'trace_start',        description: 'Start trace mode — auto-resume, collect snapshots silently.',     params: ['maxBuffer'] },
  { name: 'debugger_trace_stop',        op: 'trace_stop',         description: 'Stop trace, return all collected hits.' },
  { name: 'debugger_trace_status',      op: 'trace_status',       description: 'Peek at trace buffer without stopping.' },
  { name: 'debugger_workers',           op: null, method: 'GET',  path: '/workers',     description: 'List worker threads with session IDs.' },
  { name: 'debugger_health',            op: null, method: 'GET',  path: '/health',      description: 'Check if daemon is connected to an inspector.' },
]

// Build MCP tool schemas
const mcpTools = TOOLS.map(t => {
  const properties: Record<string, any> = {}
  if (t.name === 'debugger_step') {
    properties.mode = { type: 'string', enum: ['over', 'into', 'out'], description: 'Step mode' }
  }
  for (const p of (t as any).params || []) {
    if (p === 'expr')      properties.expr      = { type: 'string', description: 'JavaScript expression' }
    if (p === 'file')      properties.file      = { type: 'string', description: 'File path or substring' }
    if (p === 'line')      properties.line      = { type: 'number', description: 'Line number (1-based)' }
    if (p === 'condition') properties.condition  = { type: 'string', description: 'Condition expression (only pause when true)' }
    if (p === 'id')        properties.id        = { type: 'number', description: 'Breakpoint ID' }
    if (p === 'maxBuffer') properties.maxBuffer  = { type: 'number', description: 'Max trace snapshots (default: 100)' }
    if (p === 'worker')    properties.worker     = { type: 'string', description: 'Worker session ID (from debugger_workers)' }
  }
  return {
    name: t.name,
    description: t.description,
    inputSchema: {
      type: 'object' as const,
      properties,
      required: t.name === 'debugger_step' ? ['mode'] :
                t.name === 'debugger_set_breakpoint' ? ['file', 'line'] :
                t.name === 'debugger_eval' ? ['expr'] :
                t.name === 'debugger_remove_breakpoint' ? ['id'] : [],
    },
  }
})

async function callDaemon(tool: typeof TOOLS[number], args: Record<string, any>): Promise<any> {
  // GET endpoints
  if ((tool as any).method === 'GET') {
    const res = await fetch(`${DAEMON}${(tool as any).path}`)
    return res.json()
  }

  // Step → map mode to op
  let op = tool.op
  if (tool.name === 'debugger_step') {
    const m = args.mode
    op = m === 'over' ? 'step_over' : m === 'into' ? 'step_into' : 'step_out'
  }

  // POST /command
  const body: any = { op, ...args }
  if ((tool as any).wait || tool.name === 'debugger_step') {
    body.wait = true  // block until next pause
  }
  delete body.mode  // clean up step mode from body

  const res = await fetch(`${DAEMON}/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
}

async function main() {
  const server = new Server(
    { name: 'mypry-bridge', version: '0.2.0' },
    { capabilities: { tools: {} } }
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: mcpTools,
  }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params
    const tool = TOOLS.find(t => t.name === name)
    if (!tool) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `unknown tool: ${name}` }) }], isError: true }
    }

    try {
      const result = await callDaemon(tool, args as Record<string, any>)
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
    } catch (err: any) {
      const msg = err.cause?.code === 'ECONNREFUSED'
        ? 'mypry daemon not running. Start it with: mypry attach --http-only --http=3098 --workers'
        : err.message
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }], isError: true }
    }
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch(e => { process.stderr.write(`mypry-bridge: ${e.message}\n`); process.exit(1) })
