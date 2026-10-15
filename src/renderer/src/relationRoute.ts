// ---- 関係図の直角エッジのルーティング(グリッド A*)---------------------
// フル版(orthogonal)用。人物の形(アイコン + 名前 + 退場)の周りを通行止めにした
// グリッド上で、上下左右のみの経路を探索する。曲がりと「他のエッジが通済みのセル」に
// コストを付けることで、直進を好みつつ並走エッジが別レーンに分かれる。
// 線のラベルは、人物・他のラベルに重ならず、他の線にもなるべく乗らない位置を選んで
// 線の上に置き、後から引く線はそのラベルを避ける。

export interface Pt {
  x: number
  y: number
}

/** 図の上の人物の形。アイコンの円と、その下の名前(と「退場」)の矩形の和 */
export interface NodeShape {
  x: number
  y: number
  r: number
  box: { x0: number; x1: number; y0: number; y1: number } | null
}

export interface RouteEdge {
  from: string
  to: string
  label?: string
}

const CELL = 10 // グリッド解像度(px)
const CLEAR = 7 // 他の人物の形から線を離す余白
const GAP = 4 // 線の端と人物の形のすき間(矢じりの先端がここに来る)
const TURN_COST = 3
const USAGE_COST = 4
const LABEL_COST = 12 // ラベルの置かれたセルを通るときの税
const MAX_EXPAND = 20000 // A* の安全弁

export const LABEL_FONT = 8.5
export const LABEL_H = 12

/** 文字列の描画幅の見積もり(全角は字の大きさ、半角はその 0.6 倍) */
export function textWidth(text: string, fontSize: number): number {
  let w = 0
  for (const ch of text) w += (ch.codePointAt(0) ?? 0) > 0xff ? fontSize : fontSize * 0.6
  return w
}

/** 線のラベルの背景の幅 */
export function labelWidth(label: string): number {
  return textWidth(label, LABEL_FONT) + 6
}

/** RelationGraph のノードの描き方(アイコン r=21 / 名前 dy=34 / 退場 dy=46 など)に合わせた形 */
export function nodeShape(p: Pt, opts: { portrait: boolean; retired: boolean; name: string }): NodeShape {
  if (opts.portrait) {
    // 円 r=21 + 枠線。名前は 9px で円の下(ベースライン 34)、退場はさらに下(ベースライン 46)
    const half = Math.max(textWidth(opts.name, 9), opts.retired ? 18 : 0) / 2 + 1
    return {
      x: p.x,
      y: p.y,
      r: 23,
      box: {
        x0: p.x - half,
        x1: p.x + half,
        y0: p.y + 25,
        y1: p.y + (opts.retired ? 48 : 37)
      }
    }
  }
  // 円 r=22 + 枠線。名前は円の中。退場だけ円の下(ベースライン 34)
  return {
    x: p.x,
    y: p.y,
    r: 24,
    box: opts.retired ? { x0: p.x - 10, x1: p.x + 10, y0: p.y + 26, y1: p.y + 37 } : null
  }
}

function inside(s: NodeShape, x: number, y: number, pad: number): boolean {
  const dx = x - s.x
  const dy = y - s.y
  if (dx * dx + dy * dy <= (s.r + pad) * (s.r + pad)) return true
  const b = s.box
  return !!b && x >= b.x0 - pad && x <= b.x1 + pad && y >= b.y0 - pad && y <= b.y1 + pad
}

interface Rect {
  x0: number
  x1: number
  y0: number
  y1: number
}

function rectHitsShape(r: Rect, s: NodeShape): boolean {
  const cx = Math.min(r.x1, Math.max(r.x0, s.x))
  const cy = Math.min(r.y1, Math.max(r.y0, s.y))
  if (Math.hypot(cx - s.x, cy - s.y) <= s.r) return true
  const b = s.box
  return !!b && r.x0 <= b.x1 && r.x1 >= b.x0 && r.y0 <= b.y1 && r.y1 >= b.y0
}

