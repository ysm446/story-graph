import { useEffect, useRef, useState } from 'react'
import { api, isAbortError } from './api'
import { enqueueTask, notifyGraphChanged, useTaskFor } from './tasks'
import type { Character, EventInput, StoryEvent, StoryNode } from './types'
import { useElapsedSeconds } from './useElapsed'

/** イベントの追加・編集・削除。
 *
 * payload は型ごとに形が違うので、JSON を手で書かせるのではなく型ごとの
 * フォーム(プルダウン / スライダー / テキスト)に落とす。LLM が抽出した
 * イベントも同じフォームで編集できる。
 */

type Payload = Record<string, unknown>

const TYPE_LABELS: Record<string, string> = {
  memory_add: '記憶を追加',
  relationship_update: '関係を変化(加算)',
  relationship_set: '関係を設定(絶対値)',
  fact_set: '事実を設定',
  char_retire: '退場',
  memory_compress: '記憶を圧縮',
  manual_override: '手動上書き(上級)'
}

// 手動で追加できる型(char_introduce は cast から導出されるので出さない)
const ADDABLE_TYPES = Object.keys(TYPE_LABELS)

const DEFAULT_PAYLOADS: Record<string, Payload> = {
  memory_add: { char: '', content: '', emotion: 0, importance: 0.5 },
  relationship_update: { char: '', target_type: 'char', target: '', delta: 0.1, reason: '', label: '' },
  relationship_set: { char: '', target_type: 'char', target: '', value: 0, reason: '', label: '' },
  fact_set: { scope: 'char', char: '', key: 'location', value: '' },
  char_retire: { char: '', reason: 'death' },
  memory_compress: { char: '', replaces: [], summary: '', importance: 0.5 },
  manual_override: { path: '', value: '', note: '' }
}

const inputStyle = { background: 'var(--bg-input)', borderColor: 'var(--border)' }
const fieldClass = 'w-full rounded-md border px-2 py-1 text-[12px] outline-none'

function num(value: unknown, fallback = 0): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function str(value: unknown): string {
  if (value === null || value === undefined) return ''
  return typeof value === 'string' ? value : String(value)
}

/** 一覧に出す 1 行の要約(人が読める形) */
export function eventSummary(
  type: string,
  payload: Payload,
  nameOf: (id: string) => string
): string {
  const p = payload
  switch (type) {
    case 'memory_add':
      return `${nameOf(str(p.char))}: 「${str(p.content)}」(重要度 ${num(p.importance, 0.5).toFixed(2)} / 感情 ${num(p.emotion).toFixed(1)})`
    case 'relationship_update':
      return `${nameOf(str(p.char))} → ${nameOf(str(p.target))} ${num(p.delta) >= 0 ? '+' : ''}${num(p.delta).toFixed(2)}${p.label ? `「${str(p.label)}」` : ''}`
    case 'relationship_set':
      return `${nameOf(str(p.char))} → ${nameOf(str(p.target))} = ${num(p.value).toFixed(2)}${p.label ? `「${str(p.label)}」` : ''}`
    case 'fact_set':
      return p.scope === 'world'
        ? `世界: ${str(p.key)} = ${str(p.value)}`
        : `${nameOf(str(p.char))}: ${str(p.key)} = ${str(p.value)}`
    case 'char_retire':
      return `${nameOf(str(p.char))}(理由: ${str(p.reason) || '不明'})`
    case 'memory_compress':
      return `${nameOf(str(p.char))}: ${str(p.summary)}(${Array.isArray(p.replaces) ? p.replaces.length : 0} 件を要約)`
    case 'manual_override':
      return `${str(p.path)} = ${str(p.value)}`
    default:
      return JSON.stringify(payload)
  }
}

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <label className="mb-1.5 block">
      <span className="mb-0.5 block text-[10px]" style={{ color: 'var(--text-faint)' }}>
        {label}
      </span>
      {children}
    </label>
  )
}

