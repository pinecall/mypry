# Changelog

All notable changes to mypry will be documented in this file.

## [0.1.0-beta.1] — 2026-05-28

First public beta release.

### Features

- **Full-stack debugging** — pause, step, and inspect across Node.js backend and Chrome frontend in a single session
- **MCP tools** — 16 debugger tools for AI agents (Antigravity, Claude Code, Cursor, Codex)
- **Source-map-aware breakpoints** — `set_breakpoint("file.ts", line)` resolves to compiled `.js` via source maps (tsc, NestJS, Vite)
- **`mypry serve`** — HTTP daemon with inline live watch output (no separate `mypry watch` needed)
- **`mypry-bridge`** — stateless MCP bridge binary for AI agent integration
- **Trace mode** — non-blocking observation: breakpoints auto-resume and collect snapshots
- **Conditional breakpoints** — pause only when a JS expression is truthy
- **Worker threads** — debug `worker_threads` alongside the main thread
- **Frontend debugging** — Chrome CDP with Vue `ref()` / Pinia `$state` auto-unwrapping
- **Auto-reconnect** — survives `nodemon`, NestJS `--watch`, `ts-node-dev` restarts
- **Remote debugging** — SSH tunnels, `--host 0.0.0.0`, Bearer token auth
- **Project config** — `.mypry.json` for per-project defaults
- **AI agent skill** — drop-in `skills/SKILL.md` for Antigravity, Claude Code, Cursor, Codex

### CLI

- `mypry serve` — daemon + live monitor
- `mypry watch` — remote SSE monitor
- `mypry attach` — interactive REPL
- `mypry open` — launch debug Chrome
- `mypry inject` — enable inspector on running PID
