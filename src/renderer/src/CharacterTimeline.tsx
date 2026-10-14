import { useEffect, useMemo, useRef } from 'react'
import CharAvatar from './CharAvatar'
import type { Character, Group, StoryNode } from './types'

/** キャラクタービュー(人物別の出番表)。
 *
 * フローチャートがシーン単位の DAG なのに対し、こちらは横軸にシーン、縦軸に
 * キャラクターのレーンを取ったガントチャート風の表。シーンの cast に居る人物の
 * レーンにセルを置き、同じシーンのセルを縦線でつないで「誰と誰が一緒に居るか」を見せる。
 * 人物ごとの出番は横線でつなぐ(初登場から最後の出番まで)。
 *
 * 対象は正史パスのみ(関係図・事実タブと同じ扱い)。登場は cast で判定する
 * (fold の「登場」の導出と同じ出どころ)。セルや列の見出しをクリックするとそのシーンを
 * 選択し、編集は下段の詳細欄(ビート編集)で行う。docs/plan/plan.md の計画を参照。
 */

const COLUMN_WIDTH = 112
const LABEL_WIDTH = 168
const ROW_HEIGHT = 44
const CELL_HEIGHT = 26
const CELL_INSET = 10 // セルの左右の余白(列の中で少し細くして、縦線がセルの中央を通るように)
const CHAPTER_ROW_HEIGHT = 22
const TITLE_ROW_HEIGHT = 30
const FALLBACK_COLOR = '#8a8fa8'

interface ChapterSpan {
  group: Group
  start: number
  end: number // 排他
}

/** 正史パス上で連続する同じ章を 1 つの帯にまとめる */
function chapterSpans(path: StoryNode[], groups: Group[]): ChapterSpan[] {
  const byId = new Map(groups.map((g) => [g.id, g]))
  const spans: ChapterSpan[] = []
  path.forEach((node, index) => {
    const group = node.group_id ? byId.get(node.group_id) : undefined
    if (!group) return
    const last = spans[spans.length - 1]
    if (last && last.group.id === group.id && last.end === index) last.end = index + 1
    else spans.push({ group, start: index, end: index + 1 })
  })
  return spans
}