function CharSelect({
  value,
  characters,
  onChange,
  allowEmpty = true
}: {
  value: string
  characters: Character[]
  onChange: (v: string) => void
  allowEmpty?: boolean
}): React.JSX.Element {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={fieldClass} style={inputStyle}>
      {allowEmpty && <option value="">(選択)</option>}
      {characters.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </select>
  )
}

function Slider({
  value,
  min,
  max,
  step,
  onChange
}: {
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
}): React.JSX.Element {
  return (
    <span className="flex items-center gap-2">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="settings-slider active min-w-0 flex-1"
      />
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-16 rounded-md border px-1.5 py-0.5 text-right text-[12px] tabular-nums outline-none"
        style={inputStyle}
      />
    </span>
  )
}

/** 型ごとの入力フォーム */
function EventFields({
  type,
  payload,
  characters,
  factKeys,
  onChange
}: {
  type: string
  payload: Payload
  characters: Character[]
  factKeys: string[]
  onChange: (next: Payload) => void
}): React.JSX.Element {
  const set = (patch: Payload): void => onChange({ ...payload, ...patch })

  if (type === 'memory_add' || type === 'memory_compress') {
    const isCompress = type === 'memory_compress'
    return (
      <>
        <Row label="だれの記憶">
          <CharSelect value={str(payload.char)} characters={characters} onChange={(char) => set({ char })} />
        </Row>
        <Row label={isCompress ? '要約' : '内容(そのキャラ視点で)'}>
          <textarea
            rows={2}
            value={str(isCompress ? payload.summary : payload.content)}
            onChange={(e) => set(isCompress ? { summary: e.target.value } : { content: e.target.value })}
            className={`${fieldClass} resize-none leading-relaxed`}
            style={inputStyle}
          />
        </Row>
        {!isCompress && (
          <Row label="感情(-1 いやな記憶 〜 +1 よい記憶)">
            <Slider value={num(payload.emotion)} min={-1} max={1} step={0.1} onChange={(emotion) => set({ emotion })} />
          </Row>
        )}
        <Row label="重要度(0 些細 〜 1 人生を変える)">
          <Slider
            value={num(payload.importance, 0.5)}
            min={0}
            max={1}
            step={0.05}
            onChange={(importance) => set({ importance })}
          />
        </Row>
      </>
    )
  }

  if (type === 'relationship_update' || type === 'relationship_set') {
    const isSet = type === 'relationship_set'
    return (
      <>
        <span className="mb-1.5 flex gap-2">
          <span className="min-w-0 flex-1">
            <Row label="だれが">
              <CharSelect value={str(payload.char)} characters={characters} onChange={(char) => set({ char })} />
            </Row>
          </span>
          <span className="min-w-0 flex-1">
            <Row label="だれに対して">
              <CharSelect value={str(payload.target)} characters={characters} onChange={(target) => set({ target })} />
            </Row>
          </span>
        </span>
        <Row label={isSet ? '関係値(絶対値。-1 敵対 〜 +1 信頼)' : '変化量(-0.3〜+0.3 が目安)'}>
          <Slider
            value={num(isSet ? payload.value : payload.delta)}
            min={-1}
            max={1}
            step={0.05}
            onChange={(v) => set(isSet ? { value: v } : { delta: v })}
          />
        </Row>
        <Row label="関係の一言(相関図の矢印に出る)">
          <input
            value={str(payload.label)}
            onChange={(e) => set({ label: e.target.value })}
            placeholder="例: 幼なじみ / ライバル視 / 想いを寄せる"
            className={fieldClass}
            style={inputStyle}
          />
        </Row>
        <Row label="理由">
          <input
            value={str(payload.reason)}
            onChange={(e) => set({ reason: e.target.value })}
            className={fieldClass}
            style={inputStyle}
          />
        </Row>
      </>
    )
  }

  if (type === 'fact_set') {
    const scope = str(payload.scope) || 'char'
    return (
      <>
        <span className="mb-1.5 flex gap-2">
          <span className="w-28 shrink-0">
            <Row label="対象">
              <select
                value={scope}
                onChange={(e) => set({ scope: e.target.value })}
                className={fieldClass}
                style={inputStyle}
              >
                <option value="char">キャラ</option>
                <option value="world">世界</option>
              </select>
            </Row>
          </span>
          {scope === 'char' && (
            <span className="min-w-0 flex-1">
              <Row label="だれの">
                <CharSelect value={str(payload.char)} characters={characters} onChange={(char) => set({ char })} />
              </Row>
            </span>
          )}
        </span>
        <span className="mb-1.5 flex gap-2">
          <span className="w-36 shrink-0">
            <Row label="キー">
              <input
                list="event-fact-keys"
                value={str(payload.key)}
                onChange={(e) => set({ key: e.target.value })}
                placeholder="location"
                className={fieldClass}
                style={inputStyle}
              />
              <datalist id="event-fact-keys">
                {factKeys.map((k) => (
                  <option key={k} value={k} />
                ))}
              </datalist>
            </Row>
          </span>
          <span className="min-w-0 flex-1">
            <Row label="値">
              <input
                value={str(payload.value)}
                onChange={(e) => set({ value: e.target.value })}
                className={fieldClass}
                style={inputStyle}
              />
            </Row>
          </span>
        </span>
      </>
    )
  }

  if (type === 'char_retire') {
    return (
      <>
        <Row label="だれが退場するか">
          <CharSelect value={str(payload.char)} characters={characters} onChange={(char) => set({ char })} />
        </Row>
        <Row label="理由">
          <input
            list="event-retire-reasons"
            value={str(payload.reason)}
            onChange={(e) => set({ reason: e.target.value })}
            className={fieldClass}
            style={inputStyle}
          />
          <datalist id="event-retire-reasons">
            <option value="death" />
            <option value="departure" />
            <option value="行方不明" />
          </datalist>
        </Row>
      </>
    )
  }

  // manual_override(上級)。任意の状態パスへの代入
  return (
    <>
      <Row label="状態のパス">
        <input
          value={str(payload.path)}
          onChange={(e) => set({ path: e.target.value })}
          placeholder="chars.aya.facts.location"
          className={`${fieldClass} font-mono`}
          style={inputStyle}
        />
      </Row>
      <Row label="値">
        <input
          value={str(payload.value)}
          onChange={(e) => set({ value: e.target.value })}
          className={fieldClass}
          style={inputStyle}
        />
      </Row>
      <Row label="メモ(なぜ手で上書きしたか)">
        <input
          value={str(payload.note)}
          onChange={(e) => set({ note: e.target.value })}
          className={fieldClass}
          style={inputStyle}
        />
      </Row>
    </>
  )
}

