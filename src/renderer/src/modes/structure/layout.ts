import type { GraphEdge, StoryGraph } from '../../types'

// 配置のグリッド。背景のドットの間隔と同じにして、スナップ先が目で見える状態にする
export const GRID_SIZE = 20
export const COLUMN_GAP_X = 340 // カード幅(w-72 = 288)+ 余白。グリッドの倍数にする
export const LANE_GAP_Y = 60 // レーン間の余白(同上)
export const FALLBACK_NODE_HEIGHT = 160
export const NODE_WIDTH = 288 // カード幅(w-72)。重なり判定に使う

/** グリッドに合わせた座標。整列や自動配置の結果も、手で動かしたときと同じ目に乗せる */
export const snapped = (value: number): number => Math.round(value / GRID_SIZE) * GRID_SIZE

// ---- DAG レイアウト(正史は左から右へ一直線、分岐は下のレーンへ) ------
// カード幅は固定なので x は深さで決まる。y はレーンごとに、そのレーンの
// 実測最大高さを積み上げて決める(カード高さは画像や本文量で変わるため)

// 章ビューの整列では「章カードを 1 枚のノードに畳んだ導出グラフ」を渡すので、
// 引数は id と端点だけを見る形にしてある(実ノードでなくても並べられる)
export function layoutDag(
  nodes: Array<{ id: string }>,
  edges: Array<Pick<GraphEdge, 'from_node' | 'to_node' | 'is_canon'>>,
  heights: Record<string, number>
): Record<string, { x: number; y: number }> {
  const childrenMap: Record<string, Array<{ id: string; canon: boolean }>> = {}
  const hasParent = new Set<string>()
  for (const e of edges) {
    ;(childrenMap[e.from_node] ??= []).push({ id: e.to_node, canon: !!e.is_canon })
    hasParent.add(e.to_node)
  }
  const order = new Map(nodes.map((n, i) => [n.id, i]))
  const placed: Record<string, { depth: number; lane: number }> = {}
  let laneCounter = 0

  const assign = (id: string, lane: number, depth: number): void => {
    if (placed[id]) return // 循環データでも無限再帰しないように
    placed[id] = { depth, lane }
    const kids = (childrenMap[id] ?? [])
      .slice()
      .sort((a, b) => Number(b.canon) - Number(a.canon) || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    kids.forEach((kid, i) => {
      assign(kid.id, i === 0 ? lane : ++laneCounter, depth + 1)
    })
  }

  const roots = nodes.filter((n) => !hasParent.has(n.id))
  roots.forEach((root, i) => {
    assign(root.id, i === 0 ? 0 : ++laneCounter, 0)
  })

  // レーンごとの最大高さを求めてから、レーンの y を積み上げる
  const laneHeights: number[] = []
  for (const [id, p] of Object.entries(placed)) {
    const height = heights[id] ?? FALLBACK_NODE_HEIGHT
    laneHeights[p.lane] = Math.max(laneHeights[p.lane] ?? 0, height)
  }
  const laneY: number[] = []
  let y = 0
  for (let lane = 0; lane <= laneCounter; lane += 1) {
    laneY[lane] = y
    // カードの高さは実測(グリッドの倍数とは限らない)なので、次のレーンの頭で乗せ直す
    y = snapped(y + (laneHeights[lane] ?? FALLBACK_NODE_HEIGHT) + LANE_GAP_Y)
  }

  const positions: Record<string, { x: number; y: number }> = {}
  for (const [id, p] of Object.entries(placed)) {
    positions[id] = { x: p.depth * COLUMN_GAP_X, y: laneY[p.lane] ?? 0 }
  }
  return positions
}

/** desired に置くと既存のカードに重なるとき、下のレーンへ逃がした座標を返す。
 *
 *  つながりだけを見て置くと、同じ列に居る別の島や分岐のカードの真上に出てしまう
 *  (下敷きになったカードは消えたように見える)。重なりが解けるまで下へ送る。
 */
export function avoidingOverlap(
  desired: { x: number; y: number },
  height: number,
  others: Array<{ x: number; y: number; height: number }>
): { x: number; y: number } {
  let y = desired.y
  // 重なりを解くたびに y は必ず増えるので、この繰り返しは必ず終わる
  for (let i = 0; i < 40; i += 1) {
    const hit = others.find(
      (o) => Math.abs(o.x - desired.x) < NODE_WIDTH && y < o.y + o.height && o.y < y + height
    )
    if (!hit) break
    y = snapped(hit.y + hit.height + LANE_GAP_Y)
  }
  return { x: desired.x, y }
}

/** rootId とその下流のうち、**手動配置のノードだけ**を dx だけ右へずらす座標を返す。
 *
 *  自動配置(pos が NULL)のノードは触らない — 座標を書くとその場に固定されて
 *  しまい、以後の自動レイアウトから外れるため。
 */
export function shiftDownstreamX(
  graph: StoryGraph,
  rootId: string,
  dx: number
): Array<{ id: string; x: number; y: number }> {
  const children: Record<string, string[]> = {}
  for (const e of graph.edges) (children[e.from_node] ??= []).push(e.to_node)
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const moved: Array<{ id: string; x: number; y: number }> = []
  const seen = new Set([rootId])
  const queue = [rootId]
  while (queue.length > 0) {
    const current = queue.shift()!
    const node = byId.get(current)
    if (node && node.pos_x != null && node.pos_y != null) {
      moved.push({ id: current, x: snapped(node.pos_x + dx), y: node.pos_y })
    }
    for (const child of children[current] ?? []) {
      if (!seen.has(child)) {
        seen.add(child)
        queue.push(child)
      }
    }
  }
  return moved
}
