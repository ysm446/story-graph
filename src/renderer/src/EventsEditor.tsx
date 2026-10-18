import { useEffect, useMemo, useRef, useState } from 'react'
import { api, isAbortError } from './api'
import CharAvatar from './CharAvatar'
import { EditActions, editKeys, EditPencil } from './FieldEdit'
import { Icon, type IconName } from './icons'
import RelationBar from './RelationBar'
import { enqueueTask, notifyGraphChanged, useTaskFor } from './tasks'
import type { Character, EventInput, StateSnapshot, StoryEvent, StoryNode } from './types'
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

/** 一覧の見出し。種類ごとに分けて並べ(同じ種類の中は保存順のまま)、件数 0 の見出しは出さない。
 *  addType = 見出しの「+」で開く手動イベントの型 */
type EventGroupKey = 'memory' | 'relation' | 'fact' | 'other'
const EVENT_GROUPS: Array<{ key: EventGroupKey; label: string; icon: IconName; addType?: string }> = [
  { key: 'memory', label: '記憶', icon: 'recall', addType: 'memory_add' },
  { key: 'relation', label: '関係', icon: 'relation', addType: 'relationship_update' },
  { key: 'fact', label: '事実', icon: 'fact', addType: 'fact_set' },
  { key: 'other', label: 'その他', icon: 'more' }
]

function eventGroupOf(type: string): EventGroupKey {
  if (type === 'memory_add' || type === 'memory_compress') return 'memory'
  if (type === 'relationship_update' || type === 'relationship_set') return 'relation'
  if (type === 'fact_set') return 'fact'
  return 'other' // 退場・手動上書きなど
}

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

/** そのイベントが「だれのことか」。アイコンを添える相手を決めるのに使う。
 *  世界の事実(scope=world)と manual_override は特定のキャラに紐づかないので null。 */
function eventCharId(type: string, payload: Payload): string | null {
  if (type === 'fact_set' && str(payload.scope) === 'world') return null
  const char = str(payload.char)
  return char || null
}

/** 関係の値(-1〜+1)の段階。「ふつう」の幅はスタイルガイドの「ほぼ中立」(絶対値 0.15 未満)に合わせる */
function relationLevel(score: number): { word: string; color: string } {
  if (score >= 0.6) return { word: '強い好意', color: 'var(--rel-positive)' }
  if (score >= 0.15) return { word: '好意', color: 'var(--rel-positive)' }
  if (score > -0.15) return { word: 'ふつう', color: 'var(--text-faint)' }
  if (score > -0.6) return { word: '反感', color: 'var(--rel-negative)' }
  return { word: '強い反感', color: 'var(--rel-negative)' }
}

/** 関係イベント 1 件の前後の値。before = null はこのシーンまで関係がまだ無かった */
type RelationStep = { before: number | null; after: number }

/** 関係が「どこからどこへ」動いたか。今の関係(段階の言葉 + バー)と今回の変化(▲▼ と言葉)を分けて出す。
 *  符号付きの数だけだと、変化の向きと関係の良し悪しが区別できないため */
