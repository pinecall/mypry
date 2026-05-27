/**
 * MCP Bridge — stateless proxy to mypry HTTP daemon.
 *
 * Translates MCP tool calls into HTTP requests to a running mypry daemon.
 * Starts instantly (never blocks). Zero state management.
 *
 * Architecture:
 *   Antigravity → (stdio) → MCP Bridge → (HTTP) → mypry daemon → (CDP) → Node.js
 *
 * Configure target via MYPRY_URL env var:
 *   Standalone daemon:  MYPRY_URL=http://127.0.0.1:3098        (default)
 *   Aurora TUI:         MYPRY_URL=http://127.0.0.1:3099/api/debugger
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

const DAEMON = process.env.MYPRY_URL || 'http://127.0.0.1:3098'

// ── Tool definitions ──
// Every tool maps to: POST {DAEMON}/command  {op, ...params}
// This works with both standalone mypry and Aurora TUI.

interface ToolDef {
  name: string
  op: string             // the op name sent to /command
  description: string
  params?: string[]      // optional param names
  wait?: boolean         // send wait:true for blocking ops
}

const TOOLS: ToolDef[] = [
  { name: 'debugger_state',             op: 'state',             description: 'Get current debugger state — status, file, line, source window, locals.' },
  { name: 'debugger_eval',              op: 'eval',              description: 'Evaluate a JS expression in the current scope.',                 params: ['expr', 'worker'] },
  { name: 'debugger_continue',          op: 'continue',          description: 'Resume execution. Blocks until the next breakpoint fires.',       wait: true },
  { name: 'debugger_step_over',         op: 'step_over',         description: 'Step to the next line. Returns new state.',                       wait: true },
  { name: 'debugger_step_into',         op: 'step_into',         description: 'Step into a function call. Returns new state.',                   wait: true },
  { name: 'debugger_step_out',          op: 'step_out',          description: 'Step out of the current function. Returns new state.',            wait: true },
  { name: 'debugger_pause',             op: 'pause',             description: 'Force-pause a running process.' },
  { name: 'debugger_set_breakpoint',    op: 'set_breakpoint',    description: 'Set a breakpoint. Optional condition expression.',                params: ['file', 'line', 'condition'] },
  { name: 'debugger_remove_breakpoint', op: 'remove_breakpoint', description: 'Remove a breakpoint by ID.',                                     params: ['id'] },
  { name: 'debugger_list_breakpoints',  op: 'breakpoints',       description: 'List all active breakpoints.' },
  { name: 'debugger_backtrace',         op: 'backtrace',         description: 'Get the call stack.' },
  { name: 'debugger_source',            op: 'source',            description: 'Get source code of current file.',                               params: ['file'] },
  { name: 'debugger_trace_start',       op: 'trace_start',       description: 'Start trace mode — auto-resume, collect snapshots silently.',     params: ['maxBuffer'] },
  { name: 'debugger_trace_stop',        op: 'trace_stop',        description: 'Stop trace, return all collected hits.' },
  { name: 'debugger_trace_status',      op: 'trace_status',      description: 'Peek at trace buffer without stopping.' },
  { name: 'debugger_workers',           op: 'workers',           description: 'List worker threads with session IDs.' },
]

// Build MCP tool schemas from definitions
const mcpTools = TOOLS.map(t => {
  const properties: Record<string, any> = {}
  const required: string[] = []

  for (const p of t.params || []) {
    if (p === 'expr')      { properties.expr      = { type: 'string', description: 'JavaScript expression' };           required.push('expr') }
    if (p === 'file')      { properties.file      = { type: 'string', description: 'File path or substring' };          required.push('file') }
    if (p === 'line')      { properties.line      = { type: 'number', description: 'Line number (1-based)' };           required.push('line') }
    if (p === 'condition') { properties.condition  = { type: 'string', description: 'Condition expression (pause only when true)' } }
    if (p === 'id')        { properties.id        = { type: 'number', description: 'Breakpoint ID' };                   required.push('id') }
    if (p === 'maxBuffer') { properties.maxBuffer  = { type: 'number', description: 'Max trace snapshots (default: 100)' } }
    if (p === 'worker')    { properties.worker     = { type: 'string', description: 'Worker session ID (from debugger_workers)' } }
  }

  return {
    name: t.name,
    description: t.description,
    inputSchema: { type: 'object' as const, properties, required },
  }
})

// ── HTTP proxy ──

async function callDaemon(tool: ToolDef, args: Record<string, any>): Promise<any> {
  const body: any = { op: tool.op, ...args }
  if (tool.wait) body.wait = true

  const res = await fetch(`${DAEMON}/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
}

// ── MCP server ──

async function main() {
  const server = new Server(
    { name: 'mypry-bridge', version: '0.3.0' },
    { capabilities: { tools: {} } }
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: mcpTools }))

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
        ? `mypry daemon not running on ${DAEMON}. Start it: mypry attach --http-only --http=3098 --workers`
        : err.message
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }], isError: true }
    }
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch(e => { process.stderr.write(`mypry-bridge: ${e.message}\n`); process.exit(1) })
