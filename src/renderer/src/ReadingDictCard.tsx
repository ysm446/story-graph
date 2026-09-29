import { useEffect, useState } from 'react'

interface Entry {
  word: string
  reading: string
}

const inputStyle = { background: 'var(--bg-input)', borderColor: 'var(--border)' }

function parse(value: string | undefined): Entry[] {
  try {
    const list = JSON.parse(value || '[]') as unknown
    if (!Array.isArray(list)) return []
    return list
      .filter((x): x is Entry => !!x && typeof x === 'object')
      .map((x) => ({ word: String(x.word ?? ''), reading: String(x.reading ?? '') }))
  } catch {
    return []
  }
}

/** 設定 →「音声読み上げ」の読み辞書(docs/design/voice.md §4.5)。登録した語を、読み上げの合成の直前に
 *  読みへ置き換える(台本・本文の表示は変えない)。キャラ・場所の名前は、それぞれの画面の「読み」欄で入れる。
 *  欄外へフォーカスが移ったときに、一覧まるごと設定 tts_reading_dict に保存する */
export default function ReadingDictCard({
  value,
  save
}: {
  value: string | undefined
  save: (patch: Record<string, string>) => Promise<void>
}): React.JSX.Element {
  const [entries, setEntries] = useState<Entry[]>(() => parse(value))
  // 設定の読み込みが後から届いたときだけ取り込む(編集中の欄を巻き戻さない)
  const [loaded, setLoaded] = useState(value !== undefined)
  useEffect(() => {
    if (!loaded && value !== undefined) {
      setEntries(parse(value))
      setLoaded(true)
    }
  }, [value, loaded])

  const persist = (next: Entry[]): void => {
    const cleaned = next.map((e) => ({ word: e.word.trim(), reading: e.reading.trim() })).filter((e) => e.word && e.reading)
    void save({ tts_reading_dict: JSON.stringify(cleaned) })
  }

  const update = (index: number, patch: Partial<Entry>): void =>
    setEntries((prev) => prev.map((e, i) => (i === index ? { ...e, ...patch } : e)))

  const remove = (index: number): void => {
    const next = entries.filter((_, i) => i !== index)
    setEntries(next)
    persist(next)
  }

  return (
    <div className="settings-card">
      <div className="settings-field">
        <div className="settings-field-header">
          <span className="settings-field-label">読み辞書</span>
          <div className="settings-field-controls">
            <button
              onClick={() => setEntries((prev) => [...prev, { word: '', reading: '' }])}
              className="rounded-md border px-2 py-0.5 text-[11px]"
              style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
              data-tip="読み間違える言葉を足します"
            >
              + 言葉を追加
            </button>
          </div>
        </div>
        {entries.length > 0 && (
          <div className="flex flex-col gap-1">
            {entries.map((entry, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  value={entry.word}
                  placeholder="田村工業"
                  onChange={(e) => update(i, { word: e.target.value })}
                  onBlur={() => persist(entries)}
                  className="min-w-0 flex-1 rounded-md border px-2 py-1 text-[12px] outline-none"
                  style={inputStyle}
                  aria-label="言葉"
                />
                <span className="shrink-0 text-[12px]" style={{ color: 'var(--text-faint)' }}>
                  →
                </span>
                <input
                  value={entry.reading}
                  placeholder="たむらこうぎょう"
                  onChange={(e) => update(i, { reading: e.target.value })}
                  onBlur={() => persist(entries)}
                  className="min-w-0 flex-1 rounded-md border px-2 py-1 text-[12px] outline-none"
                  style={inputStyle}
                  aria-label="読み"
                />
                <button
                  onClick={() => remove(i)}
                  className="shrink-0 rounded-md border px-1.5 py-0.5 text-[11px]"
                  style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
                  aria-label="この言葉を消す"
                  data-tip="この言葉を消す"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
        <p className="settings-field-hint">
          読み上げで、左の言葉を右の読み(ひらがな)で読ませます。台本や本文の表示は変わりません。長い言葉から先に当てます。
          キャラクターと場所の名前は、それぞれの画面の「読み」欄に入れてください(姓だけ・名だけも読めるようになります)。
          同じ言葉が両方にあれば、この辞書が優先です。
        </p>
      </div>
    </div>
  )
}
