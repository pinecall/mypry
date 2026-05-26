/**
 * CDPClient — minimal Chrome DevTools Protocol client over WebSocket.
 * Zero dependencies. Uses Node 22+ global WebSocket.
 *
 * Mechanical translation from mypry.js lines 15-74.
 * DO NOT change behavior — this is load-bearing.
 */

type PendingEntry = {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
}

type EventHandler = (params: unknown) => void

export class CDPClient {
  wsUrl: string
  ws!: WebSocket
  nextId: number
  pending: Map<number, PendingEntry>
  eventHandlers: Map<string, EventHandler[]>
  closed: boolean

  constructor(wsUrl: string) {
    this.wsUrl = wsUrl
    this.nextId = 0
    this.pending = new Map()
    this.eventHandlers = new Map()
    this.closed = false
  }

  async connect(): Promise<void> {
    this.ws = new WebSocket(this.wsUrl)
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => { cleanup(); resolve() }
      const onError = () => { cleanup(); reject(new Error('websocket error')) }
      const cleanup = () => {
        this.ws.removeEventListener('open', onOpen)
        this.ws.removeEventListener('error', onError)
      }
      this.ws.addEventListener('open', onOpen)
      this.ws.addEventListener('error', onError)
    })
    this.ws.addEventListener('message', (ev: MessageEvent) => this._onMessage(ev.data as string))
    this.ws.addEventListener('close', () => {
      this.closed = true
      for (const { reject } of this.pending.values()) reject(new Error('connection closed'))
      this.pending.clear()
      const handlers = this.eventHandlers.get('__close__') || []
      for (const h of handlers) h(undefined)
    })
  }

  _onMessage(data: string): void {
    const msg = JSON.parse(data)
    if (msg.id != null) {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(`${msg.error.code}: ${msg.error.message}`))
      else p.resolve(msg.result)
    } else if (msg.method) {
      const handlers = this.eventHandlers.get(msg.method) || []
      for (const h of handlers) h(msg.params)
    }
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  on(method: string, handler: EventHandler): void {
    if (!this.eventHandlers.has(method)) this.eventHandlers.set(method, [])
    this.eventHandlers.get(method)!.push(handler)
  }

  onClose(handler: () => void): void { this.on('__close__', handler as EventHandler) }
}
