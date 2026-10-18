import { Fragment, useMemo } from 'react'
import { chapterSpans, consecutiveRuns } from './CharacterTimeline'
import { resolveEffectiveLocations } from './effectiveLocations'
import { NodeThumb } from './modes/structure/StructureNodes'
import type { Group, StoryGraph, StoryNode } from './types'

/** 資料庫の人物・場所のページに出す「出番の図」。
 *
 * 正史のシーンを横一列に並べ(キャラクタービューの出番表と同じ帯の描き方。1 人・1 か所ぶんの 1 行)、
 * その人物が登場する(cast)/ その場所が舞台になる(実効ロケーション)シーンを色の帯で示す。
 * 場所は location を空欄にして親から引き継いだシーンも含め、破線で区別する(2026-10-16 ユーザー判断)。
 * 正史から外れた分岐は、その資料が出てくる枝だけを下に 1 本ずつ並べる。
 * セルをクリックするとフローチャートでそのシーンを開く。
 * 章の帯の下には各シーンの挿絵のサムネイルを並べる(キャラクタービューの列の見出しと同じく、帯の上に絵・下に名前。
 * 出ていないシーンも物語の流れの目印として出す。2026-10-18 ユーザー要望)。
 */

const COLUMN_WIDTH = 72
const CELL_HEIGHT = 22
const CELL_INSET = 5
const CHAPTER_ROW_HEIGHT = 22 // 帯 16px + 下 6px
const ROW_HEIGHT = 32
const TITLE_ROW_HEIGHT = 18
const THUMB_ROW_HEIGHT = 44 // サムネイル 40px + 下 4px
const FALLBACK_COLOR = '#8a8fa8'

export type SceneUsageKind = 'character' | 'place'

/** 資料庫がエディタに渡す分(グラフ・章・シーンを開く手段) */
export interface SceneUsageProps {
  graph: StoryGraph
  groups: Group[]
  onOpenScene: (nodeId: string) => void
}

interface Usage {
  inherited: boolean
}

interface Chain {
  /** 分岐元(この枝の最初のシーンの親)のタイトル */
  from: string
  path: StoryNode[]
}

function canonPathOf(graph: StoryGraph): StoryNode[] {
  const canonChildren = new Map(graph.edges.filter((e) => e.is_canon).map((e) => [e.from_node, e.to_node]))
  const hasParent = new Set(graph.edges.map((e) => e.to_node))
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]))
  const root = graph.nodes.find((n) => !hasParent.has(n.id))
  if (!root) return []
  // 目印(はじまり・章の入口と出口・結末)は辿るだけで列には出さない(シーンだけを並べる)
  const path: StoryNode[] = root.kind ? [] : [root]
  const seen = new Set([root.id])
  let current = root.id
  while (canonChildren.has(current)) {
    const next = canonChildren.get(current)!
    if (seen.has(next)) break
    const node = nodeById.get(next)
    if (!node) break
    if (!node.kind) path.push(node)
    seen.add(next)
    current = next
  }
  return path
}

