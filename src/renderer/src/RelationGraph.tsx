import { useEffect, useMemo, useRef, useState } from 'react'
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum
} from 'd3-force'
import { api, assetUrl } from './api'
import type { Character, StateSnapshot, StoryNode } from './types'

interface GraphNode extends SimulationNodeDatum {
  id: string
}

interface RelEdge {
  from: string
  to: string
  score: number
  reasons: string[]
  label?: string
}

interface ReasonEntry {
  type: string
  payload: Record<string, unknown>
  nodeTitle: string
}

function edgeColor(score: number): string {
  if (Math.abs(score) < 0.15) return '#5c6078'
  return score > 0 ? '#3ecf8e' : '#ef4444'
}

// ---- 直角エッジのルーティング(グリッド A*)---------------------------
// フル版(orthogonal)用。ノードの周囲を通行止めにしたグリッド上で
// 上下左右のみの経路を探索する。曲がりと「他のエッジが通済みのセル」に
// コストを付けることで、直進を好みつつ並走エッジが別レーンに分かれる。

const CELL = 10 // グリッド解像度(px)
const BLOCK_R = 34 // ノード周りの通行止め半径(アイコン + 名前ラベル分)
const TRIM_R = 26 // ノード円の縁で線を切る半径(直線版の pad と同じ)
const TURN_COST = 3
const USAGE_COST = 4
const MAX_EXPAND = 20000 // A* の安全弁

interface Pt {
  x: number
  y: number
}

/** 先頭がノード中心にある折れ線を、中心から距離 r の位置まで切り詰める */
function trimRun(points: Pt[], center: Pt, r: number): Pt[] {
  const out = points.map((p) => ({ ...p }))
  while (out.length >= 2) {
    const a = out[0]
    const b = out[1]
    const da = Math.hypot(a.x - center.x, a.y - center.y)
    const db = Math.hypot(b.x - center.x, b.y - center.y)
    if (db <= r) {
      out.shift()
      continue
    }
    if (da >= r) break
    // 区間はノード中心付近を軸平行に通るため、距離の線形近似で十分
    const t = (r - da) / (db - da)
    out[0] = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
    break
  }
  return out
}

/** 両端をノード円の縁まで切り詰めた直線(ルート失敗時のフォールバック) */
function straightPts(from: Pt, to: Pt): Pt[] {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const len = Math.hypot(dx, dy) || 1
  return [
    { x: from.x + (dx / len) * TRIM_R, y: from.y + (dy / len) * TRIM_R },
    { x: to.x - (dx / len) * TRIM_R, y: to.y - (dy / len) * TRIM_R }
  ]
}

/** 折れ線上の弧長 frac(0〜1)の位置 */
function pointAt(points: Pt[], frac: number): Pt {
  let total = 0
  for (let i = 1; i < points.length; i += 1) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
  }
  let target = total * frac
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

