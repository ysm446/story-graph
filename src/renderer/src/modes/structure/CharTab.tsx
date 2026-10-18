import DetailSplit from '../../DetailSplit'
import { useEffect, useState } from 'react'
import { api } from '../../api'
import CharAvatar from '../../CharAvatar'
import RelationBar from '../../RelationBar'
import type { Character, StateSnapshot, StoryEvent, StoryNode } from '../../types'
import { latestEventInputs } from './events'
import { NodeThumb } from './StructureNodes'

// ---- キャラタブ(状態閲覧 + 手動イベント化する編集) -------------------

/** 記憶 1 件の本文と出どころ。まとめ(digest)の記憶はシーンではなく章に属する */
export type MemorySource = {
  kind: 'scene' | 'digest'
  content: string
  /** 出どころのシーン(digest は章の最後のシーン。無ければ null) */
  nodeId: string | null
  /** シーン名(kind: 'scene')または章名(kind: 'digest') */
  title: string
  /** 出どころの単位(シーン ID、まとめは 'chapter:<章 ID>')。続けて同じ出どころの記憶を 1 枚にまとめる */
  sourceKey: string
  /** カードに出す挿絵のシーン(シーンはその挿絵、まとめは章の表紙。無ければ null) */
  thumb: StoryNode | null
}

type MemoryGroup = { key: string; memory: MemorySource | undefined; eventIds: string[] }

/** 並び順のまま、隣り合っていて出どころが同じ記憶をひとまとめにする
 *  (シーンごとに集め直さない。並びが物語の順からずれて見えないように)。
 *  本文が引けない記憶は 1 件ずつ */
function groupMemories(eventIds: string[], memoryContents: Record<string, MemorySource>): MemoryGroup[] {
  const groups: MemoryGroup[] = []
  for (const eventId of eventIds) {
    const memory = memoryContents[eventId]
    const last = groups[groups.length - 1]
    if (memory && last?.memory?.sourceKey === memory.sourceKey) last.eventIds.push(eventId)
    else groups.push({ key: eventId, memory, eventIds: [eventId] })
  }
  return groups
}

function memorySourceTip(memory: MemorySource): string {
  return memory.kind === 'digest'
    ? `章「${memory.title}」のまとめ(クリックでその章の最後のシーンへ)`
    : `「${memory.title}」で得た記憶(クリックでそのシーンへ)`
}