function polyLength(points: Pt[]): number {
  let total = 0
  for (let i = 1; i < points.length; i += 1) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
  }
  return total
}

/** 折れ線上の弧長 s の位置 */
function pointAtLength(points: Pt[], s: number): Pt {
  let target = s
  for (let i = 1; i < points.length; i += 1) {
    const seg = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
    if (target <= seg) {
      const t = seg === 0 ? 0 : target / seg
      return {
        x: points[i - 1].x + (points[i].x - points[i - 1].x) * t,
        y: points[i - 1].y + (points[i].y - points[i - 1].y) * t
      }
    }
    target -= seg
  }
  return points[points.length - 1] ?? { x: 0, y: 0 }
}

/** 折れ線の弧長 s0〜s1 の部分 */
function slicePoly(points: Pt[], s0: number, s1: number): Pt[] {
  const out: Pt[] = [pointAtLength(points, s0)]
  let acc = 0
  for (let i = 1; i < points.length; i += 1) {
    acc += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
    if (acc > s0 && acc < s1) out.push({ ...points[i] })
  }
  out.push(pointAtLength(points, s1))
  return out
}

/** 折れ線を 1px 刻みで辿り、形(+ GAP)の中にある最後の点までの弧長 */
function lastInside(points: Pt[], shape: NodeShape): number {
  const total = polyLength(points)
  let last = 0
  for (let s = 0; s <= total; s += 1) {
    const p = pointAtLength(points, s)
    if (inside(shape, p.x, p.y, GAP)) last = s
  }
  return last
}

/** 両端を人物の形の縁で切った折れ線。名前の上を通る区間も切り落とす。短すぎれば null */
function cutToShapes(points: Pt[], from: NodeShape, to: NodeShape): Pt[] | null {
  const total = polyLength(points)
  const s0 = lastInside(points, from)
  const s1 = total - lastInside(points.slice().reverse(), to)
  if (s1 - s0 < 6) return null
  return slicePoly(points, s0, s1)
}

/** 中心どうしを結ぶ直線を、円の縁で切ったもの(人物が重なっているときの最後の手) */
function circleCut(from: NodeShape, to: NodeShape): Pt[] {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const len = Math.hypot(dx, dy) || 1
  const a = from.r + GAP
  const b = len - (to.r + GAP)
  if (b - a < 6) return []
  return [
    { x: from.x + (dx / len) * a, y: from.y + (dy / len) * a },
    { x: from.x + (dx / len) * b, y: from.y + (dy / len) * b }
  ]
}

