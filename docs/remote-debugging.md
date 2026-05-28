# Remote Debugging

Debug Node.js apps and browser frontends running on remote servers — staging, CI, containers, VMs — from your local machine.

---

## Architecture

```
┌─ YOUR MACHINE ──────────────────────┐     ┌─ REMOTE SERVER ─────────────────┐
│                                     │     │                                  │
│  Agent ── MCP bridge ── HTTP ──────────▶  │  mypry daemon ── CDP ──▶ Node.js │
│           MYPRY_URL=               │     │  0.0.0.0:3098    :9229           │
│           http://server:3098        │     │                                  │
│                                     │     │       (optional)                 │
│  mypry watch ── SSE ───────────────────▶  │               ── CDP ──▶ Chrome  │
│                                     │     │                  :9222           │
└─────────────────────────────────────┘     └──────────────────────────────────┘
```

---

## Backend only (most common)

### On the remote server

```bash
# 1. Start your app with the inspector open
node --inspect=0.0.0.0:9229 server.js

# 2. Start the mypry daemon, binding to all interfaces
mypry serve --host 0.0.0.0
```

> ⚠️ **Security:** `--inspect=0.0.0.0` and `--host 0.0.0.0` expose the inspector and daemon to the network. Always use `--token` in production, and prefer SSH tunneling for sensitive environments.

### On your machine

Point the MCP bridge at the remote daemon:

```json
{
  "mcpServers": {
    "mypry": {
      "command": "mypry-bridge",
      "env": { "MYPRY_URL": "http://staging-server:3098" }
    }
  }
}
```

Your agent now has full `debugger_*` tools against the remote process.

```bash
# Monitor remotely too
mypry watch --port 3098 --host staging-server
```

### Real session transcript

This was tested against a GCP VM (`34.123.241.2` / `blossomcrmuat`) from a Mac in Buenos Aires, over SSH tunnel. The demo app has a `debugger` statement inside `authenticate()`.

```bash
# SSH tunnel (local 3099 → remote 3099)
ssh -L 3099:localhost:3099 -i ~/.ssh/google_compute_engine berna@34.123.241.2
```

```
→ health
← { "ok": true, "connected": true, "status": "running" }

→ eval { "expr": "process.version" }
← { "ok": true, "value": "v20.19.5" }

→ eval { "expr": "Math.floor(process.uptime()) + 's'" }
← { "ok": true, "value": "274s" }

→ set_breakpoint { "file": "server.mjs", "line": 12 }
← { "ok": true, "id": 1 }

(trigger POST /login on the server via SSH)

→ state
← {
    "status": "paused",
    "file": "/home/berna/mypry-remote-demo/server.mjs",
    "line": 12,
    "function": "authenticate",
    "source_window": [
      { "line": 10, "text": "  const user = users.find(u => u.email === email)" },
      { "line": 11, "text": "  const isValid = user && password === 'secret'" },
      { "line": 12, "text": "  debugger  // ← mypry will pause here", "current": true },
      { "line": 13, "text": "  return isValid ? user : null" }
    ],
    "locals": {
      "email": "berna@shipway.dev",
      "password": "secret",
      "user": "Object",
      "isValid": true
    }
  }

→ eval { "expr": "email" }
← { "ok": true, "type": "string", "value": "berna@shipway.dev" }

→ eval { "expr": "user" }
← { "ok": true, "type": "object", "value": {
    "id": 3, "name": "Berna", "email": "berna@shipway.dev", "role": "superadmin"
  }}

→ eval { "expr": "isValid" }
← { "ok": true, "type": "boolean", "value": true }

→ backtrace
← { "frames": [
    { "function": "authenticate", "file": "server.mjs", "line": 12 },
    { "function": "<anon>", "file": "server.mjs", "line": 42 }
  ]}

→ continue
← { "status": "running" }

(login response: { "ok": true, "user": { "id": 3, "name": "Berna", "role": "superadmin" } })
```

The agent paused a process on a different continent, inspected every local variable, read the call stack, and resumed — all through an SSH tunnel. Zero code changes.

---

## Fullstack: local Chrome + remote backend

