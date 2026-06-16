/**
 * Browser toolkit — thin Playwright wrapper for mypry's fullstack debugger.
 *
 * Internal module. Owns the browser session lifecycle and the ARIA snapshot.
 * Page interaction itself goes through the JSON action runner in actions.ts
 * (driven by fullstack-toolkit's debugger_browse), not this kit.
 */

import { Session } from './session.js';

// ── Tool definitions (internal API — used by fullstack-toolkit.ts) ──

export const BROWSER_TOOLS = [
  {
    name: 'browser_connect',
    description:
      'Open or attach a browser session. Prefer cdpEndpoint to attach to an already-open Chrome (launched with --remote-debugging-port=9222), which preserves your logins and cookies. Without it, a fresh browser is launched.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        cdpEndpoint: { type: 'string', description: 'CDP endpoint, e.g. http://localhost:9222' },
        headless: { type: 'boolean', description: 'Launch headless (ignored when cdpEndpoint is set)' },
        pageUrlMatch: { type: 'string', description: 'With CDP: regex to pick which existing tab to use' },
      },
    },
  },
  {
    name: 'browser_snapshot',
    description:
      'Capture an accessibility (ARIA) snapshot of the current page as YAML. Every interactive element gets a stable description you can use as a selector in browser actions. Re-snapshot after navigation.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        scope: { type: 'string', description: 'CSS selector to scope the snapshot (default: whole body)' },
      },
    },
  },
  {
    name: 'browser_disconnect',
    description: 'Close (if launched) or detach (if CDP) the browser session and clear state.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
] as const;

// ── Tool result types ──

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}


// ── BrowserToolKit — self-contained, embeddable ──

export class BrowserToolKit {
  private session: Session | null = null;

  /** Tool definitions — pass these to your MCP server's tool list. */
  get tools() {
    return BROWSER_TOOLS;
  }

  /** Dispatch a tool call by name. */
  async call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    try {
      switch (name) {
        case 'browser_connect':
          return this.handleConnect(args);
        case 'browser_snapshot':
          return this.handleSnapshot(args);
        case 'browser_disconnect':
          return this.handleDisconnect();
        default:
          throw new Error(`unknown browser tool: ${name}`);
      }
    } catch (e: any) {
      return this.err(e?.message ?? String(e));
    }
  }

  /** Check if a tool name belongs to this kit. */
  handles(name: string): boolean {
    return BROWSER_TOOLS.some(t => t.name === name);
  }

  /** Clean up (close browser). */
  async dispose(): Promise<void> {
    if (this.session) {
      await this.session.close().catch(() => {});
      this.session = null;
    }
  }

  // ── handlers ──

  private requireSession(): Session {
    if (!this.session) throw new Error('no active browser session — call browser_connect first');
    return this.session;
  }

  /** Expose the Playwright page for direct evaluation by embedders (e.g. mypry). */
  get page() {
    return this.session?.page ?? null;
  }

  private async handleConnect(args: Record<string, unknown>): Promise<ToolResult> {
    if (this.session) await this.session.close().catch(() => {});
    const cdp = (args.cdpEndpoint as string) ?? process.env.AGENTSCRIPT_CDP;
    this.session = await Session.open({
      cdpEndpoint: cdp,
      headless: (args.headless as boolean) ?? process.env.AGENTSCRIPT_HEADLESS === '1',
      pageUrlMatch: args.pageUrlMatch as string,
    });
    const url = this.session.page.url();
    return this.okJson({ connected: true, mode: cdp ? `cdp:${cdp}` : 'launched', url });
  }

  private async handleSnapshot(args: Record<string, unknown>): Promise<ToolResult> {
    const s = this.requireSession();
    const { yaml } = await s.snapshot(args.scope as string);
    return {
      content: [{ type: 'text' as const, text: yaml }],
    };
  }

  private async handleDisconnect(): Promise<ToolResult> {
    if (this.session) {
      await this.session.close().catch(() => {});
      this.session = null;
    }
    return this.okJson({ disconnected: true });
  }

  // ── helpers ──

  private okJson(data: unknown): ToolResult {
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  }

  private err(message: string): ToolResult {
    return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
  }
}