/** 正史から外れた枝を 1 本ずつの並びにする(枝の途中でさらに分かれたら、その先は別の枝として後ろに足す) */
function branchChains(graph: StoryGraph, canon: StoryNode[]): Chain[] {
  // 正史に乗っている目印も「正史」として扱う(そこから出る枝だけを分岐にする)
  const onCanon = new Set<string>()
  const canonChildren = new Map(graph.edges.filter((e) => e.is_canon).map((e) => [e.from_node, e.to_node]))
  const hasParent = new Set(graph.edges.map((e) => e.to_node))
  let cursor: string | undefined = graph.nodes.find((n) => !hasParent.has(n.id))?.id
  while (cursor && !onCanon.has(cursor)) {
    onCanon.add(cursor)
    cursor = canonChildren.get(cursor)
  }
  for (const n of canon) onCanon.add(n.id)
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]))
  const children = new Map<string, string[]>()
  for (const e of graph.edges) {
    if (!children.has(e.from_node)) children.set(e.from_node, [])
    children.get(e.from_node)!.push(e.to_node)
  }
  const roots: Array<{ parent: StoryNode; id: string }> = []
  for (const parentId of onCanon) {
    const parent = nodeById.get(parentId)
    if (!parent) continue
    for (const child of children.get(parentId) ?? []) {
      if (!onCanon.has(child)) roots.push({ parent, id: child })
    }
  }
  const chains: Chain[] = []
  const seen = new Set<string>(onCanon)
  for (let i = 0; i < roots.length; i += 1) {
    const { parent, id } = roots[i]
    if (seen.has(id)) continue
    const path: StoryNode[] = []
    let current: string | undefined = id
    while (current && !seen.has(current)) {
      const node = nodeById.get(current)
      if (!node) break
      seen.add(current)
      if (!node.kind) path.push(node)
      const next: string[] = children.get(current) ?? []
      // 2 つ目以降の子は別の枝として、この枝の後ろに続ける
      for (const extra of next.slice(1)) roots.splice(i + 1, 0, { parent: node, id: extra })
      current = next[0]
    }
    if (path.length) chains.push({ from: parentSceneTitle(parent, graph, nodeById), path })
  }
  return chains
}

/** 分岐元の表示名。目印(章の出口など)から分かれていれば、その手前のシーンの名前にする */
function parentSceneTitle(parent: StoryNode, graph: StoryGraph, nodeById: Map<string, StoryNode>): string {
  const parentOf = new Map(graph.edges.map((e) => [e.to_node, e.from_node]))
  let node: StoryNode | undefined = parent
  const seen = new Set<string>()
  while (node && node.kind && !seen.has(node.id)) {
    seen.add(node.id)
    const up = parentOf.get(node.id)
    node = up ? nodeById.get(up) : undefined
  }
  return node?.title || '(無題)'
}