export function routeOrthogonal(
  edges: RouteEdge[],
  shapes: Record<string, NodeShape>,
  nodeIds: string[]
): { routes: Record<string, Pt[]>; labels: Record<string, Pt> } {
  const routes: Record<string, Pt[]> = {}
  const labels: Record<string, Pt> = {}
  const placed = nodeIds.filter((id) => shapes[id])
  if (placed.length === 0) return { routes, labels }
  const xs = placed.map((id) => shapes[id].x)
  const ys = placed.map((id) => shapes[id].y)
  const minX = Math.min(...xs) - 100
  const minY = Math.min(...ys) - 100
  const cols = Math.max(4, Math.ceil((Math.max(...xs) + 100 - minX) / CELL))
  const rows = Math.max(4, Math.ceil((Math.max(...ys) + 100 - minY) / CELL))
  const cellCx = (x: number): number => Math.min(cols - 1, Math.max(0, Math.floor((x - minX) / CELL)))
  const cellCy = (y: number): number => Math.min(rows - 1, Math.max(0, Math.floor((y - minY) / CELL)))
  const cellCenter = (cx: number, cy: number): Pt => ({
    x: minX + (cx + 0.5) * CELL,
    y: minY + (cy + 0.5) * CELL
  })

  // 通行止めマップ: -1 = 自由、-2 = 複数の人物の形が重なる場所、それ以外 = その人物の縄張り
  // (当事者のみ通行可)
  const owner = new Int32Array(cols * rows).fill(-1)
  // 当事者でも名前の下は真ん中の列を縦にしか通さない(1 = 通れない、2 = 縦だけ)。
  // 名前の横から線が出入りすると、どの人物の線か分からなくなるため
  const nameArea = new Uint8Array(cols * rows)
  placed.forEach((id, i) => {
    const s = shapes[id]
    const ext = Math.max(s.r, s.box ? Math.max(s.x - s.box.x0, s.box.x1 - s.x) : 0) + CLEAR
    const bottom = Math.max(s.r, s.box ? s.box.y1 - s.y : 0) + CLEAR
    for (let cy = cellCy(s.y - s.r - CLEAR); cy <= cellCy(s.y + bottom); cy += 1) {
      for (let cx = cellCx(s.x - ext); cx <= cellCx(s.x + ext); cx += 1) {
        const c = cellCenter(cx, cy)
        if (!inside(s, c.x, c.y, CLEAR)) continue
        const k = cy * cols + cx
        owner[k] = owner[k] === -1 ? i : -2
        if (Math.hypot(c.x - s.x, c.y - s.y) > s.r + CLEAR) nameArea[k] = cx === cellCx(s.x) ? 2 : 1
      }
    }
  })
  const nodeIndex: Record<string, number> = Object.fromEntries(placed.map((id, i) => [id, i]))
  const usage = new Uint16Array(cols * rows)
  const labelHit = new Uint8Array(cols * rows)
  const placedLabels: Rect[] = []

  /** 折れ線が通るセル(重複なし) */
  const cellsOf = (pts: Pt[]): number[] => {
    const set = new Set<number>()
    const total = polyLength(pts)
    for (let s = 0; s <= total; s += CELL / 2) {
      const p = pointAtLength(pts, s)
      set.add(cellCy(p.y) * cols + cellCx(p.x))
    }
    return [...set]
  }

  /** 線の上でラベルを置く位置を選ぶ。人物と他のラベルには重ねず、他の線もなるべく避ける */
  const placeLabel = (pts: Pt[], label: string): Pt => {
    const w = labelWidth(label)
    const total = polyLength(pts)
    let best: { p: Pt; cost: number; rect: Rect } | null = null
    // 真ん中から 4px ずつ外へ、両側を交互に試す
    const offsets = [0]
    for (let d = 4; d < total / 2; d += 4) offsets.push(d, -d)
    for (const off of offsets) {
      const s = total / 2 + off
      const f = s / (total || 1)
      // 矢じりや根元に掛からないよう、両端からラベルの半幅 + 余白は離したい(短い線では諦める)
      const nearEnd = s < w / 2 + 8 || total - s < w / 2 + 14
      const on = pointAtLength(pts, s)
      // 線の上に重ねるのが基本。詰まっているときは線の脇(縦の区間なら左右、横なら上下)に寄せる
      const ahead = pointAtLength(pts, Math.min(total, s + 1))
      const vertical = Math.abs(ahead.x - on.x) < Math.abs(ahead.y - on.y)
      const side = vertical
        ? [
            [w / 2 + 3, 0],
            [-(w / 2 + 3), 0]
          ]
        : [
            [0, -(LABEL_H / 2 + 2)],
            [0, LABEL_H / 2 + 2]
          ]
      for (const [dx, dy] of [[0, 0], ...side]) {
        const p = { x: on.x + dx, y: on.y + dy }
        const rect = {
          x0: p.x - w / 2,
          x1: p.x + w / 2,
          y0: p.y - LABEL_H / 2,
          y1: p.y + LABEL_H / 2
        }
        const beside = dx !== 0 || dy !== 0
        let cost = Math.abs(f - 0.5) * 20 + (beside ? 4 : 0) + (nearEnd ? (beside ? 30 : 200) : 0)
        const pad = {
          x0: rect.x0 - 2,
          x1: rect.x1 + 2,
          y0: rect.y0 - 2,
          y1: rect.y1 + 2
        }
        if (placed.some((id) => rectHitsShape(pad, shapes[id]))) cost += 1000
        if (placedLabels.some((r) => pad.x0 <= r.x1 && pad.x1 >= r.x0 && pad.y0 <= r.y1 && pad.y1 >= r.y0)) cost += 1000
        // 他の線が通るセル(この線の分はまだ usage に載せていない)
        for (let cy = cellCy(rect.y0); cy <= cellCy(rect.y1); cy += 1) {
          for (let cx = cellCx(rect.x0); cx <= cellCx(rect.x1); cx += 1) cost += usage[cy * cols + cx] * 10
        }
        // 曲がり角をラベルで隠さない
        for (let i = 1; i < pts.length - 1; i += 1) {
          const c = pts[i]
          if (c.x >= rect.x0 && c.x <= rect.x1 && c.y >= rect.y0 && c.y <= rect.y1) cost += 5
        }
        if (!best || cost < best.cost) best = { p, cost, rect }
      }
    }
    if (!best) {
      const p = pointAtLength(pts, total / 2)
      best = {
        p,
        cost: 0,
        rect: {
          x0: p.x - w / 2,
          x1: p.x + w / 2,
          y0: p.y - LABEL_H / 2,
          y1: p.y + LABEL_H / 2
        }
      }
    }
    placedLabels.push(best.rect)
    for (let cy = cellCy(best.rect.y0); cy <= cellCy(best.rect.y1); cy += 1) {
      for (let cx = cellCx(best.rect.x0); cx <= cellCx(best.rect.x1); cx += 1) labelHit[cy * cols + cx] = 1
    }
    return best.p
  }

  const DIRS = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1]
  ] as const

  // A* 用バッファ(状態 = セル × 進入方向)。エッジごとの確保を避けて使い回す
  const stateCount = cols * rows * 4
  const g = new Float64Array(stateCount)
  const f = new Float64Array(stateCount)
  const cameFrom = new Int32Array(stateCount)
  const closed = new Uint8Array(stateCount)

  for (const edge of edges) {
    const from = shapes[edge.from]
    const to = shapes[edge.to]
    if (!from || !to) continue
    const fi = nodeIndex[edge.from] ?? -3
    const ti = nodeIndex[edge.to] ?? -3
    const scx = cellCx(from.x)
    const scy = cellCy(from.y)
    const tcx = cellCx(to.x)
    const tcy = cellCy(to.y)

    g.fill(Infinity)
    f.fill(Infinity)
    cameFrom.fill(-1)
    closed.fill(0)
    const heap: number[] = []
    const push = (s: number): void => {
      heap.push(s)
      let i = heap.length - 1
      while (i > 0) {
        const parent = (i - 1) >> 1
        if (f[heap[parent]] <= f[heap[i]]) break
        ;[heap[parent], heap[i]] = [heap[i], heap[parent]]
        i = parent
      }
    }
    const pop = (): number | undefined => {
      const top = heap[0]
      const last = heap.pop()
      if (heap.length > 0 && last !== undefined) {
        heap[0] = last
        let i = 0
        for (;;) {
          const l = i * 2 + 1
          const r = l + 1
          let m = i
          if (l < heap.length && f[heap[l]] < f[heap[m]]) m = l
          if (r < heap.length && f[heap[r]] < f[heap[m]]) m = r
          if (m === i) break
          ;[heap[m], heap[i]] = [heap[i], heap[m]]
          i = m
        }
      }
      return top
    }
    const h = (cx: number, cy: number): number => Math.abs(cx - tcx) + Math.abs(cy - tcy)
    const passable = (cx: number, cy: number, d: number): boolean => {
      if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) return false
      const o = owner[cy * cols + cx]
      if (o === -1) return true
      if (o === fi || o === ti) {
        const a = nameArea[cy * cols + cx]
        return a === 0 || (a === 2 && d >= 2)
      }
      if (o !== -2) return false
      // 人物どうしが近くて形が重なる場所は、当事者の形の中なら通す
      const c = cellCenter(cx, cy)
      return inside(from, c.x, c.y, CLEAR) || inside(to, c.x, c.y, CLEAR)
    }
    // 始点セルの 4 方向を g=0 で積む(最初の一歩は曲がりコストなし)
    for (let d = 0; d < 4; d += 1) {
      const s = (scy * cols + scx) * 4 + d
      g[s] = 0
      f[s] = h(scx, scy)
      push(s)
    }
    let goalState = -1
    let expanded = 0
    while (heap.length > 0 && expanded < MAX_EXPAND) {
      const cur = pop()
      if (cur === undefined) break
      if (closed[cur]) continue
      closed[cur] = 1
      expanded += 1
      const cell = cur >> 2
      const dir = cur & 3
      const cx = cell % cols
      const cy = (cell - cx) / cols
      if (cx === tcx && cy === tcy) {
        goalState = cur
        break
      }
      for (let d = 0; d < 4; d += 1) {
        const nx = cx + DIRS[d][0]
        const ny = cy + DIRS[d][1]
        if (!passable(nx, ny, d)) continue
        const ni = ny * cols + nx
        const ns = ni * 4 + d
        const cost = 1 + (d === dir ? 0 : TURN_COST) + usage[ni] * USAGE_COST + labelHit[ni] * LABEL_COST
        const ng = g[cur] + cost
        if (ng < g[ns]) {
          g[ns] = ng
          f[ns] = ng + h(nx, ny)
          cameFrom[ns] = cur
          push(ns)
        }
      }
    }

    // 中心どうしの直線(経路が見つからないとき)
    let raw: Pt[] = [
      { x: from.x, y: from.y },
      { x: to.x, y: to.y }
    ]
    if (goalState >= 0) {
      const cells: number[] = []
      let s: number = goalState
      while (s >= 0) {
        cells.push(s >> 2)
        s = cameFrom[s]
      }
      cells.reverse()
      // セル列 → 角の点列(同一直線上の中間セルを畳む)
      const corners: Pt[] = []
      for (const p of cells.map((c) => cellCenter(c % cols, Math.floor(c / cols)))) {
        if (corners.length >= 2) {
          const a = corners[corners.length - 2]
          const b = corners[corners.length - 1]
          if ((a.x === b.x && b.x === p.x) || (a.y === b.y && b.y === p.y)) {
            corners[corners.length - 1] = p
            continue
          }
        }
        corners.push(p)
      }
      if (corners.length > 2) {
        // 端の直線区間をノード中心に合わせる(グリッド量子化のずれを消す)
        if (corners[0].y === corners[1].y) {
          corners[1] = { ...corners[1], y: from.y }
        } else {
          corners[1] = { ...corners[1], x: from.x }
        }
        corners[0] = { x: from.x, y: from.y }
        const n = corners.length
        if (corners[n - 1].y === corners[n - 2].y) {
          corners[n - 2] = { ...corners[n - 2], y: to.y }
        } else {
          corners[n - 2] = { ...corners[n - 2], x: to.x }
        }
        corners[n - 1] = { x: to.x, y: to.y }
        raw = corners
      } else if (Math.abs(to.x - from.x) > Math.abs(to.y - from.y)) {
        // 曲がりなし = ほぼ一列に並んでいる。中心のずれ(グリッド 1 マス未満)は平均して水平・垂直に引く
        const y = (from.y + to.y) / 2
        raw = [
          { x: from.x, y },
          { x: to.x, y }
        ]
      } else {
        const x = (from.x + to.x) / 2
        raw = [
          { x, y: from.y },
          { x, y: to.y }
        ]
      }
    }
    const pts = cutToShapes(raw, from, to) ?? circleCut(from, to)
    const key = `${edge.from}->${edge.to}`
    routes[key] = pts
    if (pts.length < 2) continue
    if (edge.label) labels[key] = placeLabel(pts, edge.label)
    // 使ったセルに通行税を付けて、後続のエッジを別レーンへ誘導
    for (const c of cellsOf(pts)) usage[c] += 1
  }
  return { routes, labels }
}
