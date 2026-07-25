import { useCallback, useEffect, useRef, useState } from 'react'
import { api, assetUrl, isAbortError, renderStream } from '../api'
import type { Character, PromoteProposal, SceneEntry, StylePreset } from '../types'

interface PromoteState {
  nodeId: string
  selection: string
  proposal: PromoteProposal | null
  loading: boolean
  error: string | null
}

interface PresetDraft {
  id?: string
  name: string
  person: string
  tone: string
}

function PresetEditorModal({
  draft,
  onClose,
  onSaved,
  onDeleted
}: {
  draft: PresetDraft
  onClose: () => void
  onSaved: (id: string) => void
  onDeleted: () => void
}): React.JSX.Element {
  const [form, setForm] = useState<PresetDraft>(draft)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputStyle = { background: 'var(--bg-input)', borderColor: 'var(--border)' }

  const handleSave = async (): Promise<void> => {
    if (!form.name.trim()) {
      setError('名前を入力してください')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const saved = await api.upsertPreset({
        id: form.id,
        name: form.name.trim(),
        person: form.person,
        tone: form.tone
      })
      onSaved(saved.id)
    } catch (e) {
      setError(String(e))
      setBusy(false)
    }
  }

  const handleDelete = async (): Promise<void> => {
    if (!form.id) return
    if (!window.confirm(`プリセット「${form.name}」を削除しますか?`)) return
    setBusy(true)
    try {
      await api.deletePreset(form.id)
      onDeleted()
    } catch (e) {
      setError(String(e))
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      onClick={onClose}
    >
      <div
        className="w-[560px] max-w-[92vw] rounded-2xl border p-5"
        style={{ background: 'var(--bg-card)', borderColor: 'var(--border-strong)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-3 text-[14px] font-semibold" style={{ color: 'var(--text)' }}>
          {form.id ? 'スタイルプリセットを編集' : 'スタイルプリセットを新規作成'}
        </h3>
        <div className="mb-3 flex gap-2">
          <input
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="プリセット名"
            className="min-w-0 flex-1 rounded-lg border px-3 py-1.5 text-[13px] outline-none"
            style={inputStyle}
          />
          <select
            value={form.person}
            onChange={(e) => setForm((f) => ({ ...f, person: e.target.value }))}
            className="rounded-lg border px-2 py-1.5 text-[13px]"
            style={inputStyle}
          >
            <option value="third">三人称</option>
            <option value="first">一人称(POV必須)</option>
          </select>
        </div>
        <label className="mb-1 block text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-faint)' }}>
          システムプロンプト
        </label>
        <textarea
          rows={10}
          value={form.tone}
          onChange={(e) => setForm((f) => ({ ...f, tone: e.target.value }))}
          placeholder={
            'あなたはプロの小説家です。与えられたシーン(出来事の仕様書)を散文に仕上げます。\n背景や空気感の描写、人物の仕草と表情、会話の間を丁寧に肉付けしてください。\n硬質で乾いた文体。短いセンテンスを重ね、比喩は最小限に。'
          }
          className="mb-2 w-full rounded-lg border px-3 py-2 text-[13px] leading-relaxed outline-none"
          style={inputStyle}
        />
        <p className="mb-3 text-[11px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
          ここに書いた全文がそのままシステムプロンプトになります。末尾に「人称(POV 指定)」と厳守事項
          (シーンにある出来事以外を発生させない / POV キャラが知らない情報を書かない 等)だけが自動で追加されます。
        </p>
        {error && (
          <p className="mb-2 text-[12px]" style={{ color: 'var(--danger)' }}>
            {error}
          </p>
        )}
        <div className="flex items-center gap-2">
          {form.id && (
            <button onClick={() => void handleDelete()} disabled={busy} className="text-[12px]" style={{ color: 'var(--danger)' }}>
              削除
            </button>
          )}
          <div className="ml-auto flex gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-[13px]" style={{ color: 'var(--text-dim)' }}>
              キャンセル
            </button>
            <button
              onClick={() => void handleSave()}
              disabled={busy}
              className="rounded-lg px-4 py-1.5 text-[13px] font-medium text-white disabled:opacity-50"
              style={{ background: 'var(--accent)' }}
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function ReaderMode(): React.JSX.Element {
  const [presets, setPresets] = useState<StylePreset[]>([])
  const [presetId, setPresetId] = useState<string | null>(null)
  const [characters, setCharacters] = useState<Character[]>([])
  const [povChar, setPovChar] = useState<string | null>(null)
  const [scenes, setScenes] = useState<SceneEntry[]>([])
  const [rendering, setRendering] = useState(false)
  const [liveNodeId, setLiveNodeId] = useState<string | null>(null)
  const [liveText, setLiveText] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const [promote, setPromote] = useState<PromoteState | null>(null)
  const [presetEditor, setPresetEditor] = useState<PresetDraft | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const renderAbortRef = useRef<AbortController | null>(null)

  const reloadPresets = useCallback(async (selectId?: string): Promise<void> => {
    const p = await api.listPresets()
    setPresets(p)
    if (selectId) {
      setPresetId(selectId)
      void api.putSettings({ reader_preset_id: selectId })
    } else {
      setPresetId((prev) => (prev && p.some((x) => x.id === prev) ? prev : p[0]?.id ?? null))
    }
  }, [])

  useEffect(() => {
    void Promise.all([api.listPresets(), api.listCharacters(), api.getSettings()]).then(
      ([p, chars, settings]) => {
        setPresets(p)
        setCharacters(chars)
        // 前回の選択を復元(ライブラリごとの settings に保存)
        const savedPreset = settings.reader_preset_id
        setPresetId(savedPreset && p.some((x) => x.id === savedPreset) ? savedPreset : p[0]?.id ?? null)
        const savedPov = settings.reader_pov_char
        if (savedPov && chars.some((c) => c.id === savedPov)) setPovChar(savedPov)
      }
    )
  }, [])

  const reloadScenes = useCallback(async (): Promise<void> => {
    if (!presetId) return
    setScenes(await api.listRenders(presetId, povChar))
  }, [presetId, povChar])

  useEffect(() => {
    void reloadScenes()
  }, [reloadScenes])

  const runRender = async (fromNode: string | null, mode: 'single' | 'to_end'): Promise<void> => {
    if (!presetId || rendering) return
    const controller = new AbortController()
    renderAbortRef.current = controller
    setRendering(true)
    setStatus('LLM 準備中…')
    try {
      await renderStream(
        { preset_id: presetId, pov_char: povChar, from_node: fromNode, mode },
        (e) => {
          if (e.scene_start) {
            setLiveNodeId(e.scene_start)
            setLiveText('')
            setStatus(`清書中: ${e.title || '(無題)'}`)
          } else if (e.delta) {
            setLiveText((t) => t + e.delta)
          } else if (e.scene_done) {
            setLiveNodeId(null)
            setLiveText('')
            void reloadScenes()
          } else if (e.error) {
            setStatus(`エラー: ${e.error}`)
          } else if (e.done) {
            setStatus(null)
          }
        },
        controller.signal
      )
    } catch (err) {
      setStatus(isAbortError(err) ? 'キャンセルしました(書きかけのシーンは保存されません)' : String(err))
    } finally {
      renderAbortRef.current = null
      setRendering(false)
      setLiveNodeId(null)
      void reloadScenes()
    }
  }

  // 散文の選択 → ビート昇格
  const handleMouseUp = (nodeId: string): void => {
    const selection = window.getSelection()
    const text = selection?.toString().trim() ?? ''
    if (!text || text.length < 4) return
    setPromote({ nodeId, selection: text, proposal: null, loading: false, error: null })
  }

  const requestProposal = async (): Promise<void> => {
    if (!promote) return
    setPromote((p) => (p ? { ...p, loading: true, error: null } : p))
    try {
      const proposal = await api.promotePreview(promote.nodeId, promote.selection)
      setPromote((p) => (p ? { ...p, proposal, loading: false } : p))
    } catch (e) {
      setPromote((p) => (p ? { ...p, loading: false, error: String(e) } : p))
    }
  }

  const applyProposal = async (): Promise<void> => {
    if (!promote?.proposal) return
    const scene = scenes.find((s) => s.node.id === promote.nodeId)
    if (!scene) return
    const proposal = promote.proposal
    await api.updateNode(scene.node.id, { beat: `${scene.node.beat}\n${proposal.beat_appendix}` })
    if (proposal.events.length > 0) {
      await api.putEvents(scene.node.id, [
        ...scene.node.events.map((e) => ({ type: e.type, payload: e.payload, source: e.source })),
        ...proposal.events.map((e) => ({ ...e, source: 'llm' as const }))
      ])
    }
    setPromote(null)
    void reloadScenes()
  }

  const exportMarkdown = (): void => {
    const parts = scenes
      .filter((s) => s.render)
      .map((s) => `## ${s.node.title || '(無題)'}\n\n${s.render!.prose}`)
    const blob = new Blob([parts.join('\n\n---\n\n')], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'story.md'
    a.click()
    URL.revokeObjectURL(url)
  }

  const hasAnyRender = scenes.some((s) => s.render)
  const selectStyle = { background: 'var(--bg-input)', borderColor: 'var(--border)' }

  return (
    <div className="flex h-full flex-col">
      {/* コントロールバー */}
      <div
        className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2"
        style={{ background: 'var(--bg-sidebar)', borderColor: 'var(--border)' }}
      >
        <select
          value={presetId ?? ''}
          onChange={(e) => {
            setPresetId(e.target.value)
            void api.putSettings({ reader_preset_id: e.target.value })
          }}
          className="rounded-lg border px-2 py-1 text-[12px]"
          style={selectStyle}
        >
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button
          onClick={() => {
            const current = presets.find((p) => p.id === presetId)
            if (!current) return
            if (current.builtin) {
              // 組み込みは編集不可 → 複製して新規プリセットとして開く
              setPresetEditor({ name: `${current.name} のコピー`, person: current.person, tone: current.tone })
            } else {
              setPresetEditor({ id: current.id, name: current.name, person: current.person, tone: current.tone })
            }
          }}
          disabled={!presetId}
          className="rounded-lg border px-2 py-1 text-[12px] disabled:opacity-40"
          style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
          title={
            presets.find((p) => p.id === presetId)?.builtin
              ? '組み込みプリセットは編集できません。複製して新規作成します'
              : '選択中のプリセットを編集'
          }
        >
          {presets.find((p) => p.id === presetId)?.builtin ? '⧉ 複製して編集' : '✎ 編集'}
        </button>
        <button
          onClick={() => setPresetEditor({ name: '', person: 'third', tone: '' })}
          className="rounded-lg border px-2 py-1 text-[12px]"
          style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
          title="スタイルプリセットを新規作成"
        >
          + 新規
        </button>
        <select
          value={povChar ?? ''}
          onChange={(e) => {
            setPovChar(e.target.value || null)
            void api.putSettings({ reader_pov_char: e.target.value })
          }}
          className="rounded-lg border px-2 py-1 text-[12px]"
          style={selectStyle}
        >
          <option value="">三人称(POVなし)</option>
          {characters.map((c) => (
            <option key={c.id} value={c.id}>
              POV: {c.name}
            </option>
          ))}
        </select>
        {rendering ? (
          <button
            onClick={() => renderAbortRef.current?.abort()}
            className="rounded-lg border px-3 py-1 text-[12px] font-medium"
            style={{ borderColor: 'rgba(239,68,68,0.5)', color: 'var(--danger)' }}
          >
            ■ 清書を中止
          </button>
        ) : (
          <button
            onClick={() => void runRender(null, 'to_end')}
            disabled={!presetId}
            className="rounded-lg px-3 py-1 text-[12px] font-medium text-white disabled:opacity-50"
            style={{ background: 'var(--accent)' }}
          >
            ▶ 全編を清書
          </button>
        )}
        <button
          onClick={exportMarkdown}
          disabled={!hasAnyRender}
          className="rounded-lg border px-3 py-1 text-[12px] disabled:opacity-40"
          style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
        >
          ⬇ Markdown
        </button>
        {status && (
          <span className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
            {status}
          </span>
        )}
      </div>

      {/* 縦読みビュー */}
      <div ref={containerRef} className="inspector-scrollbar min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl px-6 py-8">
          {scenes.length === 0 && (
            <div className="pt-16 text-center text-[13px]" style={{ color: 'var(--text-faint)' }}>
              正史パスにシーンがありません。構造モードで物語を作成してください。
            </div>
          )}
          {scenes.map((scene) => {
            const isLive = liveNodeId === scene.node.id
            const stale = scene.render?.stale === 1
            return (
              <section key={scene.node.id} className="mb-10">
                <div className="mb-3 flex items-center gap-2">
                  <h2 className="text-[16px] font-semibold" style={{ color: 'var(--text)' }}>
                    {scene.node.title || '(無題)'}
                  </h2>
                  {stale && (
                    <span
                      className="rounded px-1.5 py-px text-[10px] uppercase"
                      style={{ background: 'rgba(239,68,68,0.12)', color: '#f2a3a3' }}
                    >
                      stale
                    </span>
                  )}
                  <div className="ml-auto flex gap-1.5">
                    <button
                      onClick={() => void runRender(scene.node.id, 'single')}
                      disabled={rendering}
                      className="rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-40"
                      style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
                    >
                      このシーンのみ
                    </button>
                    <button
                      onClick={() => void runRender(scene.node.id, 'to_end')}
                      disabled={rendering}
                      className="rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-40"
                      style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
                    >
                      ここから最後まで
                    </button>
                  </div>
                </div>
                {assetUrl(scene.node.image_path) && (
                  <img
                    src={assetUrl(scene.node.image_path)!}
                    className="mb-4 max-h-80 w-full rounded-2xl object-cover"
                  />
                )}
                {isLive ? (
                  <div
                    className="whitespace-pre-wrap text-[14px] leading-[1.9]"
                    style={{ color: 'var(--text)' }}
                  >
                    {liveText}
                    <span className="node-generating-border ml-0.5 inline-block h-4 w-1.5 align-middle" style={{ background: 'var(--accent)' }} />
                  </div>
                ) : scene.render ? (
                  <div
                    className="whitespace-pre-wrap text-[14px] leading-[1.9]"
                    style={{ color: 'var(--text)', opacity: stale ? 0.6 : 1 }}
                    onMouseUp={() => handleMouseUp(scene.node.id)}
                  >
                    {scene.render.prose}
                  </div>
                ) : (
                  <div
                    className="rounded-xl border border-dashed px-4 py-6 text-center text-[12px]"
                    style={{ borderColor: 'var(--border-strong)', color: 'var(--text-faint)' }}
                  >
                    未清書
                    <div className="mt-1 text-[11px]">{scene.node.beat}</div>
                  </div>
                )}
              </section>
            )
          })}
        </div>
      </div>

      {/* プリセットエディタ */}
      {presetEditor && (
        <PresetEditorModal
          draft={presetEditor}
          onClose={() => setPresetEditor(null)}
          onSaved={(id) => {
            setPresetEditor(null)
            void reloadPresets(id)
          }}
          onDeleted={() => {
            setPresetEditor(null)
            void reloadPresets()
          }}
        />
      )}

      {/* ビート昇格モーダル */}
      {promote && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.55)' }}
          onClick={() => setPromote(null)}
        >
          <div
            className="w-[540px] max-w-[90vw] rounded-2xl border p-5"
            style={{ background: 'var(--bg-card)', borderColor: 'var(--border-strong)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-2 text-[14px] font-semibold" style={{ color: 'var(--text)' }}>
              シーンに取り込む
            </h3>
            <div
              className="mb-3 max-h-28 overflow-y-auto rounded-lg border px-3 py-2 text-[12px] leading-relaxed"
              style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)', color: 'var(--text-dim)' }}
            >
              {promote.selection}
            </div>
            {promote.proposal ? (
              <>
                <div className="mb-1 text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-faint)' }}>
                  シーン追記案
                </div>
                <div className="mb-3 rounded-lg border px-3 py-2 text-[13px]" style={{ background: 'var(--bg-input)', borderColor: 'var(--border)', color: 'var(--text)' }}>
                  {promote.proposal.beat_appendix}
                </div>
                {promote.proposal.events.length > 0 && (
                  <>
                    <div className="mb-1 text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-faint)' }}>
                      イベント diff 案
                    </div>
                    {promote.proposal.events.map((e, i) => (
                      <div
                        key={i}
                        className="mb-1 rounded-lg border px-3 py-1.5 font-mono text-[11px]"
                        style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)', color: 'var(--text-dim)' }}
                      >
                        {e.type} {JSON.stringify(e.payload)}
                      </div>
                    ))}
                  </>
                )}
                <div className="mt-3 flex justify-end gap-2">
                  <button onClick={() => setPromote(null)} className="px-3 py-1.5 text-[13px]" style={{ color: 'var(--text-dim)' }}>
                    キャンセル
                  </button>
                  <button
                    onClick={() => void applyProposal()}
                    className="rounded-lg px-4 py-1.5 text-[13px] font-medium text-white"
                    style={{ background: 'var(--accent)' }}
                  >
                    正史に取り込む
                  </button>
                </div>
              </>
            ) : (
              <div className="flex items-center justify-between">
                <span className="text-[12px]" style={{ color: promote.error ? 'var(--danger)' : 'var(--text-dim)' }}>
                  {promote.error ?? (promote.loading ? 'LLM が提案を作成中…' : 'この一節をシーン記述+イベントに変換します')}
                </span>
                <div className="flex gap-2">
                  <button onClick={() => setPromote(null)} className="px-3 py-1.5 text-[13px]" style={{ color: 'var(--text-dim)' }}>
                    キャンセル
                  </button>
                  <button
                    onClick={() => void requestProposal()}
                    disabled={promote.loading}
                    className="rounded-lg px-4 py-1.5 text-[13px] font-medium text-white disabled:opacity-50"
                    style={{ background: 'var(--accent)' }}
                  >
                    提案を生成
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
