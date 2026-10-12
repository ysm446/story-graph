import { useMemo, useState } from 'react'
import CharAvatar from './CharAvatar'
import { Icon } from './icons'
import type { Character, StoryNode } from './types'

/** 事実(fact_set)の状態帯タイムライン。
 *
 * facts は「あるシーンで値が立ち、次に上書きされるまで続く」性質なので、
 * キーごとのレーンに区間の帯として描く。帯をクリックすると値が立った
 * シーンを選択する。
 *
 * 表示するのはパス上の fact_set イベントだけで、fold はしない
 * (どのシーンで変わったかを見るのが目的なので、イベントを直接読む)。
 */

interface Band {
  key: string
  value: string
  start: number // パス上のインデックス(このシーンで値が立った)
  end: number // この直前まで続く(排他)
  nodeId: string
}

const COLUMN_WIDTH = 96
const KEY_WIDTH = 140

function valueLabel(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/** パス上の fact_set を走査して、キーごとの区間に組み直す */
function buildBands(path: StoryNode[], charId: string | null): { keys: string[]; bands: Band[] } {
  const open = new Map<string, Band>()
  const bands: Band[] = []
  const keys: string[] = []

  path.forEach((node, index) => {
    for (const event of node.events) {
      if (event.type !== 'fact_set') continue
      const payload = event.payload as { scope?: string; char?: string; key?: string; value?: unknown }
      const scope = payload.scope ?? 'char'
      // charId 指定時はそのキャラの facts、null のときは世界の facts
      if (charId ? !(scope === 'char' && payload.char === charId) : scope !== 'world') continue
      const key = payload.key ?? '(key なし)'
      if (!keys.includes(key)) keys.push(key)
      const previous = open.get(key)
      const value = valueLabel(payload.value)
      if (previous) {
        if (previous.value === value) continue // 同じ値の再設定は区間を続ける
        // 同じシーン内で上書きされた値は区間を持たない(後勝ちなので捨てる)
        if (previous.start !== index) {
          previous.end = index
          bands.push(previous)
        }
      }
      open.set(key, { key, value, start: index, end: path.length, nodeId: node.id })
    }
  })
  for (const band of open.values()) bands.push(band)
  return { keys, bands }
}

export default function FactTimeline({
  path,
  characters,
  selectedNodeId,
  onSelectNode
}: {
  path: StoryNode[]
  characters: Character[]
  selectedNodeId: string | null
  onSelectNode: (nodeId: string) => void
}): React.JSX.Element {
  // 表示対象。null = 世界の facts
  const [target, setTarget] = useState<string | null>(() => characters[0]?.id ?? null)
  // 削除済み・読み込み前のキャラを指したままにしない(一覧に該当の行が無いのに、
  // 帯だけ居ないキャラで計算されてしまう)
  const effectiveTarget =
    target !== null && !characters.some((c) => c.id === target)
      ? (characters[0]?.id ?? null)
      : target
  const { keys, bands } = useMemo(
    () => buildBands(path, effectiveTarget),
    [path, effectiveTarget]
  )
  const gridWidth = Math.max(path.length, 1) * COLUMN_WIDTH

  return (
    <div className="char-detail flex min-h-0 flex-1 flex-col">
      {/* 左に対象の一覧(キャラタブと同じ行: アイコン + 名前)、右に事実の帯。対象は人物の全員と、
          人物に属さない「世界」。狭いときは上の横並びに戻す(index.css の char-detail) */}
      <div className="char-detail-layout">
      <div className="char-detail-list inspector-scrollbar" role="group" aria-label="事実を見る対象">
        {characters.map((c) => (
          <button
            key={c.id}
            onClick={() => setTarget(c.id)}
            aria-pressed={c.id === effectiveTarget}
            className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px]"
            style={c.id === effectiveTarget ? { background: 'var(--accent-soft)', color: 'var(--text)' } : { color: 'var(--text-dim)' }}
            data-tip={c.name}
          >
            <CharAvatar char={c} size={24} />
            <span className="min-w-0 flex-1 truncate">{c.name}</span>
          </button>
        ))}
        <button
          onClick={() => setTarget(null)}
          aria-pressed={effectiveTarget === null}
          className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] fact-world-row"
          style={effectiveTarget === null ? { background: 'var(--accent-soft)', color: 'var(--text)' } : { color: 'var(--text-dim)' }}
          data-tip="人物に属さない事実(天候・情勢など)"
        >
          <span className="flex h-6 w-6 shrink-0 items-center justify-center"><Icon name="globe" size={16} /></span>
          <span className="min-w-0 flex-1 truncate">世界</span>
        </button>
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {keys.length === 0 ? (
        <div className="py-6 text-center text-[12px]" style={{ color: 'var(--text-faint)' }}>
          このパスに fact_set がありません。
          <br />
          シーンのイベントに fact_set(location / goal など)が入ると帯が並びます。
        </div>
      ) : (
        <div className="inspector-scrollbar min-h-0 flex-1 overflow-auto px-5 py-3">
          <div style={{ width: gridWidth + KEY_WIDTH }}>
            {/* シーンの見出し(選択中のシーンを強調) */}
            <div
              className="sticky top-0 z-20 mb-1 grid"
              style={{ gridTemplateColumns: `${KEY_WIDTH}px repeat(${Math.max(path.length, 1)}, ${COLUMN_WIDTH}px)`, background: 'var(--bg-sidebar)' }}
            >
              <div className="sticky left-0 z-10 px-2 py-1 text-[11px]" style={{ background: 'var(--bg-sidebar)', color: 'var(--text-faint)' }}
                data-tip="帯をクリックすると、値が変わったシーンを選択します">項目</div>
              {path.map((node, index) => (
                <button
                  key={node.id}
                  onClick={() => onSelectNode(node.id)}
                  className="m-0.5 truncate rounded px-1 py-0.5 text-left text-[10px]"
                  style={{
                    background: node.id === selectedNodeId ? 'var(--accent-soft)' : 'transparent',
                    color: node.id === selectedNodeId ? 'var(--text)' : 'var(--text-faint)'
                  }}
                  data-tip={node.title || '(無題)'}
                >
                  {index + 1}. {node.title || '(無題)'}
                </button>
              ))}
            </div>
            {/* キーごとのレーン */}
            {keys.map((key) => (
              <div key={key} className="mb-1 grid" style={{ gridTemplateColumns: `${KEY_WIDTH}px ${gridWidth}px` }}>
                <div className="sticky left-0 z-10 px-2 py-1 text-[11px] break-words" style={{ background: 'var(--bg-sidebar)', color: 'var(--text-dim)' }}>
                  {key}
                </div>
                <div
                  className="grid"
                  style={{ gridTemplateColumns: `repeat(${Math.max(path.length, 1)}, ${COLUMN_WIDTH}px)` }}
                >
                  {bands
                    .filter((b) => b.key === key)
                    .map((band) => (
                      <button
                        key={`${band.key}-${band.start}`}
                        onClick={() => onSelectNode(band.nodeId)}
                        className="m-0.5 min-w-0 truncate rounded-md border px-1.5 py-1 text-left text-[11px]"
                        style={{
                          gridColumn: `${band.start + 1} / span ${Math.max(band.end - band.start, 1)}`,
                          background: 'var(--accent-soft)',
                          borderColor:
                            band.nodeId === selectedNodeId ? 'var(--accent-border)' : 'var(--border-strong)',
                          color: 'var(--text)'
                        }}
                        data-tip={`${key} = ${band.value}(${band.start + 1} 話目から${
                          band.end < path.length ? ` ${band.end} 話目まで` : '現在まで'
                        })\nクリックで値が変わったシーンを選択`}
                      >
                        {band.value}
                      </button>
                    ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      </div>
      </div>
    </div>
  )
}
