#!/usr/bin/env node
/**
 * mypry MCP server — standalone, zero-setup, for AI agents.
 *
 * No daemon needed. No mypry serve. No mypry attach.
 * Just configure this as your MCP server and the agent calls
 * debugger_connect to start everything.
 *
 * Config:
 *   { "mypry": { "command": "mypry-bridge" } }
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { DebuggerToolKit, DEBUGGER_INSTRUCTIONS } from './fullstack-toolkit.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

async function main() {
  const kit = new DebuggerToolKit()

  const server = new Server(
    { name: 'mypry', version: '0.3.0' },
    {
      capabilities: { tools: {} },
      instructions: DEBUGGER_INSTRUCTIONS,
    }
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: kit.tools,
  }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params
    return kit.call(name, args as any)
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)

  process.on('SIGINT', async () => {
    await kit.dispose()
    process.exit(0)
  })
}

main().catch(e => { process.stderr.write(`mypry: ${e.message}\n`); process.exit(1) })
