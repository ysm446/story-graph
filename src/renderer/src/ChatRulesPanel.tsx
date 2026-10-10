import AutoTextarea from './AutoTextarea'
import { useEffect, useState } from 'react'
import { api } from './api'

const key = 'author_chat_rules'
const example = '・シーン本文は、1シーンあたり600文字程度に収める。\n・シーン本文は小説調ではなく、出来事と人物の行動が分かる指示書形式で書く。'

/** 相談と制作で共有する、作者だけが変更するルール。 */
export default function ChatRulesPanel({ busy, onDirty, onSaved }: {
  busy: boolean; onDirty: (dirty: boolean) => void; onSaved: () => void
}): React.JSX.Element {
  const [saved, setSaved] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const dirty = saved !== null && draft !== saved
  useEffect(() => { onDirty(dirty || saving) }, [dirty, saving, onDirty])
  useEffect(() => () => onDirty(false), [onDirty])
  useEffect(() => {
    let active = true
    void api.getSettings().then((settings) => {
      if (active) { setSaved(settings[key] ?? ''); setDraft(settings[key] ?? '') }
    }).catch((e) => { if (active) setError(String(e)) })
    return () => { active = false }
  }, [])
  const save = async (): Promise<void> => {
    if (busy || saving || saved === null) return
    setSaving(true); setError(''); setNotice('')
    try {
      const settings = await api.putSettings({ [key]: draft })
      setSaved(settings[key] ?? ''); setDraft(settings[key] ?? '')
      setNotice('保存しました。次の送信から適用します。')
      onSaved()
    } catch (e) { setError(String(e)) }
    finally { setSaving(false) }
  }
  const button = 'rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-50'
  const style = { borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }
  return <details className="shrink-0 rounded-lg border px-3 py-1.5 text-[12px]" style={{ borderColor: 'var(--border)', background: 'var(--bg-elevated)' }}>
    <summary className="cursor-pointer" data-tip="この作品の相談と制作で共有する、文体や長さなどのルールを設定します">AIへのルール{dirty ? ' · 未保存' : saved?.trim() ? ' · 設定済み' : ''}</summary>
    <div className="inspector-scrollbar mt-2 flex max-h-[50vh] flex-col gap-2 overflow-y-auto">
      <p className="text-[11px]" style={{ color: 'var(--text-dim)' }}>この作品の相談・制作に共通で適用します。キャラクターとの会話には適用しません。AIはこの設定を書き換えません。</p>
      <AutoTextarea ariaLabel="AIへのルール" minRows={3} maxLength={6000} value={draft} placeholder={example}
        disabled={busy || saving || saved === null}
        onChange={(value) => { setDraft(value); setNotice('') }}
        className="w-full shrink-0 rounded-md border px-2 py-0.5 text-[12px] outline-none"
        style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }} />
      <p className="text-[11px]" style={{ color: 'var(--text-faint)' }}>「回答」「1シーンの本文」など対象を明記してください。空にして保存すると解除できます。</p>
      <div className="flex items-center gap-2">
        <button className={button} style={style} disabled={busy || saving || !dirty} onClick={() => void save()} data-tip="ルールを保存し、次の送信から適用します">{saving ? '保存中…' : '保存'}</button>
        <button className={button} style={style} disabled={saving || !dirty} onClick={() => { setDraft(saved ?? ''); setError(''); setNotice('') }} data-tip="未保存の変更を取り消します">元に戻す</button>
        <span className="text-[11px] tabular-nums" style={{ color: 'var(--text-faint)' }}>{draft.length} / 6000</span>
      </div>
      {notice && <p role="status" className="text-[11px]" style={{ color: 'var(--text-dim)' }}>{notice}</p>}
      {error && <p role="alert" className="text-[11px]" style={{ color: 'var(--danger)' }}>{error}</p>}
    </div>
  </details>
}
