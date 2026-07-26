import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api, assetUrl, isAbortError, isVideoAsset, renderStream } from '../api'
import { CrossfadeLoopVideo, DEFAULT_VIDEO_CROSSFADE_SECONDS } from '../CrossfadeLoopVideo'
import { endTask, startTask, updateTask } from '../tasks'
import { useElapsedSeconds } from '../useElapsed'
import type { Character, PromoteProposal, SceneEntry, StylePreset } from '../types'

interface PromoteState {
  nodeId: string
  selection: string
  proposal: PromoteProposal | null
  loading: boolean
  error: string | null
}

// 本文フォント(ローカルにインストール済みのものが使われる。無ければ後続へフォールバック)
const FONT_OPTIONS = [
  { id: 'sans', label: 'ゴシック(標準)', stack: '"Inter", "Segoe UI", "Noto Sans JP", system-ui, sans-serif' },
  {
    id: 'mincho',
    label: 'しっぽり明朝 / 明朝',
    stack: '"Shippori Mincho", "しっぽり明朝", "Yu Mincho", "游明朝", "Hiragino Mincho ProN", "MS PMincho", serif'
  },
  {
    id: 'serif',
    label: 'Reading Serif',
    stack: 'Georgia, "Times New Roman", "Yu Mincho", "游明朝", serif'
  }
] as const

type ViewMode = 'scroll' | 'split' | 'page'

const VIEW_MODES: Array<{ id: ViewMode; label: string; title: string }> = [
  { id: 'scroll', label: '縦読み', title: 'ウェブ風の縦スクロール' },
  { id: 'split', label: '挿絵分割', title: '挿絵を左に固定し、右で文章をスクロール' },
  { id: 'page', label: 'ページ', title: '1シーンずつ、めくって読む' }
]

const TYPEWRITER_CHARS_PER_TICK = 4

const FONT_SIZES = [
  { value: 13, label: '小' },
  { value: 14, label: '標準' },
  { value: 16, label: '中' },
  { value: 18, label: '大' },
  { value: 20, label: '特大' }
]

