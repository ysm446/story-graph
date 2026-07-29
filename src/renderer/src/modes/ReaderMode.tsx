import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api, assetUrl, isAbortError, isVideoAsset, renderStream } from '../api'
import { CrossfadeLoopVideo, DEFAULT_VIDEO_CROSSFADE_SECONDS } from '../CrossfadeLoopVideo'
import { FONT_OPTIONS, FONT_SIZES, RenderStyleControls, useRenderStyle } from '../RenderStyle'
import { cancelTask, enqueueTask } from '../tasks'
import { useElapsedSeconds } from '../useElapsed'
import type { SceneEntry } from '../types'

type ViewMode = 'scroll' | 'split' | 'page'

const VIEW_MODES: Array<{ id: ViewMode; label: string; title: string }> = [
  { id: 'scroll', label: '縦読み', title: 'ウェブ風の縦スクロール' },
  { id: 'split', label: '挿絵分割', title: '挿絵を左に固定し、右で文章をスクロール' },
  { id: 'page', label: 'ページ', title: '1シーンずつ、めくって読む' }
]

const TYPEWRITER_CHARS_PER_TICK = 4

/** ページモードの1ページ。text=null は未清書シーンのプレースホルダ */
interface PageChunk {
  sceneIndex: number
  text: string | null
}

export default function ReaderMode({
  focusNodeId
}: {
  /** 構造モードで選んでいたシーン。開いたときにここへ飛ぶ */
  focusNodeId?: string | null
} = {}): React.JSX.Element {
  // スタイルプリセット / POV / 本文フォントは構造モードの清書タブと共有する
  const style = useRenderStyle()
  const { presetId, povChar, fontSize, proseFont } = style
  const [scenes, setScenes] = useState<SceneEntry[]>([])
  const [rendering, setRendering] = useState(false)
  const [liveNodeId, setLiveNodeId] = useState<string | null>(null)
  const [liveText, setLiveText] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>('scroll')
  const [videoFade, setVideoFade] = useState<number>(DEFAULT_VIDEO_CROSSFADE_SECONDS)
  const [pageIndex, setPageIndex] = useState(0)
  const [typedLen, setTypedLen] = useState(0)
  const [pages, setPages] = useState<PageChunk[]>([])
  const [pageBoxSize, setPageBoxSize] = useState({ width: 0, height: 0 })
  const containerRef = useRef<HTMLDivElement | null>(null)
  const renderTaskIdRef = useRef<string | null>(null) // 清書タスクの ID(中止ボタン用)
  const pageAreaRef = useRef<HTMLDivElement | null>(null) // 本文エリア全体(挿絵の有無に依らず全高・全幅)
  const measurerRef = useRef<HTMLDivElement | null>(null)

  const renderElapsed = useElapsedSeconds(rendering)

  // 鑑賞モードだけの表示設定(共有しないもの)
  useEffect(() => {
    void api.getSettings().then((settings) => {
      if (settings.reader_view === 'split' || settings.reader_view === 'page') {
        setViewMode(settings.reader_view)
      }
      const savedFade = Number(settings.video_crossfade_seconds)
      if (Number.isFinite(savedFade) && savedFade >= 0) setVideoFade(Math.min(savedFade, 5))
    })
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
      let pushed = false
      while (pos < prose.length) {
        // 前のページを改行で区切った名残で、ページの先頭が改行だけになることがある。
        // そのまま出すと 1 行ぶん空いてしまうので詰める(字下げの全角空白は残す)
        while (pos < prose.length && (prose[pos] === '\n' || prose[pos] === '\r')) pos += 1
        if (pos >= prose.length) break
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
        pushed = true
        pos = end
      }
      // 改行だけの清書でもシーンは 1 ページ持たせる(挿絵とシーン移動のため)
      if (!pushed) result.push({ sceneIndex: si, text: '' })
    }
    measurer.textContent = ''
    setPages(result)
    setPageIndex((i) => Math.min(i, Math.max(result.length - 1, 0)))
  }, [viewMode, scenesSig, proseFont, fontSize, pageBoxSize])

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

  // 清書はキューに積む(llama-server は 1 件ずつしか処理できない)。
  // 実行はステータスバーから見えて中止もできるので、ページを離れても平気
  const runRender = (fromNode: string | null, mode: 'single' | 'to_end'): void => {
    if (!presetId) return
    const preset = presetId
    const pov = povChar
    const taskId = enqueueTask({
      label: '清書',
      detail: mode === 'single' ? 'このシーンのみ' : 'ここから最後まで',
      runner: async ({ update, signal }) => {
        setRendering(true)
        setStatus('LLM 準備中…')
        let doneCount = 0
        try {
          await renderStream(
            { preset_id: preset, pov_char: pov, from_node: fromNode, mode },
            (e) => {
              if (e.stage === 'start') {
                // 何シーン書くかはサーバー側で決まる(未清書のみ等の絞り込み後)
                update({ total: e.total })
              } else if (e.scene_start) {
                setLiveNodeId(e.scene_start)
                setLiveText('')
                setStatus(`清書中: ${e.title || '(無題)'}`)
                // 進捗は「いま何件目か」で数える(0/N から始まらないように)
                update({ detail: e.title || '(無題)', done: doneCount + 1 })
              } else if (e.delta) {
                setLiveText((t) => t + e.delta)
              } else if (e.scene_done) {
                setLiveNodeId(null)
                setLiveText('')
                doneCount += 1
                void reloadScenes()
              } else if (e.error) {
                setStatus(`エラー: ${e.error}`)
              } else if (e.done) {
                setStatus(null)
              }
            },
            signal
          )
        } catch (err) {
          setStatus(isAbortError(err) ? 'キャンセルしました(書きかけのシーンは保存されません)' : String(err))
        } finally {
          setRendering(false)
          setLiveNodeId(null)
          void reloadScenes()
        }
      }
    })
    renderTaskIdRef.current = taskId // ページ内の「■ 清書を中止」用
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
            disabled={!presetId}
            className="rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-40"
            style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
          >
            このシーンのみ
          </button>
          <button
            onClick={() => void runRender(scene.node.id, 'to_end')}
            disabled={!presetId}
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
        <div className="whitespace-pre-wrap" style={{ ...proseStyle, opacity: stale ? 0.6 : 1 }}>
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
        {/* スタイルプリセット / POV(構造モードの清書タブと共通) */}
        <RenderStyleControls style={style} onStatus={setStatus} />
        {rendering ? (
          <button
            onClick={() => renderTaskIdRef.current && cancelTask(renderTaskIdRef.current)}
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
          value={style.fontId}
          onChange={(e) => style.setFontId(e.target.value)}
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
          onChange={(e) => style.setFontSize(Number(e.target.value))}
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
    </div>
  )
}
