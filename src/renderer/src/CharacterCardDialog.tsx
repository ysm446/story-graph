import { useEscapeKey } from './useEscapeKey'
import { fmtSize } from './modes/settings/format'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from './api'
import CharAvatar from './CharAvatar'
import type { Character, CharacterCardSummary } from './types'

const DIR_KEY = 'cardExportDir' // 前回の書き出し先のフォルダ(次の保存ダイアログを開く場所)

const lastDir = (): string => {
  try {
    return localStorage.getItem(DIR_KEY) ?? ''
  } catch {
    return ''
  }
}

/** キャラクターカードの書き出し(docs/design/character-card.md)。
 *  アンカー時点のキャラクターを zip に書き出す。入るものを確かめ、時点の呼び名を決めてから保存先を選ぶ。 */
export default function CharacterCardDialog({
  char,
  anchor,
  onClose
}: {
  char: Character
  /** どのシーンまでの状態を書き出すか。null は正史の末尾 */
  anchor: string | null
  onClose: () => void
}): React.JSX.Element {
  const [summary, setSummary] = useState<CharacterCardSummary | null>(null)
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ path: string; size: number } | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .previewCharacterCard(char.id, anchor)
      .then((s) => {
        if (cancelled) return
        setSummary(s)
        setLabel(s.label)
      })
      .catch((e) => !cancelled && setError(String(e)))
    return () => {
      cancelled = true
    }
  }, [char.id, anchor])

  useEscapeKey(onClose, true)

  const submit = async (): Promise<void> => {
    if (!summary || busy) return
    setError(null)
    const path = await window.storyGraph.chooseCardSaveFile(summary.suggested_name, lastDir())
    if (!path) return // 保存先を選ばなかったら、このダイアログに戻る
    setBusy(true)
    try {
      const result = await api.exportCharacterCard(char.id, anchor, path, label.trim())
      try {
        localStorage.setItem(DIR_KEY, result.path.replace(/[\\/][^\\/]*$/, ''))
      } catch {
        // 覚えられなくても書き出しは済んでいる
      }
      setDone({ path: result.path, size: result.size })
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const reveal = async (): Promise<void> => {
    if (!done) return
    if (!(await window.storyGraph.revealInFolder(done.path))) setError(`ファイルが見つかりませんでした: ${done.path}`)
  }

  const counts = summary?.counts
  const secondary = 'rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-50'
  const secondaryStyle = { borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onClick={onClose}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="character-card-title"
        className="w-[520px] max-w-[92vw] rounded-2xl border p-4 shadow-xl shadow-black/50"
        style={{ background: 'var(--bg-card)', borderColor: 'var(--border-strong)' }}
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <h3 id="character-card-title" className="mb-1 text-[14px] font-semibold">カードに書き出す</h3>
        <p className="mb-3 text-[11px]" style={{ color: 'var(--text-faint)' }}>
          この時点のキャラクターを 1 つの zip にまとめ、ほかのアプリで使えるようにします。物語は変更されません。
        </p>
        <div className="mb-3 flex items-center gap-2 text-[13px]" style={{ color: 'var(--text)' }}>
          <CharAvatar char={char} size={24} />
          <span className="min-w-0 truncate">{char.name}</span>
        </div>
        <label className="mb-1 block text-[12px]" style={{ color: 'var(--text-dim)' }} htmlFor="character-card-label">
          時点の呼び名
        </label>
        <input
          id="character-card-label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          disabled={!summary || busy || !!done}
          placeholder={summary?.label}
          className="w-full rounded-lg border px-3 py-1.5 text-[13px] leading-relaxed outline-none disabled:opacity-50"
          style={{ background: 'var(--bg-input)', borderColor: 'var(--border)', color: 'var(--text)' }}
        />
        <p className="mt-1 text-[11px]" style={{ color: 'var(--text-faint)' }}>
          読み込んだ先で、同じキャラクターの別の時点と見分けるために使われます。
        </p>
        {counts && (
          <>
            <div className="mb-1 mt-3 text-[12px]" style={{ color: 'var(--text-dim)' }}>入るもの</div>
            <div data-character-card-counts className="text-[12px] leading-relaxed tabular-nums" style={{ color: 'var(--text)' }}>
              <div>
                状況 {counts.situation} 件 / 世間で知られていること {counts.world} 件 / 関係 {counts.relationships} 人 / 記憶{' '}
                {counts.memories} 件
              </div>
              <div>
                画像 {counts.images} 枚 / 声{' '}
                {summary.has_voice ? `あり(参照音声 ${counts.voice_refs} 本)` : 'なし'}
              </div>
            </div>
            {summary.notes.length > 0 && (
              <ul data-character-card-notes className="mt-2 text-[11px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
                {summary.notes.map((note) => (
                  <li key={note} className="break-all">⚠ {note}</li>
                ))}
              </ul>
            )}
          </>
        )}
        {!summary && !error && (
          <p className="mt-3 text-[12px]" style={{ color: 'var(--text-faint)' }}>入るものを確かめています…</p>
        )}
        {busy && <p className="mt-3 text-[12px]" style={{ color: 'var(--text-dim)' }}>書き出しています…</p>}
        {done && (
          <p role="status" data-character-card-done className="mt-3 break-all text-[12px]" style={{ color: 'var(--text)' }}>
            書き出しました: {done.path}({fmtSize(done.size)})
          </p>
        )}
        {error && <p role="alert" className="mt-3 break-all text-[12px]" style={{ color: 'var(--danger-text)' }}>{error}</p>}
        <div className="mt-3 flex justify-end gap-2">
          {done ? (
            <>
              <button type="button" onClick={() => void reveal()} className={secondary} style={secondaryStyle}
                data-tip="書き出した zip をエクスプローラーで表示します">
                フォルダで表示
              </button>
              <button type="button" onClick={onClose} className={secondary} style={secondaryStyle}>閉じる</button>
            </>
          ) : (
            <>
              <button type="button" onClick={onClose} className={secondary} style={secondaryStyle}>取り消し</button>
              <button
                type="submit"
                disabled={!summary || busy}
                className="rounded-md px-3 py-1 text-[12px] font-medium text-white disabled:opacity-50"
                style={{ background: 'var(--accent)' }}
              >
                書き出す
              </button>
            </>
          )}
        </div>
      </form>
    </div>,
    document.body
  )
}