/** ページモードの1ページ。text=null は未清書シーンのプレースホルダ */
interface PageChunk {
  sceneIndex: number
  text: string | null
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

export default function ReaderMode({
  focusNodeId
}: {
  /** 構造モードで選んでいたシーン。開いたときにここへ飛ぶ */
  focusNodeId?: string | null
} = {}): React.JSX.Element {
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
  const [viewMode, setViewMode] = useState<ViewMode>('scroll')
  const [fontId, setFontId] = useState<string>('sans')
  const [fontSize, setFontSize] = useState<number>(14)
  const [videoFade, setVideoFade] = useState<number>(DEFAULT_VIDEO_CROSSFADE_SECONDS)
  const [pageIndex, setPageIndex] = useState(0)
  const [typedLen, setTypedLen] = useState(0)
  const [pages, setPages] = useState<PageChunk[]>([])
  const [pageBoxSize, setPageBoxSize] = useState({ width: 0, height: 0 })
  const containerRef = useRef<HTMLDivElement | null>(null)
  const renderAbortRef = useRef<AbortController | null>(null)
  const pageAreaRef = useRef<HTMLDivElement | null>(null) // 本文エリア全体(挿絵の有無に依らず全高・全幅)
  const measurerRef = useRef<HTMLDivElement | null>(null)

  const proseFont = FONT_OPTIONS.find((f) => f.id === fontId)?.stack ?? FONT_OPTIONS[0].stack
  const renderElapsed = useElapsedSeconds(rendering)
  const promoteElapsed = useElapsedSeconds(promote?.loading ?? false)

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
        if (settings.reader_view === 'split' || settings.reader_view === 'page') {
          setViewMode(settings.reader_view)
        }
        if (FONT_OPTIONS.some((f) => f.id === settings.reader_font)) setFontId(settings.reader_font)
        const savedSize = Number(settings.reader_font_size)
        if (FONT_SIZES.some((s) => s.value === savedSize)) setFontSize(savedSize)
        const savedFade = Number(settings.video_crossfade_seconds)
        if (Number.isFinite(savedFade) && savedFade >= 0) setVideoFade(Math.min(savedFade, 5))
      }
    )
  }, [])

  // ---- ページモード: 画面に収まる分量でページ分割する ----------------
  // 本文エリア全体のサイズを監視(挿絵の有無に依らず安定した基準になる)
  // シーンが空の間は本文エリア自体が描画されないため、シーン到着後に再実行する
  const hasScenes = scenes.length > 0
  useEffect(() => {
    if (viewMode !== 'page') return
    const area = pageAreaRef.current
    if (!area) return
    const update = (): void =>
      setPageBoxSize((prev) => {
        const next = { width: area.clientWidth, height: area.clientHeight }
        return prev.width === next.width && prev.height === next.height ? prev : next
      })
    update()
    const observer = new ResizeObserver(update)
    observer.observe(area)
    return () => observer.disconnect()
  }, [viewMode, hasScenes])

  // ページ分割の計算: 実測(隠し要素)で「高さに収まる最大文字数」を二分探索し、
  // 句点・改行のきりの良い位置で区切る。挿絵ありシーンは上部 42% を挿絵に
  // 使うため、本文の高さがその分小さくなる
  const scenesSig = scenes.map((s) => `${s.render?.id ?? 'x'}-${s.node.image_path ?? ''}`).join(',')
  useEffect(() => {
    if (viewMode !== 'page') return
    const measurer = measurerRef.current
    const areaWidth = pageBoxSize.width
    const areaHeight = pageBoxSize.height
    if (!measurer || areaHeight < 60 || areaWidth < 60) return
    measurer.style.width = `${Math.floor(areaWidth)}px`
    const result: PageChunk[] = []
    for (let si = 0; si < scenes.length; si += 1) {
      const prose = scenes[si].render?.prose
      if (!prose) {
        result.push({ sceneIndex: si, text: null })
        continue
      }
      const hasImage = !!scenes[si].node.image_path
      const maxHeight = hasImage ? areaHeight - Math.floor(areaHeight * 0.42) - 16 : areaHeight
      let pos = 0
      while (pos < prose.length) {
        let lo = pos + 1
        let hi = prose.length
        let fit = pos + 1
        while (lo <= hi) {
          const mid = Math.floor((lo + hi) / 2)
          measurer.textContent = prose.slice(pos, mid)
          if (measurer.scrollHeight <= maxHeight) {
            fit = mid
            lo = mid + 1
          } else {
            hi = mid - 1
          }
        }
        let end = fit
        if (end < prose.length) {
          // きりの良い位置(改行 or 句点)まで戻す。戻りすぎは避ける
          const slice = prose.slice(pos, end)
          const breakAt = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf('。') + 1 || -1)
          if (breakAt > slice.length * 0.5) end = pos + breakAt
        }
        result.push({ sceneIndex: si, text: prose.slice(pos, end) })
        pos = end
      }
    }
    measurer.textContent = ''
    setPages(result)
    setPageIndex((i) => Math.min(i, Math.max(result.length - 1, 0)))
  }, [viewMode, scenesSig, fontId, fontSize, pageBoxSize])

  // タイプライター表示(ページ単位)。リセットを描画前に行わないと、
  // ページ切替の瞬間に前ページの typedLen 分だけ次ページの文章が見えてしまう
  const currentChunk = viewMode === 'page' ? pages[Math.min(pageIndex, Math.max(pages.length - 1, 0))] : undefined
  const currentChunkText = currentChunk?.text ?? null
  useLayoutEffect(() => {
    if (viewMode !== 'page' || !currentChunkText) {
      setTypedLen(0)
      return
    }
    setTypedLen(0)
    let count = 0
    const timer = setInterval(() => {
      count += TYPEWRITER_CHARS_PER_TICK
      setTypedLen(count)
      if (count >= currentChunkText.length) clearInterval(timer)
    }, 16)
    return () => clearInterval(timer)
  }, [viewMode, pageIndex, currentChunkText])

  // 矢印キーでページ移動
  useEffect(() => {
    if (viewMode !== 'page') return
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return
      if (e.key === 'ArrowRight') setPageIndex((i) => Math.min(i + 1, pages.length - 1))
      if (e.key === 'ArrowLeft') setPageIndex((i) => Math.max(i - 1, 0))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [viewMode, pages.length])

  const reloadScenes = useCallback(async (): Promise<void> => {
    if (!presetId) return
    setScenes(await api.listRenders(presetId, povChar))
  }, [presetId, povChar])

  useEffect(() => {
    void reloadScenes()
  }, [reloadScenes])

  // 構造モードで選んでいたシーンへ移動する(開いた直後の一度だけ)。
  // ページモードはそのシーンを含む最初のページへ、それ以外はスクロール
  const focusedOnceRef = useRef(false)
  useEffect(() => {
    if (focusedOnceRef.current || !focusNodeId || scenes.length === 0) return
    const index = scenes.findIndex((s) => s.node.id === focusNodeId)
    if (index < 0) return // 正史外(分岐や島)のシーンは清書一覧に出ない
    focusedOnceRef.current = true
    if (viewMode === 'page') {
      // ページ分割の計算が終わるまで待ってから該当ページへ
      if (pages.length === 0) {
        focusedOnceRef.current = false
        return
      }
      const page = pages.findIndex((p) => p.sceneIndex === index)
      if (page >= 0) setPageIndex(page)
      return
    }
    // レイアウトが落ち着いてからスクロールする
    requestAnimationFrame(() => {
      document.getElementById(`reader-scene-${focusNodeId}`)?.scrollIntoView({ block: 'start' })
    })
  }, [focusNodeId, scenes, viewMode, pages])

  const runRender = async (fromNode: string | null, mode: 'single' | 'to_end'): Promise<void> => {
    if (!presetId || rendering) return
    const controller = new AbortController()
    renderAbortRef.current = controller
    setRendering(true)
    setStatus('LLM 準備中…')
    // ページを離れても進捗が分かるよう、ステータスバーにも出す
    const taskId = startTask({
      label: '清書',
      detail: 'LLM 準備中…',
      abort: () => controller.abort()
    })
    let doneCount = 0
    try {
      await renderStream(
        { preset_id: presetId, pov_char: povChar, from_node: fromNode, mode },
        (e) => {
          if (e.scene_start) {
            setLiveNodeId(e.scene_start)
            setLiveText('')
            setStatus(`清書中: ${e.title || '(無題)'}`)
            updateTask(taskId, { detail: e.title || '(無題)', done: doneCount })
          } else if (e.delta) {
            setLiveText((t) => t + e.delta)
          } else if (e.scene_done) {
            setLiveNodeId(null)
            setLiveText('')
            doneCount += 1
            updateTask(taskId, { done: doneCount })
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
      endTask(taskId)
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

  // ---- スタイルプリセット(=散文用システムプロンプト)の入出力 --------
  const presetImportRef = useRef<HTMLInputElement | null>(null)

  const exportPresets = (): void => {
    const custom = presets.filter((p) => !p.builtin)
    if (custom.length === 0) {
      setStatus('書き出せるカスタムプリセットがありません(組み込みは対象外)')
      return
    }
    const payload = {
      kind: 'story-graph-style-presets',
      version: 1,
      presets: custom.map((p) => ({ name: p.name, person: p.person, tone: p.tone }))
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'style-presets.json'
    a.click()
    URL.revokeObjectURL(url)
    setStatus(`${custom.length} 件のプリセットを書き出しました`)
  }

  const importPresets = async (file: File): Promise<void> => {
    try {
      const data = JSON.parse(await file.text())
      const list: unknown = Array.isArray(data) ? data : data?.presets
      if (!Array.isArray(list)) throw new Error('プリセット配列が見つかりません')
      let imported = 0
      let lastId: string | undefined
      for (const item of list as Array<Record<string, unknown>>) {
        const name = String(item?.name ?? '').trim()
        if (!name) continue
        // id は付けない(常に新規プリセットとして取り込み、既存・組み込みを壊さない)
        const saved = await api.upsertPreset({
          name,
          person: item?.person === 'first' ? 'first' : 'third',
          tone: String(item?.tone ?? '')
        })
        lastId = saved.id
        imported += 1
      }
      if (imported === 0) throw new Error('取り込めるプリセットがありませんでした')
      await reloadPresets(lastId)
      setStatus(`${imported} 件のプリセットを取り込みました`)
    } catch (e) {
      setStatus(`インポート失敗: ${String(e)}`)
    }
  }

  const hasAnyRender = scenes.some((s) => s.render)
  const selectStyle = { background: 'var(--bg-input)', borderColor: 'var(--border)' }

  const renderSceneHeader = (scene: SceneEntry): React.JSX.Element => {
    const stale = scene.render?.stale === 1
    return (
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
    )
  }

  const renderProse = (scene: SceneEntry, textOverride?: string, typing = false): React.JSX.Element => {
    const isLive = liveNodeId === scene.node.id
    const stale = scene.render?.stale === 1
    const proseStyle = { color: 'var(--text)', fontFamily: proseFont, fontSize, lineHeight: 1.9 }
    if (isLive) {
      return (
        <div className="whitespace-pre-wrap" style={proseStyle}>
          {liveText}
          <span
            className="node-generating-border ml-0.5 inline-block h-4 w-1.5 align-middle"
            style={{ background: 'var(--accent)' }}
          />
        </div>
      )
    }
    if (scene.render) {
      return (
        <div
          className="whitespace-pre-wrap"
          style={{ ...proseStyle, opacity: stale ? 0.6 : 1 }}
          onMouseUp={() => handleMouseUp(scene.node.id)}
        >
          {textOverride ?? scene.render.prose}
          {typing && (
            <span className="ml-0.5 inline-block h-4 w-1.5 align-middle" style={{ background: 'var(--text-faint)' }} />
          )}
        </div>
      )
    }
    return (
      <div
        className="rounded-xl border border-dashed px-4 py-6 text-center text-[12px]"
        style={{ borderColor: 'var(--border-strong)', color: 'var(--text-faint)' }}
      >
        未清書
        <div className="mt-1 text-[11px]">{scene.node.beat}</div>
      </div>
    )
  }

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
        <button
          onClick={exportPresets}
          className="rounded-lg border px-2 py-1 text-[12px]"
          style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
          title="カスタムのスタイルプリセット(散文用システムプロンプト)を JSON に書き出す"
        >
          ⬆ 書き出し
        </button>
        <button
          onClick={() => presetImportRef.current?.click()}
          className="rounded-lg border px-2 py-1 text-[12px]"
          style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
          title="JSON からスタイルプリセットを取り込む(新規プリセットとして追加)"
        >
          ⬇ 読み込み
        </button>
        <input
          ref={presetImportRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            if (file) void importPresets(file)
          }}
        />
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
        <div className="flex overflow-hidden rounded-lg border" style={{ borderColor: 'var(--border-strong)' }}>
          {VIEW_MODES.map((v) => (
            <button
              key={v.id}
              onClick={() => {
                setViewMode(v.id)
                void api.putSettings({ reader_view: v.id })
              }}
              className="px-2.5 py-1 text-[12px]"
              style={
                viewMode === v.id
                  ? { background: 'var(--accent-soft)', color: 'var(--text)' }
                  : { color: 'var(--text-faint)' }
              }
              title={v.title}
            >
              {v.label}
            </button>
          ))}
        </div>
        <select
          value={fontId}
          onChange={(e) => {
            setFontId(e.target.value)
            void api.putSettings({ reader_font: e.target.value })
          }}
          className="rounded-lg border px-2 py-1 text-[12px]"
          style={selectStyle}
          title="本文フォント(ローカルにインストールされているものが使われます)"
        >
          {FONT_OPTIONS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </select>
        <select
          value={fontSize}
          onChange={(e) => {
            setFontSize(Number(e.target.value))
            void api.putSettings({ reader_font_size: e.target.value })
          }}
          className="rounded-lg border px-2 py-1 text-[12px]"
          style={selectStyle}
          title="本文の文字サイズ"
        >
          {FONT_SIZES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}({s.value}px)
            </option>
          ))}
        </select>
        {status && (
          <span className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
            {status}
            {rendering && (
              <span className="ml-1 tabular-nums" style={{ color: 'var(--text-faint)' }}>
                ({renderElapsed}s)
              </span>
            )}
          </span>
        )}
      </div>

      {/* 本文ビュー(縦読み / 挿絵分割: スクロール、ページ: 固定) */}
      {viewMode === 'page' ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {scenes.length === 0 ? (
            <div className="pt-16 text-center text-[13px]" style={{ color: 'var(--text-faint)' }}>
              正史パスにシーンがありません。構造モードで物語を作成してください。
            </div>
          ) : (
            (() => {
              const chunk = pages[Math.min(pageIndex, Math.max(pages.length - 1, 0))]
              const scene = scenes[chunk?.sceneIndex ?? 0]
              if (!scene) return null
              const img = assetUrl(scene.node.image_path)
              const isLive = liveNodeId === scene.node.id
              const text = chunk?.text ?? null
              const typing = !isLive && text !== null && typedLen < text.length
              return (
                <>
                  <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col overflow-hidden px-8 pt-6">
                    {renderSceneHeader(scene)}
                    <div ref={pageAreaRef} className="flex min-h-0 flex-1 flex-col overflow-hidden">
                      {img && (
                        <div className="mb-4 flex min-h-0 shrink-0 justify-center" style={{ flexBasis: '42%' }}>
                          {isVideoAsset(scene.node.image_path) ? (
                            <CrossfadeLoopVideo src={img} fadeSeconds={videoFade} fill videoClassName="rounded-2xl" />
                          ) : (
                            <img src={img} className="max-h-full max-w-full rounded-2xl object-contain" />
                          )}
                        </div>
                      )}
                      <div
                        className={`relative min-h-0 flex-1 overflow-hidden ${isLive ? 'overflow-y-auto' : ''}`}
                        onClick={() => typing && text && setTypedLen(text.length)}
                        title={typing ? 'クリックで全文表示' : undefined}
                        style={typing ? { cursor: 'pointer' } : undefined}
                      >
                        {/* ページ分割の実測用(不可視。本文と同じ幅・書式) */}
                        <div
                          ref={measurerRef}
                          aria-hidden
                          className="invisible absolute left-0 top-0 whitespace-pre-wrap"
                          style={{ fontFamily: proseFont, fontSize, lineHeight: 1.9 }}
                        />
                        {isLive || text === null
                          ? renderProse(scene)
                          : renderProse(scene, typing ? text.slice(0, typedLen) : text, typing)}
                      </div>
                    </div>
                  </div>
                  {/* ページ送り + シークバー */}
                  <div
                    className="shrink-0 border-t px-8 py-2.5"
                    style={{ background: 'var(--bg-sidebar)', borderColor: 'var(--border)' }}
                  >
                    <div className="mx-auto flex max-w-5xl items-center gap-3">
                      <button
                        onClick={() => setPageIndex((i) => Math.max(i - 1, 0))}
                        disabled={pageIndex === 0}
                        className="shrink-0 rounded-lg border px-3 py-1 text-[12px] disabled:opacity-30"
                        style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
                      >
                        ◀ 前へ
                      </button>
                      <input
                        type="range"
                        min={0}
                        max={Math.max(pages.length - 1, 0)}
                        value={Math.min(pageIndex, Math.max(pages.length - 1, 0))}
                        onChange={(e) => setPageIndex(Number(e.target.value))}
                        className="settings-slider active min-w-0 flex-1"
                        title="ドラッグで任意のページへジャンプ"
                      />
                      <span className="shrink-0 tabular-nums text-[12px]" style={{ color: 'var(--text-faint)' }}>
                        {Math.min(pageIndex, Math.max(pages.length - 1, 0)) + 1} / {Math.max(pages.length, 1)}
                      </span>
                      <button
                        onClick={() => setPageIndex((i) => Math.min(i + 1, pages.length - 1))}
                        disabled={pageIndex >= pages.length - 1}
                        className="shrink-0 rounded-lg px-3 py-1 text-[12px] font-medium text-white disabled:opacity-30"
                        style={{ background: 'var(--accent)' }}
                      >
                        次へ ▶
                      </button>
                    </div>
                  </div>
                </>
              )
            })()
          )}
        </div>
      ) : (
      <div ref={containerRef} className="inspector-scrollbar min-h-0 flex-1 overflow-y-auto">
        <div className={`mx-auto px-6 py-8 ${viewMode === 'scroll' ? 'max-w-2xl' : 'max-w-5xl'}`}>
          {scenes.length === 0 && (
            <div className="pt-16 text-center text-[13px]" style={{ color: 'var(--text-faint)' }}>
              正史パスにシーンがありません。構造モードで物語を作成してください。
            </div>
          )}
          {scenes.map((scene) => {
                const img = assetUrl(scene.node.image_path)
                const split = viewMode === 'split' && img
                return (
                  <section key={scene.node.id} id={`reader-scene-${scene.node.id}`} className="mb-12">
                    {renderSceneHeader(scene)}
                    {split ? (
                      <div className="gap-8 md:grid md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
                        <div className="mb-4 md:mb-0">
                          {/* 同じシーン内では左の挿絵が固定され、右の文章だけがスクロールする */}
                          {isVideoAsset(scene.node.image_path) ? (
                            <CrossfadeLoopVideo
                              src={img!}
                              fadeSeconds={videoFade}
                              className="mx-auto w-fit md:sticky md:top-4"
                              videoClassName="max-h-[70vh] rounded-2xl"
                            />
                          ) : (
                            <img src={img!} className="mx-auto max-h-[70vh] max-w-full rounded-2xl md:sticky md:top-4" />
                          )}
                        </div>
                        <div>{renderProse(scene)}</div>
                      </div>
                    ) : (
                      <>
                        {img &&
                          (isVideoAsset(scene.node.image_path) ? (
                            <CrossfadeLoopVideo
                              src={img}
                              fadeSeconds={videoFade}
                              className="mx-auto mb-4 w-fit"
                              videoClassName="max-h-96 rounded-2xl"
                            />
                          ) : (
                            <img src={img} className="mx-auto mb-4 max-h-96 max-w-full rounded-2xl" />
                          ))}
                        {renderProse(scene)}
                      </>
                    )}
                  </section>
                )
              })}
        </div>
      </div>
      )}

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
                  {promote.error ??
                    (promote.loading ? `LLM が提案を作成中… (${promoteElapsed}s)` : 'この一節をシーン記述+イベントに変換します')}
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