export default function CharacterTimeline({
  path,
  hiddenCount,
  characters,
  groups,
  selectedNodeId,
  onSelectNode
}: {
  path: StoryNode[]
  /** 正史パスに乗っていないので表示していないシーン数(分岐・島) */
  hiddenCount: number
  characters: Character[]
  groups: Group[]
  selectedNodeId: string | null
  onSelectNode: (nodeId: string) => void
}): React.JSX.Element {
  const spans = useMemo(() => chapterSpans(path, groups), [path, groups])
  // シーンごとの cast(登場している人物の集合)
  const castSets = useMemo(() => path.map((n) => new Set(n.cast ?? [])), [path])
  // 人物ごとの出番の列(初登場 → 最後の出番の横線に使う)
  const appearances = useMemo(() => {
    const map = new Map<string, number[]>()
    for (const c of characters) map.set(c.id, [])
    castSets.forEach((cast, index) => {
      for (const id of cast) map.get(id)?.push(index)
    })
    return map
  }, [characters, castSets])
  // シーンごとの縦線(cast の最初のレーンから最後のレーンまで)
  const laneIndex = useMemo(() => new Map(characters.map((c, i) => [c.id, i])), [characters])
  const columns = Math.max(path.length, 1)
  const gridWidth = columns * COLUMN_WIDTH
  const gridHeight = Math.max(characters.length, 1) * ROW_HEIGHT

  // 選んだシーンの列が見えるように横へ寄せる(矢印キーや他のタブからの選択に追従する)
  const headerRefs = useRef(new Map<string, HTMLButtonElement>())
  useEffect(() => {
    if (!selectedNodeId) return
    headerRefs.current.get(selectedNodeId)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [selectedNodeId])

  const selectedIndex = selectedNodeId ? path.findIndex((n) => n.id === selectedNodeId) : -1

  if (path.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-[12px]" style={{ color: 'var(--text-faint)' }}>
        正史のシーンがまだありません。「+ シーン」または「▶ 生成」で物語を始めると、人物ごとの出番が並びます
      </div>
    )
  }

  return (
    <div className="inspector-scrollbar min-h-0 flex-1 overflow-auto">
      <div className="relative" style={{ width: LABEL_WIDTH + gridWidth, paddingBottom: 12 }}>
        {/* 見出し: 章の帯 + シーンのタイトル。縦スクロールしても残す */}
        <div className="sticky top-0 z-20" style={{ background: 'var(--bg-canvas)' }}>
          <div className="grid" style={{ gridTemplateColumns: `${LABEL_WIDTH}px ${gridWidth}px` }}>
            <div className="sticky left-0 z-10" style={{ background: 'var(--bg-canvas)' }} />
            <div className="relative" style={{ height: CHAPTER_ROW_HEIGHT }}>
              {spans.map((span) => {
                const color = span.group.color ?? FALLBACK_COLOR
                const order = groups.indexOf(span.group)
                const label = span.group.on_canon ? `第${order + 1}章「${span.group.title}」` : `別ルートの章「${span.group.title}」`
                return (
                  <div
                    key={`${span.group.id}-${span.start}`}
                    className="absolute top-0.5 truncate rounded-md border px-1.5 text-[10px] font-medium leading-[16px]"
                    style={{
                      left: span.start * COLUMN_WIDTH + 2,
                      width: (span.end - span.start) * COLUMN_WIDTH - 4,
                      background: `${color}33`,
                      borderColor: color,
                      color
                    }}
                    data-tip={`${label}(${span.end - span.start} シーン)`}
                  >
                    {label}
                  </div>
                )
              })}
            </div>
          </div>
          <div className="grid border-b" style={{ gridTemplateColumns: `${LABEL_WIDTH}px repeat(${columns}, ${COLUMN_WIDTH}px)`, borderColor: 'var(--border)' }}>
            <div
              className="sticky left-0 z-10 flex items-end px-3 pb-1 text-[11px]"
              style={{ background: 'var(--bg-canvas)', color: 'var(--text-faint)', height: TITLE_ROW_HEIGHT }}
              data-tip="セルや見出しをクリックすると、そのシーンを選択して下の詳細欄に出します"
            >
              {hiddenCount > 0 ? `正史のみ(分岐・島の ${hiddenCount} シーンは非表示)` : '正史のシーン'}
            </div>
            {path.map((node, index) => (
              <button
                key={node.id}
                ref={(el) => {
                  if (el) headerRefs.current.set(node.id, el)
                  else headerRefs.current.delete(node.id)
                }}
                onClick={() => onSelectNode(node.id)}
                className="m-0.5 truncate rounded-md px-1.5 py-0.5 text-left text-[11px] hover:bg-[var(--accent-soft)]"
                style={{
                  background: index === selectedIndex ? 'var(--accent-soft)' : 'transparent',
                  color: index === selectedIndex ? 'var(--text)' : 'var(--text-dim)'
                }}
                data-tip={`${index + 1}. ${node.title || '(無題)'}\nクリックで選択(詳細欄で編集できます)`}
              >
                <span className="tabular-nums" style={{ color: 'var(--text-faint)' }}>{index + 1}.</span>{' '}
                {node.title || '(無題)'}
              </button>
            ))}
          </div>
        </div>

        {/* レーン本体: 左に人物の名前、右に出番のセル。線は SVG で下に敷く */}
        <div className="grid" style={{ gridTemplateColumns: `${LABEL_WIDTH}px ${gridWidth}px` }}>
          <div className="sticky left-0 z-10" style={{ background: 'var(--bg-canvas)' }}>
            {characters.map((c) => {
              const count = appearances.get(c.id)?.length ?? 0
              return (
                <div
                  key={c.id}
                  className="flex items-center gap-2 border-b px-3 text-[12px]"
                  style={{ height: ROW_HEIGHT, borderColor: 'var(--border)', color: count > 0 ? 'var(--text)' : 'var(--text-faint)' }}
                  data-tip={count > 0 ? `${c.name}: ${count} シーンに登場` : `${c.name}: 正史にはまだ登場していません`}
                >
                  <CharAvatar char={c} size={22} />
                  <span className="min-w-0 flex-1 truncate">{c.name}</span>
                  <span className="shrink-0 tabular-nums text-[11px]" style={{ color: 'var(--text-faint)' }}>{count}</span>
                </div>
              )
            })}
            {characters.length === 0 && (
              <div className="px-3 text-[11px]" style={{ height: ROW_HEIGHT, lineHeight: `${ROW_HEIGHT}px`, color: 'var(--text-faint)' }}>
                キャラクターがいません
              </div>
            )}
          </div>
          <div className="relative" style={{ height: gridHeight }}>
            {/* 選択中のシーンの列を薄く塗る */}
            {selectedIndex >= 0 && (
              <div
                className="absolute inset-y-0"
                style={{ left: selectedIndex * COLUMN_WIDTH, width: COLUMN_WIDTH, background: 'var(--accent-soft)' }}
              />
            )}
            <svg
              className="absolute inset-0"
              width={gridWidth}
              height={gridHeight}
              style={{ pointerEvents: 'none' }}
              aria-hidden="true"
            >
              {/* レーンの区切り線 */}
              {characters.map((c, i) => (
                <line key={`row-${c.id}`} x1={0} x2={gridWidth} y1={(i + 1) * ROW_HEIGHT - 0.5} y2={(i + 1) * ROW_HEIGHT - 0.5} stroke="var(--border)" />
              ))}
              {/* 人物ごとの横線(初登場から最後の出番まで) */}
              {characters.map((c, i) => {
                const cols = appearances.get(c.id) ?? []
                if (cols.length < 2) return null
                const y = i * ROW_HEIGHT + ROW_HEIGHT / 2
                return (
                  <line
                    key={`lane-${c.id}`}
                    x1={cols[0] * COLUMN_WIDTH + COLUMN_WIDTH / 2}
                    x2={cols[cols.length - 1] * COLUMN_WIDTH + COLUMN_WIDTH / 2}
                    y1={y}
                    y2={y}
                    stroke={c.color ?? FALLBACK_COLOR}
                    strokeWidth={2}
                    strokeOpacity={0.6}
                  />
                )
              })}
              {/* シーンごとの縦線(cast のいちばん上のレーンから下のレーンまで) */}
              {castSets.map((cast, index) => {
                const lanes = [...cast].map((id) => laneIndex.get(id)).filter((v): v is number => v !== undefined)
                if (lanes.length < 2) return null
                const x = index * COLUMN_WIDTH + COLUMN_WIDTH / 2
                return (
                  <line
                    key={`col-${path[index].id}`}
                    x1={x}
                    x2={x}
                    y1={Math.min(...lanes) * ROW_HEIGHT + ROW_HEIGHT / 2}
                    y2={Math.max(...lanes) * ROW_HEIGHT + ROW_HEIGHT / 2}
                    stroke={index === selectedIndex ? 'var(--accent)' : 'var(--text-faint)'}
                    strokeWidth={2}
                  />
                )
              })}
            </svg>
            {/* 出番のセル */}
            {characters.map((c, i) =>
              (appearances.get(c.id) ?? []).map((index) => {
                const node = path[index]
                const color = c.color ?? FALLBACK_COLOR
                const selected = index === selectedIndex
                return (
                  <button
                    key={`${c.id}-${node.id}`}
                    onClick={() => onSelectNode(node.id)}
                    className="absolute rounded-md border"
                    style={{
                      left: index * COLUMN_WIDTH + CELL_INSET,
                      top: i * ROW_HEIGHT + (ROW_HEIGHT - CELL_HEIGHT) / 2,
                      width: COLUMN_WIDTH - CELL_INSET * 2,
                      height: CELL_HEIGHT,
                      // 線はセルの下を通るので、色の下地の下にキャンバスの地を敷いて透けないようにする
                      background: `linear-gradient(${color}33, ${color}33), var(--bg-canvas)`,
                      borderColor: color,
                      borderWidth: 1.5,
                      boxShadow: selected ? '0 0 0 2px var(--accent-border)' : undefined
                    }}
                    aria-label={`${c.name}: ${node.title || '(無題)'}`}
                    data-tip={`${c.name} が「${node.title || '(無題)'}」に登場\nクリックで選択(詳細欄で編集できます)`}
                  />
                )
              })
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
