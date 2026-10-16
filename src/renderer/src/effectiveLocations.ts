import type { GraphEdge, StoryNode } from './types'

export interface EffectiveLocation {
  placeId: string
  /** location が空欄で、親から遡って受け継いだ場所 */
  inherited: boolean
}

/** 実効ロケーション: location が空欄なら親を遡って直近の場所を使う
 *  (backend の Store.effective_location と同じ規則。グラフは手元にあるので
 *  ここで解決して、ノード 1 つずつ問い合わせない)。フローチャートのカードと
 *  資料庫の「使われている場面」で共用する */
export function resolveEffectiveLocations(
  nodes: StoryNode[],
  edges: GraphEdge[]
): Record<string, EffectiveLocation | null> {
  const parentOf: Record<string, string> = {}
  for (const e of edges) parentOf[e.to_node] = e.from_node
  const own: Record<string, string | null> = {}
  for (const n of nodes) own[n.id] = n.location || null
  const resolved: Record<string, EffectiveLocation | null> = {}
  for (const n of nodes) {
    if (own[n.id]) {
      resolved[n.id] = { placeId: own[n.id]!, inherited: false }
      continue
    }
    let current: string | undefined = parentOf[n.id]
    const seen = new Set<string>([n.id])
    let found: string | null = null
    while (current && !seen.has(current)) {
      seen.add(current)
      if (own[current]) {
        found = own[current]
        break
      }
      current = parentOf[current]
    }
    resolved[n.id] = found ? { placeId: found, inherited: true } : null
  }
  return resolved
}