function routeOrthogonal(
  edges: RelEdge[],
  positions: Record<string, Pt>,
  nodeIds: string[]
): Record<string, Pt[]> {
  const placed = nodeIds.filter((id) => positions[id])
  if (placed.length === 0) return {}
  const xs = placed.map((id) => positions[id].x)
  const ys = placed.map((id) => positions[id].y)
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

  // 通行止めマップ: -1 = 自由、それ以外 = そのノードの縄張り(当事者のみ通行可)
  const owner = new Int32Array(cols * rows).fill(-1)
  placed.forEach((id, i) => {
    const p = positions[id]
    for (let cy = cellCy(p.y - BLOCK_R); cy <= cellCy(p.y + BLOCK_R); cy += 1) {
      for (let cx = cellCx(p.x - BLOCK_R); cx <= cellCx(p.x + BLOCK_R); cx += 1) {
        const c = cellCenter(cx, cy)
        if (Math.hypot(c.x - p.x, c.y - p.y) <= BLOCK_R) owner[cy * cols + cx] = i
      }
    }
  })
  const nodeIndex: Record<string, number> = Object.fromEntries(placed.map((id, i) => [id, i]))
  const usage = new Uint16Array(cols * rows)

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

  const result: Record<string, Pt[]> = {}
  for (const edge of edges) {
    const from = positions[edge.from]
    const to = positions[edge.to]
    if (!from || !to) continue
    const fi = nodeIndex[edge.from] ?? -2
    const ti = nodeIndex[edge.to] ?? -2
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
    const passable = (cx: number, cy: number): boolean => {
      if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) return false
      const o = owner[cy * cols + cx]
      return o === -1 || o === fi || o === ti
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
        if (!passable(nx, ny)) continue
        const ni = ny * cols + nx
        const ns = ni * 4 + d
        const cost = 1 + (d === dir ? 0 : TURN_COST) + usage[ni] * USAGE_COST
        const ng = g[cur] + cost
        if (ng < g[ns]) {
          g[ns] = ng
          f[ns] = ng + h(nx, ny)
          cameFrom[ns] = cur
          push(ns)
        }
      }
    }

    let pts: Pt[]
    if (goalState >= 0) {
      const cells: number[] = []
      let s: number = goalState
      while (s >= 0) {
        cells.push(s >> 2)
        s = cameFrom[s]
      }
      cells.reverse()
      // セル列 → 角の点列(同一直線上の中間セルを畳む)
      const raw = cells.map((c) => cellCenter(c % cols, Math.floor(c / cols)))
      const corners: Pt[] = []
      for (const p of raw) {
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
      if (corners.length <= 2) {
        // 曲がりなし = ほぼ一直線に並んでいる。素直に直線で結ぶ
        pts = straightPts(from, to)
      } else {
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
        let trimmed = trimRun(corners, from, TRIM_R)
        trimmed = trimRun(trimmed.slice().reverse(), to, TRIM_R).reverse()
        pts = trimmed
        // 使ったセルに通行税を付けて、後続のエッジを別レーンへ誘導
        for (const c of cells) usage[c] += 1
      }
    } else {
      pts = straightPts(from, to)
    }
    result[`${edge.from}->${edge.to}`] = pts
  }
  return result
}

