import { useMemo, useState } from 'react'
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
  const { keys, bands } = useMemo(() => buildBands(path, target), [path, target])
  const gridWidth = Math.max(path.length, 1) * COLUMN_WIDTH

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <select
          value={target ?? '__world__'}
          onChange={(e) => setTarget(e.target.value === '__world__' ? null : e.target.value)}
          className="rounded-md border px-2 py-1 text-[12px]"
          style={{ background: 'var(--bg-input)', borderColor: 'var(--border)', color: 'var(--text-dim)' }}
        >
          {characters.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
          <option value="__world__">世界(world)</option>
        </select>
        <span className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
          帯をクリックすると値が変わったシーンを選択します
        </span>
      </div>

      {keys.length === 0 ? (
        <div className="py-6 text-center text-[12px]" style={{ color: 'var(--text-faint)' }}>
          このパスに fact_set がありません。
          <br />
          シーンのイベントに fact_set(location / goal など)が入ると帯が並びます。
        </div>
      ) : (
        <div className="inspector-scrollbar overflow-x-auto pb-1">
          <div style={{ width: gridWidth }}>
            {/* シーンの見出し(選択中のシーンを強調) */}
            <div
              className="mb-1 grid gap-1"
              style={{ gridTemplateColumns: `repeat(${Math.max(path.length, 1)}, ${COLUMN_WIDTH}px)` }}
            >
              {path.map((node, index) => (
                <button
                  key={node.id}
                  onClick={() => onSelectNode(node.id)}
                  className="truncate rounded px-1 py-0.5 text-left text-[10px]"
                  style={{
                    background: node.id === selectedNodeId ? 'var(--accent-soft)' : 'transparent',
                    color: node.id === selectedNodeId ? 'var(--text)' : 'var(--text-faint)'
                  }}
                  title={node.title || '(無題)'}
                >
                  {index + 1}. {node.title || '(無題)'}
                </button>
              ))}
            </div>
            {/* キーごとのレーン */}
            {keys.map((key) => (
              <div key={key} className="mb-1">
                <div className="mb-0.5 text-[10px]" style={{ color: 'var(--text-dim)' }}>
                  {key}
                </div>
                <div
                  className="grid gap-1"
                  style={{ gridTemplateColumns: `repeat(${Math.max(path.length, 1)}, ${COLUMN_WIDTH}px)` }}
                >
                  {bands
                    .filter((b) => b.key === key)
                    .map((band) => (
                      <button
                        key={`${band.key}-${band.start}`}
                        onClick={() => onSelectNode(band.nodeId)}
                        className="truncate rounded-md border px-1.5 py-1 text-left text-[11px]"
                        style={{
                          gridColumn: `${band.start + 1} / span ${Math.max(band.end - band.start, 1)}`,
                          background: 'var(--accent-soft)',
                          borderColor:
                            band.nodeId === selectedNodeId ? 'var(--accent-border)' : 'var(--border-strong)',
                          color: 'var(--text)'
                        }}
                        title={`${key} = ${band.value}(${band.start + 1} 話目から${
                          band.end < path.length ? ` ${band.end} 話目まで` : '現在まで'
                        })`}
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
  )
}
