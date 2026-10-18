import AutoTextarea from './AutoTextarea'
import ProductionPanelToggle, { panelBodyClass, panelBodyStyle } from './ProductionPanelToggle'
import { useEffect, useRef, useState } from 'react'
import { api } from './api'

const key = 'author_chat_rules'
/** 設定画面で同じ指示を保存したときの通知。開いたままのパネルを読み直す */
export const CHAT_RULES_EVENT = 'story-graph:chat-rules-changed'
const example = '・シーン本文は、1シーンあたり600文字程度に収める。\n・シーン本文は小説調ではなく、出来事と人物の行動が分かる指示書形式で書く。'

/** 制作エージェント専用の指示。保存キーは以前の設定を引き継ぐ。 */
export default function ChatRulesPanel({ busy, open, onToggle, onDirty, onSaved }: {
  busy: boolean; open: boolean; onToggle: () => void; onDirty: (dirty: boolean) => void; onSaved: () => void
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
  // 設定画面で保存されたら読み直す。編集中の下書きは残し、「元に戻す」の戻り先だけ更新する
  const latest = useRef({ saved, draft })
  latest.current = { saved, draft }
  useEffect(() => {
    const reload = (): void => {
      void api.getSettings().then((settings) => {
        const next = settings[key] ?? ''
        const { saved: before, draft: current } = latest.current
        setSaved(next)
        if (before === null || current === before) setDraft(next)
        onSaved()
      }).catch(() => undefined)
    }
    window.addEventListener(CHAT_RULES_EVENT, reload)
    return () => window.removeEventListener(CHAT_RULES_EVENT, reload)
  }, [onSaved])
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
  // 閉じても下書きはこのコンポーネントに残る(開き直すと続きから編集できる)
  return <>
    <ProductionPanelToggle open={open} onToggle={onToggle} highlight={dirty}
      tip="制作エージェントへの指示(作業方針や制約)を設定します">指示{dirty ? ' · 未保存' : saved?.trim() ? ' · 設定済み' : ''}</ProductionPanelToggle>
    {open && <div className={`inspector-scrollbar ${panelBodyClass} flex max-h-[50vh] flex-col gap-2 overflow-y-auto`} style={panelBodyStyle}>
      <p className="text-[11px]" style={{ color: 'var(--text-dim)' }}>この作品の制作チャットに適用します。「相談する」で変更案を考えるときにも使います。相談（編集者）やキャラクターとの会話には適用しません。AIはこの設定を書き換えません。</p>
      <AutoTextarea ariaLabel="制作エージェントへの指示" minRows={3} maxLength={6000} value={draft} placeholder={example}
        disabled={busy || saving || saved === null}
        onChange={(value) => { setDraft(value); setNotice('') }}
        className="w-full shrink-0 rounded-lg border px-3 py-1.5 text-[13px] leading-relaxed outline-none"
        style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }} />
      <p className="text-[11px]" style={{ color: 'var(--text-faint)' }}>「回答」「1シーンの本文」など対象を明記してください。空にして保存すると解除できます。</p>
      <div className="flex items-center gap-2">
        {/* 「取り消し … 保存(右)」の順(資料庫の確定と同じ並び) */}
        <button className={button} style={style} disabled={saving || !dirty} onClick={() => { setDraft(saved ?? ''); setError(''); setNotice('') }} data-tip="未保存の変更を取り消します">取り消し</button>
        <button className="accent-action rounded-md border px-2.5 py-1 text-[12px] font-medium disabled:opacity-40" disabled={busy || saving || !dirty} onClick={() => void save()} data-tip="ルールを保存し、次の送信から適用します">{saving ? '保存中…' : '保存'}</button>
        <span className="text-[11px] tabular-nums" style={{ color: 'var(--text-faint)' }}>{draft.length} / 6000</span>
      </div>
      {notice && <p role="status" className="text-[11px]" style={{ color: 'var(--text-dim)' }}>{notice}</p>}
      {error && <p role="alert" className="text-[11px]" style={{ color: 'var(--danger-text)' }}>{error}</p>}
    </div>}
  </>
}