export default function RelationGraph({
  characters,
  path,
  allNodes,
  onCharactersChanged,
  width = 360,
  height = 380,
  orthogonal = false,
  egoCharId: egoProp,
  onEgoChange
}: {
  characters: Character[]
  /** 表示対象のパス(選択ノードまで。未選択時は正史パス)。末尾が基準時点 */
  path: StoryNode[]
  allNodes: StoryNode[]
  onCharactersChanged: () => void
  /** 論理キャンバスの大きさ(viewBox)。フル版では大きくする */
  width?: number
  height?: number
  /** 直角折れ線ルーティング(経路探索でノードを避ける)を使う */
  orthogonal?: boolean
  /** エゴネットワークの外部制御(指定時は controlled。省略時は内部 state) */
  egoCharId?: string | null
  onEgoChange?: (id: string | null) => void
}): React.JSX.Element {
  const canonPath = path
  const [scrubIndex, setScrubIndex] = useState(canonPath.length - 1)
  const [state, setState] = useState<StateSnapshot | null>(null)
  const [threshold, setThreshold] = useState(0)
  const [egoLocal, setEgoLocal] = useState<string | null>(null)
  const egoCharId = onEgoChange ? (egoProp ?? null) : egoLocal
  const setEgo = (id: string | null): void => {
    if (onEgoChange) onEgoChange(id)
    else setEgoLocal(id)
  }
  const [selectedEdge, setSelectedEdge] = useState<{ from: string; to: string } | null>(null)
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({})
  const dragRef = useRef<{ id: string; moved: boolean } | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [view, setView] = useState({ x: 0, y: 0, zoom: 1 })
  const viewRef = useRef(view)
  const panRef = useRef<{ px: number; py: number; vx: number; vy: number } | null>(null)

  useEffect(() => {
    viewRef.current = view
  }, [view])

  // ホイールズーム(カーソル位置を中心に。React の onWheel は passive のため native で登録)
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const rect = svg.getBoundingClientRect()
      const v = viewRef.current
      const u = (e.clientX - rect.left) / rect.width
      const w = (e.clientY - rect.top) / rect.height
      const px = v.x + u * (width / v.zoom)
      const py = v.y + w * (height / v.zoom)
      const zoom = Math.min(4, Math.max(0.4, v.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)))
      setView({ x: px - u * (width / zoom), y: py - w * (height / zoom), zoom })
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [width, height])

  const charMap = useMemo(() => Object.fromEntries(characters.map((c) => [c.id, c])), [characters])

  // イベント ID → 理由表示用エントリ(全ノードの relationship イベントから索引)
  const reasonIndex = useMemo(() => {
    const map: Record<string, ReasonEntry> = {}
    for (const node of allNodes) {
      for (const e of node.events) {
        if (e.type === 'relationship_update' || e.type === 'relationship_set') {
          map[e.id] = { type: e.type, payload: e.payload, nodeTitle: node.title || '(無題)' }
        }
      }
    }
    return map
  }, [allNodes])

  // スクラブ位置の変更で fold 状態を取得
  const clampedIndex = Math.min(Math.max(scrubIndex, 0), Math.max(canonPath.length - 1, 0))
  const scrubNode = canonPath[clampedIndex] ?? null

  // パス(=選択ノード)が変わったら基準時点をその末尾に合わせる
  const pathKey = canonPath.map((n) => n.id).join(',')
  useEffect(() => {
    setScrubIndex(canonPath.length - 1)
  }, [pathKey])

  // 基準時点が変わったら取り直す。時間スクラブや矢印キーで次々に変わると
  // 取得が複数走るので、古い応答は捨てる(捨てないと前の時点の関係が残る)
  useEffect(() => {
    if (!scrubNode) {
      setState(null)
      return
    }
    let ignore = false
    void api
      .getState(scrubNode.id)
      .then((s) => {
        if (!ignore) setState(s)
      })
      .catch(() => {
        if (!ignore) setState(null)
      })
    return () => {
      ignore = true
    }
  }, [scrubNode?.id, scrubNode?.updated_at])

  // 表示対象: 登場済みキャラ + イベントが発行された関係のみ(スパース)。
  // score が 0 でも履歴(reasons)があれば「中立に戻った関係」として破線で表示する
  const { visibleChars, edges } = useMemo(() => {
    if (!state) return { visibleChars: [] as string[], edges: [] as RelEdge[] }
    const chars = Object.keys(state.chars).filter((id) => charMap[id])
    let rels: RelEdge[] = []
    for (const from of chars) {
      const cs = state.chars[from]
      for (const [to, rel] of Object.entries(cs.relationships)) {
        if (rel.target_type !== 'char' || !charMap[to]) continue
        if (rel.score === 0 && rel.reasons.length === 0) continue
        if (Math.abs(rel.score) < threshold) continue
        rels.push({ from, to, score: rel.score, reasons: rel.reasons, label: rel.label })
      }
    }
    if (egoCharId) {
      rels = rels.filter((r) => r.from === egoCharId || r.to === egoCharId)
    }
    const used = new Set(rels.flatMap((r) => [r.from, r.to]))
    const visible = chars.filter((id) => used.has(id) || id === egoCharId)
    return { visibleChars: visible, edges: rels }
  }, [state, charMap, threshold, egoCharId])

  // レイアウト: 保存済み座標をピン留めし、未配置キャラのみ d3-force で配置
  useEffect(() => {
    if (visibleChars.length === 0) return
    const missing = visibleChars.filter((id) => {
      const c = charMap[id]
      return positions[id] === undefined && (c?.graph_x == null || c?.graph_y == null)
    })
    const known: Record<string, { x: number; y: number }> = { ...positions }
    for (const id of visibleChars) {
      if (known[id] === undefined) {
        const c = charMap[id]
        if (c?.graph_x != null && c?.graph_y != null) known[id] = { x: c.graph_x, y: c.graph_y }
      }
    }
    if (missing.length === 0) {
      if (Object.keys(known).length !== Object.keys(positions).length) setPositions(known)
      return
    }
    const simNodes: GraphNode[] = visibleChars.map((id) => {
      const pinned = known[id]
      return pinned
        ? { id, x: pinned.x, y: pinned.y, fx: pinned.x, fy: pinned.y }
        : { id, x: width / 2 + (Math.random() - 0.5) * 60, y: height / 2 + (Math.random() - 0.5) * 60 }
    })
    const nodeById = Object.fromEntries(simNodes.map((n) => [n.id, n]))
    const links: SimulationLinkDatum<GraphNode>[] = edges
      .filter((e) => nodeById[e.from] && nodeById[e.to])
      .map((e) => ({ source: e.from, target: e.to }))
    const sim = forceSimulation(simNodes)
      .force('link', forceLink<GraphNode, SimulationLinkDatum<GraphNode>>(links).id((d) => d.id).distance(110))
      .force('charge', forceManyBody().strength(-350))
      .force('x', forceX(width / 2).strength(0.06))
      .force('y', forceY(height / 2).strength(0.06))
      .force('collide', forceCollide(34))
      .stop()
    for (let i = 0; i < 300; i += 1) sim.tick()
    const next = { ...known }
    for (const n of simNodes) {
      next[n.id] = { x: n.x ?? width / 2, y: n.y ?? height / 2 }
    }
    setPositions(next)
    // 新規配置分をピン留め保存
    for (const id of missing) {
      const p = next[id]
      if (p) void api.updateCharacter(id, { graph_x: p.x, graph_y: p.y }).then(() => onCharactersChanged())
    }
  }, [visibleChars.join(','), edges.length])

  // 直角ルーティング(フル版)。位置・エッジが変わるたびに引き直す
  const routes = useMemo(
    () => (orthogonal ? routeOrthogonal(edges, positions, visibleChars) : null),
    [orthogonal, edges, positions, visibleChars]
  )

  // ノードドラッグ(ピン留め座標の更新)。座標変換は現在のズーム・パンを考慮
  const toSvgPoint = (event: React.PointerEvent): { x: number; y: number } => {
    const svg = svgRef.current
    if (!svg) return { x: 0, y: 0 }
    const rect = svg.getBoundingClientRect()
    const v = viewRef.current
    return {
      x: v.x + ((event.clientX - rect.left) / rect.width) * (width / v.zoom),
      y: v.y + ((event.clientY - rect.top) / rect.height) * (height / v.zoom)
    }
  }

  const handleBackgroundPointerDown = (event: React.PointerEvent): void => {
    if (event.target !== svgRef.current) return
    if (event.button !== 0 && event.button !== 1) return
    ;(event.target as Element).setPointerCapture?.(event.pointerId)
    const v = viewRef.current
    panRef.current = { px: event.clientX, py: event.clientY, vx: v.x, vy: v.y }
  }

  const handlePointerMove = (event: React.PointerEvent): void => {
    const drag = dragRef.current
    if (drag) {
      drag.moved = true
      const p = toSvgPoint(event)
      setPositions((prev) => ({ ...prev, [drag.id]: p }))
      return
    }
    const pan = panRef.current
    if (pan) {
      const svg = svgRef.current
      if (!svg) return
      const rect = svg.getBoundingClientRect()
      const v = viewRef.current
      setView({
        x: pan.vx - ((event.clientX - pan.px) / rect.width) * (width / v.zoom),
        y: pan.vy - ((event.clientY - pan.py) / rect.height) * (height / v.zoom),
        zoom: v.zoom
      })
    }
  }

  const handlePointerUp = (): void => {
    panRef.current = null
    const drag = dragRef.current
    dragRef.current = null
    if (!drag) return
    if (drag.moved) {
      const p = positions[drag.id]
      if (p) void api.updateCharacter(drag.id, { graph_x: p.x, graph_y: p.y }).then(() => onCharactersChanged())
    } else {
      // クリック = エゴネットワーク切替
      setEgo(egoCharId === drag.id ? null : drag.id)
    }
  }

  const selectedReasons: Array<{ score: RelEdge; entries: ReasonEntry[] }> = useMemo(() => {
    if (!selectedEdge) return []
    const edge = edges.find((e) => e.from === selectedEdge.from && e.to === selectedEdge.to)
    if (!edge) return []
    return [{ score: edge, entries: edge.reasons.map((id) => reasonIndex[id]).filter(Boolean) }]
  }, [selectedEdge, edges, reasonIndex])

  const nameOf = (id: string): string => charMap[id]?.name ?? id

  if (canonPath.length === 0) {
    return (
      <div className="pt-8 text-center text-[12px]" style={{ color: 'var(--text-faint)' }}>
        正史パスにシーンがありません
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {/* 時間スクラブ */}
      <div>
        <div className="mb-1 flex items-center justify-between text-[11px]" style={{ color: 'var(--text-faint)' }}>
          <span className="uppercase tracking-[0.14em]">Time</span>
          <span className="truncate pl-2" style={{ color: 'var(--text-dim)' }}>
            {clampedIndex + 1}/{canonPath.length} {scrubNode?.title || '(無題)'}
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={Math.max(canonPath.length - 1, 0)}
          value={clampedIndex}
          onChange={(e) => setScrubIndex(Number(e.target.value))}
          className="settings-slider active w-full"
        />
      </div>
      {/* フィルタ */}
      <div className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--text-faint)' }}>
        <span className="uppercase tracking-[0.14em]">|score| ≥ {threshold.toFixed(2)}</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={threshold}
          onChange={(e) => setThreshold(Number(e.target.value))}
          className={`settings-slider min-w-0 flex-1${threshold > 0 ? ' active' : ''}`}
        />
        {egoCharId && (
          <button
            onClick={() => setEgo(null)}
            className="rounded-md border px-1.5 py-0.5"
            style={{ borderColor: 'var(--accent-border)', color: 'var(--accent)' }}
          >
            {nameOf(egoCharId)} のみ ✕
          </button>
        )}
      </div>
      {/* グラフ本体 */}
      <svg
        ref={svgRef}
        viewBox={`${view.x} ${view.y} ${width / view.zoom} ${height / view.zoom}`}
        className="w-full rounded-xl border"
        style={{ background: 'var(--bg-canvas)', borderColor: 'var(--border)', touchAction: 'none' }}
        onPointerDown={handleBackgroundPointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        onDoubleClick={(e) => {
          if (e.target === svgRef.current) setView({ x: 0, y: 0, zoom: 1 })
        }}
      >
        <defs>
          <marker
            id="rel-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="4.5"
            markerHeight="4.5"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
          </marker>
        </defs>
        {edges.map((edge) => {
          const from = positions[edge.from]
          const to = positions[edge.to]
          if (!from || !to) return null
          const key = `${edge.from}->${edge.to}`
          let pts: Pt[]
          let labelX: number
          let labelY: number
          if (routes) {
            pts = routes[key] ?? []
            if (pts.length < 2) return null
            const mid = pointAt(pts, 0.5)
            labelX = mid.x
            labelY = mid.y - 4
          } else {
            const dx = to.x - from.x
            const dy = to.y - from.y
            const len = Math.hypot(dx, dy) || 1
            // 双方向エッジが重ならないよう法線方向にオフセット
            const nx = (-dy / len) * 6
            const ny = (dx / len) * 6
            // ノード半径分を短縮
            const pad = 26
            pts = [
              { x: from.x + (dx / len) * pad + nx, y: from.y + (dy / len) * pad + ny },
              { x: to.x - (dx / len) * pad + nx, y: to.y - (dy / len) * pad + ny }
            ]
            // ラベル位置: エッジ中点から法線方向に少し離す
            labelX = (pts[0].x + pts[1].x) / 2 + nx * 1.6
            labelY = (pts[0].y + pts[1].y) / 2 + ny * 1.6
          }
          const pointsAttr = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
          const isSelected = selectedEdge?.from === edge.from && selectedEdge?.to === edge.to
          return (
            <g key={key}>
              <polyline
                points={pointsAttr}
                fill="none"
                stroke={edgeColor(edge.score)}
                strokeWidth={1 + Math.abs(edge.score) * 3}
                strokeOpacity={isSelected ? 1 : 0.4 + Math.abs(edge.score) * 0.5}
                strokeDasharray={edge.score === 0 ? '4 4' : undefined}
                markerEnd="url(#rel-arrow)"
              />
              {edge.label && (
                <text
                  x={labelX}
                  y={labelY}
                  textAnchor="middle"
                  fontSize="8.5"
                  fill="var(--text-dim)"
                  stroke="var(--bg-canvas)"
                  strokeWidth="3"
                  paintOrder="stroke"
                  style={{ pointerEvents: 'none', userSelect: 'none' }}
                >
                  {edge.label}
                </text>
              )}
              {/* クリック当たり判定用の太い透明線 */}
              <polyline
                points={pointsAttr}
                fill="none"
                stroke="transparent"
                strokeWidth={14}
                style={{ cursor: 'pointer' }}
                onClick={() => setSelectedEdge(isSelected ? null : { from: edge.from, to: edge.to })}
              />
            </g>
          )
        })}
        {visibleChars.map((id) => {
          const p = positions[id]
          if (!p) return null
          const c = charMap[id]
          const retired = state?.chars[id]?.status === 'retired'
          const isEgo = egoCharId === id
          return (
            <g
              key={id}
              transform={`translate(${p.x}, ${p.y})`}
              style={{ cursor: 'grab' }}
              onPointerDown={(e) => {
                e.stopPropagation()
                ;(e.target as Element).setPointerCapture?.(e.pointerId)
                dragRef.current = { id, moved: false }
              }}
            >
              {assetUrl(c?.portrait_path) ? (
                <>
                  <clipPath id={`avatar-clip-${id}`}>
                    <circle r={20} />
                  </clipPath>
                  <image
                    href={assetUrl(c?.portrait_path)!}
                    x={-20}
                    y={-20}
                    width={40}
                    height={40}
                    clipPath={`url(#avatar-clip-${id})`}
                    preserveAspectRatio="xMidYMid slice"
                    opacity={retired ? 0.45 : 1}
                  />
                  <circle
                    r={21}
                    fill="none"
                    stroke={isEgo ? 'var(--accent)' : c?.color ?? '#8a8fa8'}
                    strokeWidth={isEgo ? 3 : 2}
                    opacity={retired ? 0.45 : 1}
                  />
                  <text
                    textAnchor="middle"
                    dy="34"
                    fontSize="9"
                    fill="var(--text-dim)"
                    style={{ pointerEvents: 'none', userSelect: 'none' }}
                  >
                    {(c?.name ?? id).slice(0, 5)}
                  </text>
                </>
              ) : (
                <>
                  <circle
                    r={22}
                    fill="var(--bg-card)"
                    stroke={isEgo ? 'var(--accent)' : c?.color ?? '#8a8fa8'}
                    strokeWidth={isEgo ? 3 : 2}
                    opacity={retired ? 0.45 : 1}
                  />
                  <text
                    textAnchor="middle"
                    dy="4"
                    fontSize="11"
                    fill="var(--text)"
                    opacity={retired ? 0.5 : 1}
                    style={{ pointerEvents: 'none', userSelect: 'none' }}
                  >
                    {(c?.name ?? id).slice(0, 4)}
                  </text>
                </>
              )}
              {retired && (
                <text
                  textAnchor="middle"
                  dy={c?.portrait_path ? 46 : 34}
                  fontSize="9"
                  fill="var(--text-faint)"
                  style={{ pointerEvents: 'none' }}
                >
                  退場
                </text>
              )}
            </g>
          )
        })}
        {visibleChars.length === 0 && (
          <text x={width / 2} y={height / 2} textAnchor="middle" fontSize="12" fill="var(--text-faint)">
            この時点で表示できる関係はありません
          </text>
        )}
      </svg>
      {/* エッジ履歴ドリルダウン */}
      {selectedEdge && (
        <div
          className="rounded-xl border p-3"
          style={{ background: 'var(--bg-card)', borderColor: 'var(--border)' }}
        >
          <div className="mb-1.5 flex items-center justify-between text-[12px]">
            <span style={{ color: 'var(--text)' }}>
              {nameOf(selectedEdge.from)} → {nameOf(selectedEdge.to)}
              {selectedReasons[0] && (
                <span className="ml-2 tabular-nums" style={{ color: edgeColor(selectedReasons[0].score.score) }}>
                  {selectedReasons[0].score.score.toFixed(2)}
                </span>
              )}
            </span>
            <button onClick={() => setSelectedEdge(null)} style={{ color: 'var(--text-faint)' }}>
              ✕
            </button>
          </div>
          {selectedReasons[0]?.entries.length === 0 && (
            <div className="text-[12px]" style={{ color: 'var(--text-faint)' }}>
              履歴イベントが見つかりません
            </div>
          )}
          {selectedReasons[0]?.entries.map((entry, i) => (
            <div
              key={i}
              className="mb-1 rounded-lg border px-2.5 py-1.5 text-[12px]"
              style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)' }}
            >
              <div className="flex items-center gap-2">
                <span className="tabular-nums" style={{ color: 'var(--text)' }}>
                  {entry.type === 'relationship_set'
                    ? `= ${Number(entry.payload.value ?? 0).toFixed(2)}`
                    : `${Number(entry.payload.delta ?? 0) >= 0 ? '+' : ''}${Number(entry.payload.delta ?? 0).toFixed(2)}`}
                </span>
                <span className="truncate text-[11px]" style={{ color: 'var(--text-faint)' }}>
                  {entry.nodeTitle}
                </span>
              </div>
              {typeof entry.payload.reason === 'string' && entry.payload.reason && (
                <div style={{ color: 'var(--text-dim)' }}>{entry.payload.reason}</div>
              )}
            </div>
          ))}
        </div>
      )}
      <p className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
        ノードクリック = エゴ切替 / ノードドラッグ = 配置(保存) / エッジクリック = 履歴 /
        ホイール = ズーム / 背景ドラッグ = パン / 背景ダブルクリック = リセット
      </p>
    </div>
  )
}
