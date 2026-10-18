import { useEffect, useState } from 'react'
import { api } from '../../api'
import { PresetEditorModal, type PresetDraft } from '../../RenderStyle'
import type { StylePreset } from '../../types'

// 清書の文体指示(スタイルプリセット)の一覧と編集。編集モーダルは鑑賞モード・
// 清書タブの ✎ と同じもの(RenderStyle.tsx)を使う
export default function StylePresetsSection(): React.JSX.Element {
  const [presets, setPresets] = useState<StylePreset[]>([])
  const [editor, setEditor] = useState<PresetDraft | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = async (): Promise<void> => {
    try {
      setPresets(await api.listPresets())
      setError(null)
    } catch (e) {
      setError(String(e))
    }
  }

  useEffect(() => {
    void reload()
  }, [])

  return (
    <div className="settings-field">
      <div className="settings-field-header">
        <span className="settings-field-label">スタイルプリセット({presets.length}件)</span>
        <button
          onClick={() => setEditor({ name: '', person: 'third', tone: '' })}
          className="rounded-md border px-2 py-0.5 text-[11px]"
          style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
        >
          + 新規
        </button>
      </div>
      <p className="settings-field-hint">
        清書(散文化)のシステムプロンプト。ここで書いた全文がそのまま使われ、人称と厳守事項だけが
        自動で追加されます。どれを使うかは鑑賞モードと構造モードの清書タブで選びます。
        組み込みの 2 つは編集できないので、複製して育ててください。
      </p>
      {error && (
        <p className="settings-field-hint" style={{ color: 'var(--danger-text)' }}>
          {error}
        </p>
      )}
      {presets.map((p) => (
        <div
          key={p.id}
          className="flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[12px]"
          style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)' }}
        >
          <span
            className="shrink-0 rounded px-1 text-[10px]"
            style={{
              background: p.builtin ? 'var(--bg-input)' : 'var(--accent-soft)',
              color: p.builtin ? 'var(--text-faint)' : 'var(--text)'
            }}
          >
            {p.builtin ? '組み込み' : 'カスタム'}
          </span>
          <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--text)' }}>
            {p.name}
          </span>
          <span className="shrink-0" style={{ color: 'var(--text-faint)' }}>
            {p.person === 'first' ? '一人称' : '三人称'}
          </span>
          <button
            onClick={() =>
              setEditor(
                p.builtin
                  ? { name: `${p.name} のコピー`, person: p.person, tone: p.tone }
                  : { id: p.id, name: p.name, person: p.person, tone: p.tone }
              )
            }
            className="shrink-0 rounded-md border px-2 py-0.5 text-[11px]"
            style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
            data-tip={p.builtin ? '組み込みは編集できません。複製して新規作成します' : 'このプリセットを編集'}
          >
            {p.builtin ? '⧉ 複製して編集' : '✎ 編集'}
          </button>
        </div>
      ))}
      {editor && (
        <PresetEditorModal
          draft={editor}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null)
            void reload()
          }}
          onDeleted={() => {
            setEditor(null)
            void reload()
          }}
        />
      )}
    </div>
  )
}