function Strip({
  path,
  usage,
  groups,
  color,
  name,
  kind,
  showThumbs,
  onOpenScene
}: {
  path: StoryNode[]
  usage: Map<string, Usage>
  groups: Group[]
  color: string
  name: string
  kind: SceneUsageKind
  /** 挿絵のサムネイルの行を出すか(図に出るシーンに挿絵が 1 枚も無ければ出さない) */
  showThumbs: boolean
  onOpenScene: (nodeId: string) => void
}): React.JSX.Element {
  const spans = chapterSpans(path, groups)
  const usedCols = path.map((n, i) => (usage.has(n.id) ? i : -1)).filter((i) => i >= 0)
  const directRuns = consecutiveRuns(path.map((n, i) => (usage.get(n.id) && !usage.get(n.id)!.inherited ? i : -1)).filter((i) => i >= 0))
  const inheritedRuns = consecutiveRuns(path.map((n, i) => (usage.get(n.id)?.inherited ? i : -1)).filter((i) => i >= 0))
  const thumbRow = showThumbs ? THUMB_ROW_HEIGHT : 0
  const bandTop = CHAPTER_ROW_HEIGHT + thumbRow
  const cellTop = bandTop + (ROW_HEIGHT - CELL_HEIGHT) / 2
  const lineY = bandTop + ROW_HEIGHT / 2
  const height = bandTop + ROW_HEIGHT + TITLE_ROW_HEIGHT
  const verb = kind === 'character' ? 'に登場' : 'が舞台'
  return (
    <div className="inspector-scrollbar overflow-x-auto">
      <div className="relative select-none" style={{ width: path.length * COLUMN_WIDTH, height }}>
        {/* 章の帯(キャラクタービューと同じ。色の無い章は無彩色) */}
        {spans.map((span) => {
          const chapterColor = span.group.color
          return (
            <div
              key={`${span.group.id}-${span.start}`}
              className="pointer-events-none absolute top-0 truncate rounded-md border px-1.5 text-[10px] font-medium leading-[16px]"
              style={{
                left: span.start * COLUMN_WIDTH + 2,
                width: (span.end - span.start) * COLUMN_WIDTH - 4,
                background: chapterColor ? `${chapterColor}33` : 'var(--bg-card)',
                borderColor: chapterColor ?? 'var(--border-strong)',
                color: chapterColor ?? 'var(--text-dim)'
              }}
              title={span.group.title}
            >
              {span.group.title}
            </div>
          )
        })}
        <svg className="pointer-events-none absolute inset-0" width={path.length * COLUMN_WIDTH} height={height}>
          {/* 全部の列を通す無彩色の線路。出ていない列が「抜け」ではなく「出ていない」と読めるように
              (サムネイルの下が空白だと、帯が抜け落ちたように見えた。2026-10-18 ユーザー指摘) */}
          <line
            x1={CELL_INSET}
            x2={path.length * COLUMN_WIDTH - CELL_INSET}
            y1={lineY}
            y2={lineY}
            stroke="var(--border-strong)"
            strokeWidth={2}
            strokeLinecap="round"
          />
          {/* 初登場から最後の出番までを結ぶ線(人物の色) */}
          {usedCols.length > 1 && (
            <line
              x1={usedCols[0] * COLUMN_WIDTH + COLUMN_WIDTH / 2}
              x2={usedCols[usedCols.length - 1] * COLUMN_WIDTH + COLUMN_WIDTH / 2}
              y1={lineY}
              y2={lineY}
              stroke={color}
              strokeWidth={2}
              strokeOpacity={0.6}
            />
          )}
        </svg>
        {/* 出番の帯: 続けて出ているシーンは 1 本にまとめ、区切り線で何シーンかを見せる。引き継ぎは破線 */}
        {[...directRuns.map((run) => ({ run, inherited: false })), ...inheritedRuns.map((run) => ({ run, inherited: true }))].map(
          ({ run: [start, end], inherited }) => {
            const left = start * COLUMN_WIDTH + CELL_INSET
            const right = (end + 1) * COLUMN_WIDTH - CELL_INSET
            return (
              <Fragment key={`${path[start].id}-${inherited}`}>
                <div
                  className="pointer-events-none absolute rounded-md border"
                  style={{
                    left,
                    top: cellTop,
                    width: right - left,
                    height: CELL_HEIGHT,
                    background: `linear-gradient(${color}${inherited ? '1a' : '33'}, ${color}${inherited ? '1a' : '33'}), var(--bg-canvas)`,
                    borderColor: color,
                    borderWidth: 1.5,
                    borderStyle: inherited ? 'dashed' : 'solid'
                  }}
                />
                {Array.from({ length: end - start }, (_, k) => start + k + 1).map((index) => (
                  <div
                    key={`sep-${index}`}
                    className="pointer-events-none absolute"
                    style={{ left: index * COLUMN_WIDTH - 0.5, top: cellTop + 5, width: 1, height: CELL_HEIGHT - 10, background: `${color}80` }}
                  />
                ))}
              </Fragment>
            )
          }
        )}
        {/* 列ごとの透明なボタン(クリックでフローチャートへ)。上に挿絵のサムネイル、下にタイトル。
            挿絵の無いシーンは同じ大きさの空の枠で列を揃える */}
        {path.map((node, index) => {
          const used = usage.get(node.id)
          const title = node.title || '(無題)'
          const note = used ? `${name} ${verb}${used.inherited ? '(場所を親から引き継ぎ)' : ''}` : `${name} は出ていません`
          return (
            <button
              key={node.id}
              onClick={() => onOpenScene(node.id)}
              className="absolute flex flex-col rounded-md px-1 text-left hover:bg-[var(--accent-soft)]"
              style={{ left: index * COLUMN_WIDTH, top: CHAPTER_ROW_HEIGHT, width: COLUMN_WIDTH, height: thumbRow + ROW_HEIGHT + TITLE_ROW_HEIGHT }}
              aria-label={`${index + 1}. ${title}`}
              data-tip={`${index + 1}. ${title}\n${note}\nクリックでフローチャートで開く`}
            >
              {showThumbs && (
                // 出ていない列の絵は白黒にして控えめに(同じ行の中での主従。目が出ている場面の絵へ向くように)
                <span
                  className="block h-10 w-16 shrink-0 overflow-hidden rounded-md"
                  style={{
                    background: 'var(--bg-canvas)',
                    ...(used ? {} : { filter: 'grayscale(1)', opacity: 0.45 })
                  }}
                  data-usage-thumb
                  data-usage-absent={used ? undefined : true}
                >
                  <NodeThumb node={node} className="block h-full w-full object-cover" />
                </span>
              )}
              <span className="flex-1" />
              <span className="truncate text-[10px] leading-[18px]" style={{ color: used ? 'var(--text)' : 'var(--text-faint)' }}>
                <span className="tabular-nums" style={{ color: 'var(--text-faint)' }}>{index + 1}.</span> {title}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

export default function SceneUsage({
  kind,
  entityId,
  name,
  color,
  graph,
  groups,
  onOpenScene
}: {
  kind: SceneUsageKind
  entityId: string
  name: string
  color: string | null
  graph: StoryGraph
  groups: Group[]
  onOpenScene: (nodeId: string) => void
}): React.JSX.Element {
  const usage = useMemo(() => {
    const map = new Map<string, Usage>()
    // 目印(章の入口・出口・結末)は場所を引き継ぐが場面ではないので数えない
    const scenes = graph.nodes.filter((n) => !n.kind)
    if (kind === 'character') {
      for (const n of scenes) if (n.cast.includes(entityId)) map.set(n.id, { inherited: false })
    } else {
      const effective = resolveEffectiveLocations(graph.nodes, graph.edges)
      for (const n of scenes) {
        const eff = effective[n.id]
        if (eff && eff.placeId === entityId) map.set(n.id, { inherited: eff.inherited })
      }
    }
    return map
  }, [graph, kind, entityId])
  const canon = useMemo(() => canonPathOf(graph), [graph])
  const chains = useMemo(
    () => branchChains(graph, canon).filter((chain) => chain.path.some((n) => usage.has(n.id))),
    [graph, canon, usage]
  )
  // 挿絵のサムネイルの行は、図に出るシーンのどれかに挿絵があるときだけ出す(空の枠ばかり並べない)
  const showThumbs = canon.some((n) => n.image_path) || chains.some((chain) => chain.path.some((n) => n.image_path))
  const total = usage.size
  const inherited = [...usage.values()].filter((u) => u.inherited).length
  const entityColor = color ?? FALLBACK_COLOR
  const heading = kind === 'character' ? '登場するシーン' : '使われている場面'
  return (
    <section className="mb-5" aria-label={heading}>
      <div className="mb-1 flex items-baseline gap-1.5">
        <span className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
          {heading}
        </span>
        <span className="tabular-nums text-[11px]" style={{ color: 'var(--text-faint)' }}>
          {total}
          {inherited > 0 ? `(うち引き継ぎ ${inherited})` : ''}
        </span>
      </div>
      {canon.length === 0 ? (
        <p className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
          シーンがまだありません。
        </p>
      ) : (
        <>
          <Strip path={canon} usage={usage} groups={groups} color={entityColor} name={name} kind={kind} showThumbs={showThumbs} onOpenScene={onOpenScene} />
          {chains.map((chain) => (
            <div key={chain.path[0].id} className="mt-2">
              <p className="mb-0.5 truncate text-[10px]" style={{ color: 'var(--text-faint)' }}>
                分岐: 「{chain.from}」から
              </p>
              <Strip path={chain.path} usage={usage} groups={groups} color={entityColor} name={name} kind={kind} showThumbs={showThumbs} onOpenScene={onOpenScene} />
            </div>
          ))}
          <p className="mt-1 text-[11px]" style={{ color: 'var(--text-faint)' }}>
            {total === 0
              ? kind === 'character'
                ? 'まだどのシーンにも登場していません。'
                : 'まだどのシーンの舞台にもなっていません。'
              : kind === 'place'
                ? '破線は、場所を空欄にして親から引き継いだシーン。クリックでフローチャートで開きます。'
                : 'クリックでフローチャートで開きます。'}
          </p>
        </>
      )}
    </section>
  )
}