export default function EventsEditor({
  node,
  characters,
  onChanged,
  onBusyChange
}: {
  node: StoryNode
  characters: Character[]
  onChanged: () => void
  onBusyChange: (busy: boolean) => void // キャンバス側のノードを光らせる
}): React.JSX.Element {
  const [adding, setAdding] = useState<{ type: string; payload: Payload } | null>(null)
  const [editing, setEditing] = useState<{ index: number; payload: Payload } | null>(null)
  const [saving, setSaving] = useState(false) // 手動編集の保存中(このシーンだけの状態)
  const [error, setError] = useState<string | null>(null)
  const [validation, setValidation] = useState<string[]>([])
  // 抽出の状態はキューから引く(このコンポーネントはシーンを切り替えても
  // 作り直されないので、ローカル state に持つと別のシーンに引きずられる)
  const extractTask = useTaskFor('extract', node.id)
  const extracting = extractTask?.status === 'running'
  const extractElapsed = useElapsedSeconds(extracting)
  // 抽出が終わったとき、インスペクタがまだそのシーンを映しているかの判定に使う
  const shownNodeId = useRef(node.id)
  shownNodeId.current = node.id

  // 検証結果とエラーは直前に見ていたシーンのものなので、切り替えたら捨てる
  useEffect(() => {
    setValidation([])
    setError(null)
    setAdding(null)
    setEditing(null)
  }, [node.id])

  const nameOf = (id: string): string =>
    characters.find((c) => c.id === id)?.name ?? (id || '(未選択)')
  // 既に使われている fact のキーを入力候補にする
  const factKeys = Array.from(
    new Set(
      node.events
        .filter((e) => e.type === 'fact_set')
        .map((e) => str((e.payload as Payload).key))
        .filter(Boolean)
    )
  )

  // putEvents は全件置換なので、手元の node.events を土台にすると、直前の保存が
  // reload 前だった場合にそのイベントが消える。保存前にサーバーの最新を取り直す
  const latestEvents = async (): Promise<StoryEvent[]> => {
    try {
      return (await api.getNode(node.id)).events ?? node.events
    } catch {
      return node.events
    }
  }

  const toInputs = (events: StoryEvent[]): EventInput[] =>
    events.map((e) => ({ type: e.type, payload: e.payload, source: e.source }))

  // 成功したかを返す(失敗時はフォームを閉じず入力を残す)
  const save = async (events: EventInput[]): Promise<boolean> => {
    setSaving(true)
    setError(null)
    try {
      const result = await api.putEvents(node.id, events)
      setValidation(result.validation)
      onChanged()
      return true
    } catch (e) {
      setError(String(e))
      return false
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = (index: number): void => {
    const targetId = node.events[index]?.id
    setEditing(null)
    void latestEvents().then((base) => save(toInputs(base.filter((e) => e.id !== targetId))))
  }

  const handleAdd = (): void => {
    if (!adding) return
    void latestEvents().then(async (base) => {
      const ok = await save([...toInputs(base), { type: adding.type, payload: adding.payload, source: 'user' }])
      if (ok) setAdding(null)
    })
  }

  const handleUpdate = (): void => {
    if (!editing) return
    const targetId = node.events[editing.index]?.id
    const payload = editing.payload
    void latestEvents().then(async (base) => {
      const events = toInputs(base).map((e, i) =>
        base[i].id === targetId ? { ...e, payload, source: 'user' as const } : e
      )
      const ok = await save(events)
      if (ok) setEditing(null)
    })
  }

  const runExtract = (): void => {
    setError(null)
    const targetId = node.id // 実行までにインスペクタが別のシーンを映していても対象は変えない
    enqueueTask({
      label: 'イベント抽出',
      detail: node.title || '(無題)',
      kind: 'extract',
      nodeId: targetId,
      runner: async ({ signal }) => {
        onBusyChange(true)
        try {
          const r = await api.extractEvents(targetId, signal)
          // 別のシーンに移っていたら、そのシーンの検証結果として出さない
          if (shownNodeId.current === targetId) setValidation(r.validation)
          // onChanged は積んだ時点のコンポーネントを握るので、再マウント後も
          // 届くモジュールレベルの通知で反映する
          notifyGraphChanged()
        } catch (e) {
          if (!isAbortError(e) && shownNodeId.current === targetId) setError(String(e))
        } finally {
          onBusyChange(false)
        }
      }
    })
  }

  return (
    <div className="mt-2">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-faint)' }}>
          Events({node.events.length})
        </span>
        <div className="flex gap-1.5">
          <button
            onClick={() =>
              setAdding((v) =>
                v ? null : { type: 'fact_set', payload: { ...DEFAULT_PAYLOADS['fact_set'] } }
              )
            }
            className="rounded-md border px-2 py-0.5 text-[11px]"
            style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
          >
            {adding ? 'キャンセル' : '+ 手動イベント'}
          </button>
          {/* 1 件でもキューに積む(他の処理と取り合いにならないように) */}
          <button
            onClick={runExtract}
            disabled={saving || extractTask !== null}
            className="rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-50"
            style={{ borderColor: 'var(--accent-border)', color: 'var(--accent)' }}
          >
            {extracting
              ? `処理中… (${extractElapsed}s)`
              : extractTask
                ? '待機中…'
                : 'イベント抽出(LLM)'}
          </button>
        </div>
      </div>

      {adding && (
        <div
          className="mb-2 rounded-lg border p-2"
          style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)' }}
        >
          <Row label="種類">
            <select
              value={adding.type}
              onChange={(e) =>
                setAdding({ type: e.target.value, payload: { ...DEFAULT_PAYLOADS[e.target.value] } })
              }
              className={fieldClass}
              style={inputStyle}
            >
              {ADDABLE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </Row>
          <EventFields
            type={adding.type}
            payload={adding.payload}
            characters={characters}
            factKeys={factKeys}
            onChange={(payload) => setAdding({ ...adding, payload })}
          />
          <button
            onClick={handleAdd}
            disabled={saving || extracting}
            className="rounded-md px-3 py-1 text-[12px] font-medium text-white disabled:opacity-50"
            style={{ background: 'var(--accent)' }}
          >
            追加
          </button>
        </div>
      )}

      {error && (
        <div className="mb-1 text-[12px]" style={{ color: 'var(--danger)' }}>
          {error}
        </div>
      )}
      {validation.length > 0 && (
        <div className="mb-1 text-[12px]" style={{ color: '#f2a3a3' }}>
          {validation.map((v, i) => (
            <div key={i}>⚠ {v}</div>
          ))}
        </div>
      )}
      {node.events.length === 0 && (
        <div className="text-[12px]" style={{ color: 'var(--text-faint)' }}>
          イベントなし。「+ 手動イベント」か「イベント抽出(LLM)」で状態差分を作成できます
        </div>
      )}

      {node.events.map((e, index) => {
        const open = editing?.index === index
        return (
          <div
            key={e.id}
            className="mb-1.5 rounded-lg border px-3 py-2 text-[12px]"
            style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)' }}
          >
            <div className="mb-0.5 flex items-center gap-2">
              <span className="font-medium" style={{ color: 'var(--text)' }}>
                {TYPE_LABELS[e.type] ?? e.type}
              </span>
              <span
                className="rounded px-1.5 py-px text-[10px] uppercase"
                style={
                  e.source === 'user'
                    ? { background: 'var(--accent-soft)', color: 'var(--accent)' }
                    : { background: 'var(--bg-input)', color: 'var(--text-faint)' }
                }
              >
                {e.source}
              </span>
              <button
                onClick={() => setEditing(open ? null : { index, payload: { ...(e.payload as Payload) } })}
                className="ml-auto text-[11px]"
                style={{ color: open ? 'var(--accent)' : 'var(--text-faint)' }}
                title="このイベントを編集"
              >
                {open ? '閉じる' : '✎ 編集'}
              </button>
              <button
                onClick={() => handleDelete(index)}
                disabled={saving || extracting}
                className="text-[11px]"
                style={{ color: 'var(--text-faint)' }}
                title="このイベントを削除"
              >
                ✕
              </button>
            </div>
            {open ? (
              <div className="mt-1.5">
                <EventFields
                  type={e.type}
                  payload={editing.payload}
                  characters={characters}
                  factKeys={factKeys}
                  onChange={(payload) => setEditing({ index, payload })}
                />
                <div className="flex gap-2">
                  <button
                    onClick={handleUpdate}
                    disabled={saving || extracting}
                    className="rounded-md px-3 py-1 text-[12px] font-medium text-white disabled:opacity-50"
                    style={{ background: 'var(--accent)' }}
                  >
                    保存
                  </button>
                  <button
                    onClick={() => setEditing(null)}
                    className="px-2 py-1 text-[12px]"
                    style={{ color: 'var(--text-dim)' }}
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ color: 'var(--text-dim)' }}>
                {eventSummary(e.type, e.payload as Payload, nameOf)}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