Open Chrome **locally** pointed at the remote frontend URL. mypry connects to the local Chrome's CDP and the remote backend's inspector.

### On the remote server

```bash
node --inspect=0.0.0.0:9229 server.js
```

### On your machine

```bash
mypry serve --host staging-server --frontend http://staging-server:3001
```

This will:
1. Connect to the remote Node.js inspector at `staging-server:9229`
2. Launch a local Chrome navigating to `http://staging-server:3001`
3. Connect to the local Chrome's CDP at `127.0.0.1:9222`

Your agent uses `target: "frontend"` and `target: "backend"` as usual — the routing is transparent.

---

## Fullstack: remote Chrome (headless)

When there's no display (CI, containers, headless servers), run Chrome on the server and connect to its CDP remotely.

### On the remote server

```bash
# 1. Start your app
node --inspect=0.0.0.0:9229 server.js

# 2. Start headless Chrome with remote debugging
google-chrome --headless --remote-debugging-address=0.0.0.0 --remote-debugging-port=9222 \
  --no-first-run --no-sandbox http://localhost:3001
```

### On your machine

```bash
mypry serve --host staging-server --chrome-host staging-server:9222
```

This skips launching local Chrome and connects directly to the remote Chrome's CDP.

### Using `.mypry.json`

```json
{
  "host": "staging-server",
  "chromeHost": "staging-server:9222"
}
```

```bash
mypry serve    # reads config, connects to both remote targets
```

---

## SSH tunneling (recommended for production)

Instead of exposing ports to the network, tunnel everything through SSH:

```bash
# Forward the inspector and daemon ports
ssh -L 9229:localhost:9229 -L 3098:localhost:3098 user@staging-server
```

On the server, keep everything on `127.0.0.1` (the default):

```bash
node --inspect server.js       # binds to 127.0.0.1:9229
mypry serve                    # binds to 127.0.0.1:3098
```

On your machine, the MCP bridge connects to `localhost:3098` as if it were local — the SSH tunnel handles the rest.

```json
{
  "mcpServers": {
    "mypry": {
      "command": "mypry-bridge"
    }
  }
}
```

> **This is the most secure option.** No ports exposed, no tokens needed, encrypted transport.

### With remote Chrome (headless)

Add the Chrome CDP port to the tunnel:

```bash
ssh -L 9229:localhost:9229 -L 3098:localhost:3098 -L 9222:localhost:9222 user@staging-server
```

```bash
# On your machine
mypry serve --chrome-host 127.0.0.1:9222
```

---

## Docker / containers

### Dockerfile

```dockerfile
FROM node:22-slim

# Install Chrome for frontend debugging (optional)
RUN apt-get update && apt-get install -y chromium --no-install-recommends

WORKDIR /app
COPY . .
RUN npm install

# Expose inspector + mypry daemon
EXPOSE 9229 3098

CMD ["node", "--inspect=0.0.0.0:9229", "server.js"]
```

### docker-compose.yml

```yaml
services:
  app:
    build: .
    ports:
      - "3098:3098"
      - "9229:9229"
    command: >
      sh -c "node --inspect=0.0.0.0:9229 server.js &
             npx mypry serve --host 0.0.0.0 --token s3cr3t &&
             wait"
```

### Connect from your machine

```bash
MYPRY_URL=http://localhost:3098 mypry watch
```

---

## `.mypry.json` for remote setups

```json
{
  "host": "staging-server",
  "port": 3098,
  "inspect": 9229,
  "chromeHost": "staging-server:9222",
  "token": "s3cr3t"
}
```

| Key | Purpose |
|-----|---------|
| `host` | Backend inspector host (where Node.js runs) |
| `chromeHost` | Chrome CDP `host:port` (skip local Chrome launch) |
| `token` | Auth token (always use for remote) |

---

## Security checklist

| ✅ | Item |
|----|------|
| | Use `--token` on exposed daemons |
| | Prefer SSH tunneling over open ports |
| | Never expose `--inspect` without auth in production |
| | Use `--host 0.0.0.0` only when necessary |
| | Firewall inspector (9229) and daemon (3098) ports |
| | Consider read-only tokens (`viewer:ro`) for monitoring |