export function CharTab({
  node,
  characters,
  memoryContents,
  onChanged,
  onSelectNode,
  focusChar,
  lockChar
}: {
  node: StoryNode
  characters: Character[]
  /** 記憶イベント ID → 本文と出どころ */
  memoryContents: Record<string, MemorySource>
  onChanged: () => void
  onSelectNode: (nodeId: string) => void
  /** 外から人物を指定する(出番表やカードの札で人物をクリックしたとき)。
   *  同じ人物を続けて指しても効くよう、押すたびに増える番号を添える */
  focusChar?: { id: string; seq: number } | null
  /** 人物を固定する(左の登場人物の一覧を出さない)。詳細欄の人物専用の表示で使う */
  lockChar?: boolean
}): React.JSX.Element {
  const [state, setState] = useState<StateSnapshot | null>(null)
  const [charId, setCharId] = useState<string | null>(focusChar?.id && node.cast.includes(focusChar.id) ? focusChar.id : node.cast[0] ?? null)
  useEffect(() => {
    if (focusChar && node.cast.includes(focusChar.id)) setCharId(focusChar.id)
  }, [focusChar, node.cast])
  const [factKey, setFactKey] = useState('')
  const [factValue, setFactValue] = useState('')
  const [relTarget, setRelTarget] = useState('')
  const [relValue, setRelValue] = useState('0')
  const [relReason, setRelReason] = useState('')
  const [relLabel, setRelLabel] = useState('')
  const [memContent, setMemContent] = useState('')
  const [error, setError] = useState<string | null>(null)
  // 記憶の並び順。既定は新しい順(直近の変化が上に来て差分が見やすい)
  const [memNewestFirst, setMemNewestFirst] = useState(
    () => localStorage.getItem('memoriesOldestFirst') !== '1'
  )

  const eventsKey = node.events.map((e) => e.id).join(',')

  // シーンが変わったら、前のシーンの状態を出したままにしない。
  // 矢印キーで次々に切り替えると取得が複数走るので、古い応答は捨てる
  // (捨てないと、後から返ってきた前のシーンの状態が残り続ける)
  useEffect(() => {
    setCharId((prev) => (prev && node.cast.includes(prev) ? prev : node.cast[0] ?? null))
    let ignore = false
    setState(null)
    void api
      .getState(node.id)
      .then((s) => {
        if (!ignore) setState(s)
      })
      .catch(() => {
        if (!ignore) setState(null)
      })
    return () => {
      ignore = true
    }
  }, [node.id, node.updated_at, eventsKey])

  // 書きかけの入力とエラーは前のシーンのものなので、切り替えたら捨てる
  useEffect(() => {
    setError(null)
    setFactKey('')
    setFactValue('')
    setRelTarget('')
    setRelReason('')
    setRelLabel('')
    setMemContent('')
  }, [node.id])

  const charState = charId ? state?.chars[charId] : null
  const nameOf = (id: string): string => characters.find((c) => c.id === id)?.name ?? id

  const appendEvent = async (event: StoryEvent['payload'] & object, type: string): Promise<void> => {
    setError(null)
    try {
      await api.putEvents(node.id, [
        ...(await latestEventInputs(node.id, node.events)),
        { type, payload: event as Record<string, unknown>, source: 'user' as const }
      ])
      onChanged()
    } catch (e) {
      setError(String(e))
    }
  }

  const inputStyle = { background: 'var(--bg-input)', borderColor: 'var(--border)' }

  return (
    <div className="char-detail flex min-h-0 flex-1 flex-col">
      {/* 左に登場人物の一覧(資料庫の一覧と同じ行: アイコン + 名前)、右に選んだ人物の状態。
          下段は横に広く縦に短いので、選択を上の行ではなく左の列に置く。狭いときは上の横並びに戻す(index.css の char-detail) */}
      <div className="char-detail-layout">
      {!lockChar && (
      <div data-view-ok className="char-detail-list inspector-scrollbar" role="group" aria-label="このシーンの登場人物">
        {node.cast.map((id) => {
          const character = characters.find((c) => c.id === id)
          return (
            <button
              key={id}
              onClick={() => setCharId(id)}
              aria-pressed={id === charId}
              className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px]"
              style={id === charId ? { background: 'var(--accent-soft)', color: 'var(--text)' } : { color: 'var(--text-dim)' }}
              data-tip={nameOf(id)}
            >
              {character ? <CharAvatar char={character} size={24} /> : <span className="h-6 w-6 shrink-0" />}
              <span className="min-w-0 flex-1 truncate">{nameOf(id)}</span>
            </button>
          )
        })}
      </div>
      )}
      <div className="scene-detail flex min-h-0 min-w-0 flex-1 flex-col">
      {node.cast.length === 0 && (
        <div className="text-[12px]" style={{ color: 'var(--text-faint)' }}>
          cast が空です
        </div>
      )}
      {error && (
        <div className="text-[12px]" style={{ color: 'var(--danger-text)' }}>
          {error}
        </div>
      )}
      {charId && charState && (
        <DetailSplit storageKey="characterDetailMetaWidth" main={<>
          <section>
            <div className="mb-1 flex items-center justify-between">
              <h4 className="text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-faint)' }}>
                Memories({charState.memories.length})
              </h4>
              {charState.memories.length > 1 && (
                <button
                  onClick={() => {
                    setMemNewestFirst((prev) => {
                      localStorage.setItem('memoriesOldestFirst', prev ? '1' : '0')
                      return !prev
                    })
                  }}
                  className="text-[10px] hover:underline"
                  style={{ color: 'var(--text-faint)' }}
                  data-tip="並び順を切り替える"
                >
                  {memNewestFirst ? '新 → 古' : '古 → 新'}
                </button>
              )}
            </div>
            {/* fold の積み順が古い順なので、新しい順は反転して出す。続けて同じシーン(章のまとめは同じ章)
                から得た記憶は 1 枚のカードにまとめ、挿絵と出どころは 1 回だけ出す */}
            {groupMemories(memNewestFirst ? [...charState.memories].reverse() : charState.memories, memoryContents).map(
              ({ key, memory, eventIds }) => {
                const current = !!memory?.nodeId && memory.nodeId === node.id
                return (
                  <div
                    key={key}
                    data-memory-group
                    className="mb-1 flex gap-2.5 rounded-lg border px-3 py-1.5 text-[12px] leading-relaxed"
                    style={{
                      background: 'var(--bg-elevated)',
                      borderColor: current ? 'var(--accent-border)' : 'var(--border)',
                      color: 'var(--text-dim)'
                    }}
                  >
                    {/* 挿絵は高さを揃えて中央で切り抜く(キャラクタービューの見出しと同じ)。記憶が多くても伸ばさない */}
                    {memory?.thumb &&
                      (memory.nodeId ? (
                        <button
                          onClick={() => onSelectNode(memory.nodeId!)}
                          className="mt-1 shrink-0 self-start"
                          aria-label={memorySourceTip(memory)}
                          data-tip={memorySourceTip(memory)}
                        >
                          <NodeThumb node={memory.thumb} className="block h-10 w-16 rounded-md object-cover" />
                        </button>
                      ) : (
                        <NodeThumb
                          node={memory.thumb}
                          className="mt-1 block h-10 w-16 shrink-0 self-start rounded-md object-cover"
                        />
                      ))}
                    <div className="min-w-0 flex-1">
                      {eventIds.map((eventId, i) => (
                        <div
                          key={eventId}
                          className={i > 0 ? 'mt-1 border-t pt-1' : undefined}
                          style={i > 0 ? { borderColor: 'var(--border)' } : undefined}
                        >
                          {/* 本文が引けないときも ID は出さない(読めない文字列が並ぶだけなので) */}
                          {memoryContents[eventId]?.content || (
                            <span style={{ color: 'var(--text-faint)' }} data-tip={eventId}>
                              (本文が見つかりません)
                            </span>
                          )}
                        </div>
                      ))}
                      {/* どこで得た記憶か。シーンなら押すとそのシーンへ、章のまとめなら章の最後のシーンへ */}
                      {memory &&
                        (memory.nodeId ? (
                          <button
                            onClick={() => onSelectNode(memory.nodeId!)}
                            className="mt-0.5 block max-w-full truncate text-left text-[10px] hover:underline"
                            style={{ color: current ? 'var(--accent)' : 'var(--text-faint)' }}
                            data-tip={memorySourceTip(memory)}
                          >
                            ← {memory.kind === 'digest' ? `${memory.title}(章のまとめ)` : memory.title}
                            {current ? '(このシーン)' : ''}
                          </button>
                        ) : (
                          <span
                            className="mt-0.5 block max-w-full truncate text-[10px]"
                            style={{ color: 'var(--text-faint)' }}
                            data-tip={`章「${memory.title}」のまとめ`}
                          >
                            ← {memory.title}(章のまとめ)
                          </span>
                        ))}
                    </div>
                  </div>
                )
              }
            )}
            <div className="mt-1 flex gap-1">
              <input
                placeholder="記憶を追加(このキャラ視点で)"
                value={memContent}
                onChange={(e) => setMemContent(e.target.value)}
                className="min-w-0 flex-1 rounded-md border px-2 py-1 text-[12px]"
                style={inputStyle}
              />
              <button
                onClick={() => {
                  if (!memContent.trim()) return
                  void appendEvent(
                    { char: charId, content: memContent.trim(), emotion: 0, importance: 0.5, refs: [] },
                    'memory_add'
                  )
                  setMemContent('')
                }}
                className="rounded-md px-2 py-0.5 text-[12px] font-medium text-white"
                style={{ background: 'var(--accent)' }}
                aria-label="memory_add イベントとして記録"
                data-tip="memory_add イベントとして記録"
              >
                +
              </button>
            </div>
          </section>

        </>} secondary={<>

          <section>
            <h4 className="mb-1 text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-faint)' }}>
              Facts
            </h4>
            {Object.entries(charState.facts).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-2 py-0.5 text-[12px] [overflow-wrap:anywhere]">
                <span style={{ color: 'var(--text-dim)' }}>{k}</span>
                <span style={{ color: 'var(--text)' }}>{JSON.stringify(v)}</span>
              </div>
            ))}
            {charState.status === 'retired' && (
              <div className="mt-1 text-[12px]" style={{ color: 'var(--danger-text)' }}>
                退場済み({charState.retire_reason})
              </div>
            )}
            <div className="mt-1 flex gap-1">
              <input
                placeholder="key"
                value={factKey}
                onChange={(e) => setFactKey(e.target.value)}
                className="w-24 rounded-md border px-2 py-1 text-[12px]"
                style={inputStyle}
              />
              <input
                placeholder="value"
                value={factValue}
                onChange={(e) => setFactValue(e.target.value)}
                className="min-w-0 flex-1 rounded-md border px-2 py-1 text-[12px]"
                style={inputStyle}
              />
              <button
                onClick={() => {
                  if (!factKey.trim()) return
                  void appendEvent({ scope: 'char', char: charId, key: factKey.trim(), value: factValue }, 'fact_set')
                  setFactKey('')
                  setFactValue('')
                }}
                className="rounded-md px-2 py-0.5 text-[12px] font-medium text-white"
                style={{ background: 'var(--accent)' }}
                aria-label="fact_set イベントとして記録"
                data-tip="fact_set イベントとして記録"
              >
                +
              </button>
            </div>
          </section>
          <section>
            <h4 className="mb-1 text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-faint)' }}>
              Relationships
            </h4>
            {Object.entries(charState.relationships).map(([target, rel]) => (
              <div key={target} className="mb-1.5 flex items-center gap-2 text-[12px]">
                {/* 相手はアイコンでも示す(名前だけだと並んだときに見分けにくい) */}
                <span className="flex w-32 min-w-0 shrink-0 items-center gap-2" style={{ color: 'var(--text-dim)' }} data-tip={nameOf(target)}>
                  {characters.find((c) => c.id === target)
                    ? <CharAvatar char={characters.find((c) => c.id === target)!} size={24} />
                    : <span className="h-6 w-6 shrink-0" />}
                  <span className="min-w-0 flex-1 truncate">{nameOf(target)}</span>
                </span>
                {/* 0 を中心に、好意は右へ・反感は左へ伸ばす(-1.0〜+1.0) */}
                <RelationBar
                  score={rel.score}
                  className="flex-1"
                  tip={`${nameOf(target)} への好感度 ${rel.score.toFixed(2)}`}
                />
                <span className="w-10 text-right tabular-nums" style={{ color: 'var(--text)' }}>
                  {rel.score.toFixed(2)}
                </span>
              </div>
            ))}
            <div className="mt-1 flex flex-wrap gap-1">
              <select
                value={relTarget}
                onChange={(e) => setRelTarget(e.target.value)}
                className="rounded-md border px-2 py-1 text-[12px]"
                style={inputStyle}
              >
                <option value="">相手…</option>
                {characters
                  .filter((c) => c.id !== charId)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </select>
              <input
                type="number"
                min={-1}
                max={1}
                step={0.05}
                value={relValue}
                onChange={(e) => setRelValue(e.target.value)}
                className="w-20 rounded-md border px-2 py-1 text-[12px] tabular-nums"
                style={inputStyle}
              />
              <input
                placeholder="理由"
                value={relReason}
                onChange={(e) => setRelReason(e.target.value)}
                className="min-w-0 flex-1 rounded-md border px-2 py-1 text-[12px]"
                style={inputStyle}
              />
              <input
                placeholder="一言(相関図表示)"
                value={relLabel}
                onChange={(e) => setRelLabel(e.target.value)}
                className="w-28 rounded-md border px-2 py-1 text-[12px]"
                style={inputStyle}
                data-tip="相関図の矢印に添える一言(例: 幼なじみ)"
              />
              <button
                onClick={() => {
                  if (!relTarget) return
                  const payload: Record<string, unknown> = {
                    char: charId,
                    target_type: 'char',
                    target: relTarget,
                    value: Number(relValue),
                    reason: relReason || '手動修正'
                  }
                  if (relLabel.trim()) payload.label = relLabel.trim()
                  void appendEvent(payload, 'relationship_set')
                  setRelReason('')
                  setRelLabel('')
                }}
                className="rounded-md px-2 py-0.5 text-[12px] font-medium text-white"
                style={{ background: 'var(--accent)' }}
                data-tip="relationship_set イベントとして記録"
              >
                set
              </button>
            </div>
          </section>

        </>} />
      )}
      {charId && !charState && state && (
        <div className="text-[12px]" style={{ color: 'var(--text-faint)' }}>
          このキャラはまだ物語に登場していません(char_introduce 前)
        </div>
      )}
      </div>
      </div>
    </div>
  )
}