function RelationChange({
  type,
  payload,
  step
}: {
  type: string
  payload: Payload
  step: RelationStep | null
}): React.JSX.Element {
  // 直前の状態がまだ読めていないときは、イベントに書いてある数だけ出す
  if (!step) {
    return (
      <div className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
        {type === 'relationship_set'
          ? `関係を ${num(payload.value).toFixed(2)} に`
          : `${num(payload.delta) >= 0 ? '▲' : '▼'} ${Math.abs(num(payload.delta)).toFixed(2)}`}
      </div>
    )
  }
  const { before, after } = step
  const delta = after - (before ?? 0)
  const from = before === null ? null : relationLevel(before)
  const to = relationLevel(after)
  const trend =
    delta > 0.005
      ? { text: '▲ 良くなった', color: 'var(--rel-positive)' }
      : delta < -0.005
        ? { text: '▼ 悪くなった', color: 'var(--rel-negative)' }
        : { text: '変わらず', color: 'var(--text-faint)' }
  return (
    <div className="mt-1">
      {/* キャラタブの関係のバーと同じ形。直前の値は同じ色の薄い塗りで下に敷く */}
      <div className="flex items-center gap-2 text-[10px]" style={{ color: 'var(--text-faint)' }}>
        反感
        <RelationBar
          score={after}
          before={before}
          className="flex-1"
          tip={`好感度 ${before === null ? 'なし' : before.toFixed(2)} → ${after.toFixed(2)}(薄い塗りが前、濃い塗りが今)`}
        />
        好意
      </div>
      <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 text-[11px]">
        <span style={{ color: 'var(--text-dim)' }}>
          {from ? <span style={{ color: from.color }}>{from.word}</span> : 'なし'}
          {' → '}
          <span style={{ color: to.color }}>{to.word}</span>
          <span className="tabular-nums" style={{ color: 'var(--text-faint)' }}>
            ({after.toFixed(2)})
          </span>
        </span>
        <span className="whitespace-nowrap" style={{ color: trend.color }}>
          {trend.text}
        </span>
      </div>
    </div>
  )
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
  // at = フォームを開いた場所(上の「+ 手動イベント」か、種類の見出しの「+」)。種類を選び直しても動かさない
  const [adding, setAdding] = useState<{ type: string; payload: Payload; at: EventGroupKey | 'top' } | null>(null)
  // 編集対象は添字でなく id で持つ(抽出などで events が入れ替わると添字は
  // 別のイベントを指し、保存で無関係なイベントを上書きしてしまう)
  const [editing, setEditing] = useState<{ id: string; payload: Payload } | null>(null)
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
  // このシーンに入る直前の状態(関係が「どこからどこへ」動いたかを出す)。
  // 矢印キーで次々に切り替えると取得が複数走るので、古い応答は捨てる。
  // どのシーンの分かも持ち、切り替えた直後に前のシーンの状態で計算しないようにする
  const [before, setBefore] = useState<{ nodeId: string; state: StateSnapshot } | null>(null)
  const beforeState = before?.nodeId === node.id ? before.state : null
  const eventsKey = node.events.map((e) => e.id).join(',')
  useEffect(() => {
    let ignore = false
    const nodeId = node.id
    void api
      .getStateBefore(nodeId)
      .then((state) => {
        if (!ignore) setBefore({ nodeId, state })
      })
      .catch(() => undefined)
    return () => {
      ignore = true
    }
  }, [node.id, node.updated_at, eventsKey])
  // 関係イベントを保存順に当てて、1 件ごとの前後の値を出す(同じ二人の関係が 1 シーンで 2 回動くこともある)。
  // 値の丸めはバックエンドの fold と同じく -1〜+1
  const relationSteps = useMemo(() => {
    if (!beforeState) return null
    const scores = new Map<string, number | null>()
    const steps = new Map<string, RelationStep>()
    for (const e of node.events) {
      if (e.type !== 'relationship_update' && e.type !== 'relationship_set') continue
      const p = e.payload as Payload
      const key = `${str(p.char)}\u0000${str(p.target)}`
      const before = scores.has(key)
        ? scores.get(key)!
        : (beforeState.chars[str(p.char)]?.relationships?.[str(p.target)]?.score ?? null)
      const raw = e.type === 'relationship_update' ? (before ?? 0) + num(p.delta) : num(p.value)
      const after = Math.min(1, Math.max(-1, raw))
      steps.set(e.id, { before, after })
      scores.set(key, after)
    }
    return steps
  }, [beforeState, node.events])
  shownNodeId.current = node.id

  // 検証結果とエラーは直前に見ていたシーンのものなので、切り替えたら捨てる
  useEffect(() => {
    setValidation([])
    setError(null)
    setAdding(null)
    setEditing(null)
  }, [node.id])

  // 抽出などで events が入れ替わり、編集中のイベントが消えたらフォームを閉じる
  useEffect(() => {
    setEditing((cur) => (cur && !node.events.some((e) => e.id === cur.id) ? null : cur))
  }, [node.events])

  const nameOf = (id: string): string =>
    characters.find((c) => c.id === id)?.name ?? (id || '(未選択)')
  // 関係の相手が勢力のときの名前(ID のまま出さない)。勢力は滅多に変わらないので開いたときに 1 回読む
  const [factionNames, setFactionNames] = useState<Record<string, string>>({})
  useEffect(() => {
    void api
      .listFactions()
      .then((list) => setFactionNames(Object.fromEntries(list.map((f) => [f.id, f.name]))))
      .catch(() => undefined)
  }, [])
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
    // id を引き継ぐ(編集で ID が変わると replaces / reasons の参照が壊れる)
    events.map((e) => ({ id: e.id, type: e.type, payload: e.payload, source: e.source }))

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

  // saving は save() の中でも立つが、latestEvents(getNode)の往復中が無防備に
  // なる。連打すると 2 発目が 1 発目の反映前のイベント列を土台にして、全件置換で
  // 打ち消してしまうので、各ハンドラの入口で同期的に立てる
  const handleDelete = (index: number): void => {
    if (saving) return
    const targetId = node.events[index]?.id
    setEditing(null)
    setSaving(true)
    void latestEvents().then((base) => save(toInputs(base.filter((e) => e.id !== targetId))))
  }

  const handleAdd = (): void => {
    if (!adding || saving) return
    setSaving(true)
    void latestEvents().then(async (base) => {
      const ok = await save([...toInputs(base), { type: adding.type, payload: adding.payload, source: 'user' }])
      if (ok) setAdding(null)
    })
  }

  const handleUpdate = (): void => {
    if (!editing || saving) return
    const targetId = editing.id
    const payload = editing.payload
    setSaving(true)
    void latestEvents().then(async (base) => {
      const events = toInputs(base).map((e) =>
        e.id === targetId ? { ...e, payload, source: 'user' as const } : e
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

  // 手動イベントの追加フォーム。開いた場所(上か、種類の見出しの下)に出す
  const addingForm = adding && (
    <div
      className="mb-2 rounded-lg border p-2"
      style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)' }}
      onKeyDown={editKeys(true, handleAdd, () => setAdding(null))}
    >
      <span className="mb-1.5 flex items-end gap-2.5">
        {/* 「だれの」を選ぶと出る。一覧のカードと同じ位置にアイコンが立つ */}
        {(() => {
          const char = characters.find((c) => c.id === eventCharId(adding.type, adding.payload))
          return char ? <CharAvatar char={char} size={28} /> : null
        })()}
        <span className="min-w-0 flex-1">
          <Row label="種類">
            <select
              value={adding.type}
              onChange={(e) =>
                setAdding({ ...adding, type: e.target.value, payload: { ...DEFAULT_PAYLOADS[e.target.value] } })
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
        </span>
      </span>
      <EventFields
        type={adding.type}
        payload={adding.payload}
        characters={characters}
        factKeys={factKeys}
        onChange={(payload) => setAdding({ ...adding, payload })}
      />
      {/* 資料庫・章のまとめと同じ「取り消し … 確定(右端)」の並び */}
      <EditActions
        dirty={false}
        saving={saving || extracting}
        onCommit={handleAdd}
        onCancel={() => setAdding(null)}
        commitLabel="追加"
        commitTip="このイベントを追加します(Ctrl+Enter)"
      />
    </div>
  )

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
                v ? null : { type: 'fact_set', payload: { ...DEFAULT_PAYLOADS['fact_set'] }, at: 'top' }
              )
            }
            className="rounded-md border px-2 py-0.5 text-[11px]"
            style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
          >
            {adding ? '取り消し' : '+ 手動イベント'}
          </button>
          {/* 1 件でもキューに積む(他の処理と取り合いにならないように) */}
          <button
            onClick={runExtract}
            disabled={saving || extractTask !== null}
            // 色は index.css の .accent-action(校正・自動生成と同じ「LLM を走らせる」見た目)
            className="accent-action rounded-md border px-2 py-0.5 text-[11px] font-medium disabled:opacity-50"
            // 何を見て抽出しているかを書く(見ないものまで整えても結果が変わらないため)
            data-tip={[
              'この場面で起きたこと(イベント)を LLM に取り出させます。',
              '',
              '抽出に使うもの:',
              '・シーン本文と、登場キャラ(Cast)・場所',
              '・直前までの状態',
              '・キャラクター一覧',
              '',
              'タイトル・芯・清書は見ません(未保存の編集も渡らないので、先に保存してください)'
            ].join('\n')}
          >
            {extracting
              ? `処理中… (${extractElapsed}s)`
              : extractTask
                ? '待機中…'
                : 'イベント抽出(LLM)'}
          </button>
        </div>
      </div>

      {adding?.at === 'top' && addingForm}

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

      {/* 種類ごとの見出しで分ける。違う種類どうしは状態の別の部分を変えるだけなので並べ替えても結果は同じ。
          同じ種類の中は保存順のまま(同じ事実を 2 回設定したら後が勝つので、順番に意味がある) */}
      {EVENT_GROUPS.map((group) => {
        const items = node.events
          .map((e, index) => ({ e, index }))
          .filter(({ e }) => eventGroupOf(e.type) === group.key)
        if (items.length === 0 && adding?.at !== group.key) return null
        return (
          <section key={group.key} data-event-group={group.key} className="mt-3 first-of-type:mt-1">
            <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium" style={{ color: 'var(--text-dim)' }}>
              <Icon name={group.icon} size={12} />
              {group.label}
              <span className="tabular-nums" style={{ color: 'var(--text-faint)' }}>
                {items.length}
              </span>
              {group.addType && (
                <button
                  onClick={() =>
                    setAdding((v) =>
                      v?.at === group.key
                        ? null
                        : { type: group.addType!, payload: { ...DEFAULT_PAYLOADS[group.addType!] }, at: group.key }
                    )
                  }
                  className="ml-auto flex h-5 w-5 items-center justify-center rounded-md text-[13px] hover:bg-[var(--accent-soft)]"
                  style={{ color: adding?.at === group.key ? 'var(--accent)' : 'var(--text-faint)' }}
                  aria-label={`${group.label}を手で追加`}
                  data-tip={adding?.at === group.key ? '追加をやめる' : `${group.label}のイベントを手で追加`}
                >
                  {adding?.at === group.key ? '✕' : '+'}
                </button>
              )}
            </div>
            {adding?.at === group.key && addingForm}
            {items.map(({ e, index }) => {
              const open = editing?.id === e.id
              // 編集中は入力中の payload を見る(「だれの」を変えたらアイコンも追う)
              const payload = open ? editing.payload : (e.payload as Payload)
              const eventChar = characters.find((c) => c.id === eventCharId(e.type, payload))
              const isWorldFact = e.type === 'fact_set' && str(payload.scope) === 'world'
              const isRelation = group.key === 'relation'
              // 1 行目の見出し。種類は見出しで分かるので、だれ(関係は だれ → だれ)を出す。
              // 混ざる「その他」と記憶の圧縮、編集中だけ種類の名前を出す
              // 関係の相手。人物ならアイコンも出す(勢力はアイコンも色も無いので名前だけ)
              const targetId = str(payload.target)
              const targetIsFaction = isRelation && str(payload.target_type) === 'faction'
              const targetChar = isRelation && !targetIsFaction ? characters.find((c) => c.id === targetId) : undefined
              const targetName = targetIsFaction ? (factionNames[targetId] ?? targetId) : nameOf(targetId)
              const heading = open
                ? (TYPE_LABELS[e.type] ?? e.type)
                : isRelation
                  ? `${nameOf(str(payload.char))} → ${targetName}`
                  : isWorldFact
                    ? '世界'
                    : group.key === 'other' || e.type === 'memory_compress'
                      ? `${TYPE_LABELS[e.type] ?? e.type}${eventChar ? `・${eventChar.name}` : ''}`
                      : (eventChar?.name ?? '')
              return (
                <div
                  key={e.id}
                  data-event-type={e.type}
                  className="mb-1.5 flex gap-2.5 rounded-lg border px-3 py-2 text-[12px]"
                  style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)' }}
                >
                  {/* 「だれのことか」をアイコンで示す。世界の事実は地球の線画、ほかにキャラに紐づかないものは列ごと出さない */}
                  {eventChar ? (
                    <CharAvatar char={eventChar} size={28} />
                  ) : (
                    isWorldFact && (
                      <span
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border"
                        style={{ borderColor: 'var(--border-strong)', color: 'var(--text-faint)' }}
                      >
                        <Icon name="globe" size={15} />
                      </span>
                    )
                  )}
                  <div className="min-w-0 flex-1">
                    {/* 1 行目に だれ + 出どころ + 操作、本文は下に幅いっぱい */}
                    <div className="mb-0.5 flex items-center gap-2">
                      {isRelation && !open ? (
                        // 「ケン → (ア)アヤ」。矢印の向きのまま左から右へ読めるよう、相手のアイコンは名前の前に置く
                        <span className="flex min-w-0 items-center gap-1 font-medium" style={{ color: 'var(--text)' }}>
                          <span className="shrink-0">{nameOf(str(payload.char))}</span>
                          <span className="shrink-0" style={{ color: 'var(--text-faint)' }}>
                            →
                          </span>
                          {targetChar && <CharAvatar char={targetChar} size={18} />}
                          <span className="min-w-0 truncate">{targetName}</span>
                        </span>
                      ) : (
                        <span className="min-w-0 truncate font-medium" style={{ color: 'var(--text)' }}>
                          {heading}
                        </span>
                      )}
                      <span
                        className="shrink-0 rounded px-1.5 py-px text-[10px] uppercase"
                        style={
                          e.source === 'user'
                            ? { background: 'var(--accent-soft)', color: 'var(--accent)' }
                            : { background: 'var(--bg-input)', color: 'var(--text-faint)' }
                        }
                      >
                        {e.source}
                      </span>
                      <span className="ml-auto flex shrink-0 items-center gap-2">
                        {/* 鉛筆は資料庫・章のまとめと同じ部品。編集中は出さない(閉じるのは下の「取り消し」) */}
                        {!open && (
                          <EditPencil
                            label="このイベント"
                            onClick={() => setEditing({ id: e.id, payload: { ...(e.payload as Payload) } })}
                          />
                        )}
                        <button
                          onClick={() => handleDelete(index)}
                          disabled={saving || extracting}
                          className="delete-action text-[11px]"
                          aria-label="このイベントを削除"
                          data-tip="このイベントを削除"
                        >
                          ✕
                        </button>
                      </span>
                    </div>
                    {open ? (
                      <div className="mt-1" onKeyDown={editKeys(true, handleUpdate, () => setEditing(null))}>
                        <EventFields
                          type={e.type}
                          payload={editing.payload}
                          characters={characters}
                          factKeys={factKeys}
                          onChange={(payload) => setEditing({ id: e.id, payload })}
                        />
                        <EditActions
                          dirty={JSON.stringify(editing.payload) !== JSON.stringify(e.payload)}
                          saving={saving || extracting}
                          onCommit={handleUpdate}
                          onCancel={() => setEditing(null)}
                          commitTip="このイベントを保存します(Ctrl+Enter)"
                        />
                      </div>
                    ) : e.type === 'memory_add' ? (
                      // 人物名は 1 行目に出しているので、本文と重要度・感情だけ
                      <div className="leading-relaxed" style={{ color: 'var(--text-dim)' }}>
                        「{str(payload.content)}」
                        <span className="whitespace-nowrap text-[11px]" style={{ color: 'var(--text-faint)' }}>
                          重要度 {num(payload.importance, 0.5).toFixed(2)} / 感情 {num(payload.emotion).toFixed(1)}
                        </span>
                      </div>
                    ) : isRelation ? (
                      <div>
                        {/* 関係の一言(相関図の矢印に出る文)が主役 */}
                        {str(payload.label) && (
                          <div className="leading-relaxed" style={{ color: 'var(--text-dim)' }}>
                            「{str(payload.label)}」
                          </div>
                        )}
                        <RelationChange type={e.type} payload={payload} step={relationSteps?.get(e.id) ?? null} />
                      </div>
                    ) : e.type === 'fact_set' ? (
                      // キー = 値 ではなく、項目名を小さなラベル、値を本文に(短ければ横に並び、長ければ折り返す)
                      <div className="flex flex-wrap items-baseline gap-x-2 leading-relaxed">
                        <span className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
                          {str(payload.key)}
                        </span>
                        <span style={{ color: 'var(--text-dim)' }}>{str(payload.value)}</span>
                      </div>
                    ) : (
                      <div className="leading-relaxed" style={{ color: 'var(--text-dim)' }}>
                        {eventSummary(e.type, payload, nameOf)}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </section>
        )
      })}
    </div>
  )
}
