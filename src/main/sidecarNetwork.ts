import { createConnection, createServer } from 'node:net'

/** Windows の bind 成功だけでは既存サーバーとの競合を検出できないため、先に接続する。 */
export function isPortInUse(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host })
    const finish = (occupied: boolean): void => {
      socket.destroy()
      resolve(occupied)
    }
    socket.once('connect', () => finish(true))
    socket.once('error', (error: NodeJS.ErrnoException) => {
      // 接続拒否と未対応のアドレス以外は、安全側に倒してこのポートを避ける。
      finish(!['ECONNREFUSED', 'EAFNOSUPPORT', 'EADDRNOTAVAIL', 'ENETUNREACH'].includes(error.code ?? ''))
    })
    socket.setTimeout(500, () => finish(true))
  })
}

export async function findAvailablePort(startPort: number, count = 20): Promise<number> {
  for (let port = startPort; port < startPort + count; port += 1) {
    const occupied = await Promise.all([
      isPortInUse(port, '127.0.0.1'),
      isPortInUse(port, '::1')
    ])
    if (occupied.some(Boolean)) continue
    const available = await new Promise<boolean>((resolve) => {
      const server = createServer()
      server.once('error', () => resolve(false))
      server.once('listening', () => server.close(() => resolve(true)))
      server.listen({ port, host: '127.0.0.1', exclusive: true })
    })
    if (available) return port
  }
  throw new Error(`バックエンド用の空きポートがありません (${startPort}–${startPort + count - 1})`)
}

/** HTTP 200 だけでは、別アプリの HTML やヘルスチェックを再利用してしまう。 */
export async function isStoryGraphHealthy(baseUrl: string, timeoutMs = 1000): Promise<boolean> {
  const signal = AbortSignal.timeout(timeoutMs)
  try {
    const res = await fetch(`${baseUrl}/health`, { signal })
    if (!res.ok) return false
    const health = await res.json()
    if (health?.status !== 'ok') return false
    if (health.service === 'story-graph') return true
    if (health.service !== undefined) return false
    // 更新前から起動しているバックエンドには service が無い。API 定義で確認する。
    const spec = await fetch(`${baseUrl}/openapi.json`, { signal })
    if (!spec.ok) return false
    const schema = await spec.json()
    return schema?.info?.title === 'story-graph backend'
  } catch {
    return false
  }
}
