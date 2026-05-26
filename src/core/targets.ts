/**
 * Target discovery — resolves WebSocket URLs from Node and Chrome inspectors.
 *
 * Node:   /json returns targets with type "node"
 * Chrome: /json returns targets with type "page", "background_page", etc.
 */

export type TargetKind = 'node' | 'chrome'

export interface TargetDescriptor {
  kind: TargetKind
  wsUrl: string
  title?: string
  url?: string
}

export async function discoverTargets(
  host: string,
  port: number
): Promise<TargetDescriptor[]> {
  const connectHost = host === '0.0.0.0' ? '127.0.0.1' : host
  const res = await fetch(`http://${connectHost}:${port}/json`)
  const list = await res.json() as any[]
  return list
    .filter((entry: any) => entry.webSocketDebuggerUrl)
    .map((entry: any) => {
      let wsUrl = entry.webSocketDebuggerUrl
      if (wsUrl.includes('0.0.0.0')) wsUrl = wsUrl.replace('0.0.0.0', connectHost)
      return {
        kind: entry.type === 'node' ? 'node' as TargetKind : 'chrome' as TargetKind,
        wsUrl,
        title: entry.title,
        url: entry.url,
      }
    })
}

/**
 * Find a target matching the given selectors.
 * Returns the first match, or null.
 */
export function matchTarget(
  targets: TargetDescriptor[],
  opts: { tab?: string; tabUrl?: string }
): TargetDescriptor | null {
  if (opts.tab) {
    const needle = opts.tab.toLowerCase()
    const match = targets.find(t =>
      t.title?.toLowerCase().includes(needle)
    )
    if (match) return match
  }
  if (opts.tabUrl) {
    const needle = opts.tabUrl.toLowerCase()
    const match = targets.find(t =>
      t.url?.toLowerCase().includes(needle)
    )
    if (match) return match
  }
  return null
}
