# Changelog

All notable changes to mypry will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added
- **CI** (`.github/workflows/ci.yml`) covering everything as separate jobs:
  build + fast suite on Node 22/24, `debugger_inject` e2e, fullstack browser
  (Playwright), and Next.js webpack + turbopack breakpoint resolution.
- `tests/integration/inject.test.mjs` and `tests/integration/fullstack.test.mjs`
  (the latter drives the `examples/login-bug` app: browser click → backend
  pause), plus `test:inject` / `test:fullstack` / `test:nextjs` npm scripts.

## [0.2.0] — 2026-06-16

### Added
- **Bounded locals serializer** — pause snapshots (`debugger_state`/`step`/
  `continue`/`browse`) are now depth/breadth/string-capped and summarize noisy
  framework objects (`req`/`res`/sockets/streams/buffers) to one line each. A
  typical Express pause dropped from thousands of lines to under ~100.
- **Secret redaction** — locals whose key looks secret (`password`, `token`,
  `authorization`, `cookie`, `apiKey`, …) render as `[redacted]`.
- **`debugger_state` controls** — `expand` (drill one path unbounded),
  `fullStack` (include framework frames), `depth`/`maxString`/`redact` overrides.
- **justMyCode call stacks** — `node_modules`/`node:`/internal frames are
  hidden by default (`fullStack: true` to opt back in).

### Changed
- **`debugger_eval`** stays unbounded on purpose (the drill-down escape hatch);
  output trimmed to `{ ok, target, value }` with no `null` fields.
- **`debugger_inject`** no longer dumps the full `--require/--import` loader
  command; reports `{ pid, inspectorPort, program }`.
- **`debugger_breakpoints`** lists `{ id, file, line, kind, condition? }`.
- **`debugger_browse`** waits for the real `Debugger.paused` event (armed
  before the action) instead of a fixed sleep.
- **serverInfo version** is read from `package.json` at runtime (can't drift).

### Removed
- **AgentScript DSL** (`browser/parser.ts`, `browser/runtime.ts`, the
  `browser_run` tool, and the deprecated `script` param on `debugger_browse`).
  Browser automation is JSON actions only.
- Stale `dist-test/` parallel build, its `tsconfig.test.json`, and the old
  Aurora/NDJSON test suite.

### Fixed
- **Turbopack breakpoints** now resolve. Turbopack bundles several modules into
  one hash-named chunk (`chunks/_HASH._.js`); the file→chunk mapping lives only
  in the chunk's *sectioned* source map, not the URL. The resolver now scans
  each chunk's map (and matches on full path, so the many `route.ts` files no
  longer collide) instead of guessing from the hash URL.
- **Reverse source-map resolution for external `.map` files.** `loadSourceMap`
  now strips the `file://` prefix before reading from disk, so paused frames in
  Turbopack chunks display the original `.ts` path instead of the compiled
  chunk. (Webpack uses inline maps and was unaffected.)

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
