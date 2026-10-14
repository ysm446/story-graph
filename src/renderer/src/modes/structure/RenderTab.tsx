import DetailSplit from '../../DetailSplit'
import { createPortal } from 'react-dom'
import { useEffect, useRef, useState } from 'react'
import { api, isAbortError, onRenderSaved, renderStream } from '../../api'
import { MsgActionButton, StatsLine, SystemPromptModal } from '../../GenMeta'
import { LengthSelect, lengthLabel, RenderStyleControls, type RenderStyleState } from '../../RenderStyle'
import { cancelTask, enqueueTask, useTaskFor } from '../../tasks'
import { useElapsedSeconds } from '../../useElapsed'
import type { RenderResult, StoryNode } from '../../types'
import { NodeThumb } from './StructureNodes'

// ---- 清書タブ --------------------------------------------------------

/** 選択シーンの清書(散文)を見て、その場で書き直せるプレビュー。
 *
 *  鑑賞モードと同じ `renders` を見ている(スタイルプリセット / POV も
 *  `RenderStyle` 経由で共通)。ここで書いたものはそのまま鑑賞モードに出る。
 */
/** 清書ボタンのヘルプ。何が材料として LLM に渡るかを並べる
 *  (backend/rendering.py の `build_render_messages` と対応させる)。 */
const RENDER_INPUTS_HELP = [
  '清書に使うもの:',
  '・スタイルプリセット — 文体と人称。選んでいないと清書できません',
  '・このシーンの本文 — タイトル / 場所 / 時間 / 感情の核も渡します',
  '・登場するキャラクター — 資料庫に書いた外見と口調',
  '・場所 — 資料庫に書いた説明と雰囲気(空欄のシーンは親から引き継ぎます)',
  '・このシーン適用後の状態 — facts、関係値、記憶(前章までのまとめを含む)',
  '・視点キャラ(POV) — 指定するとそのキャラが知っていることだけを渡します',
  '・直前シーンの清書の末尾 — 文体と場面をつなぎます(同じ条件で清書済みのときだけ)',
  '・分量の目安 — このシーンの指定があれば共通の設定より優先します'
].join('\n')

export function RenderTab({
  node,
  style,
  isCanon,
  onNodeBusyChange,
  onNodeChanged
}: {
  node: StoryNode
  style: RenderStyleState
  /** 正史パス上のシーンか(分岐・島は直前シーンの文体接続が効かない) */
  isCanon: boolean
  onNodeBusyChange: (nodeId: string, busy: boolean) => void
  /** シーン個別の分量を変えたとき(グラフの node を取り直す) */
  onNodeChanged: () => void
}): React.JSX.Element {
  const { presetId, povChar } = style
  const [render, setRender] = useState<RenderResult | null>(null)
  const [loading, setLoading] = useState(true)
  // この清書の生成に送った内容(プロンプト)をモーダルで見る(null = 閉じている)
  const [promptView, setPromptView] = useState<Array<Record<string, unknown>> | null>(null)
  // 生成中の文字列。どのシーンのものかを持つ(生成中に別のシーンへ移れる)
  const [live, setLive] = useState<{ nodeId: string; text: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const task = useTaskFor('render', node.id)
  const running = task?.status === 'running'
  const elapsed = useElapsedSeconds(running)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  // シーン個別の分量。保存はサーバー任せだが、reload を待つと選択が戻って見えるので
  // 楽観的にローカルへ反映する(node が更新されたら破棄)
  const [charsOverride, setCharsOverride] = useState<number | null>(null)
  useEffect(() => {
    setCharsOverride(null)
  }, [node.id, node.target_chars])
  const nodeChars = charsOverride ?? node.target_chars ?? 0
  // 実際に効く字数(シーン個別 > 共通)。表示と字数比較に使う
  const effectiveChars = nodeChars || style.targetChars
  // 分量の保存が終わる前に清書を押されても取りこぼさないよう、保存を待ってから流す
  const savingRef = useRef<Promise<unknown>>(Promise.resolve())
  // 清書タスクを中止したとき、保存待ちで固まらないよう保存も中止できるようにする
  const saveAbortRef = useRef<AbortController | null>(null)

  const saveNodeChars = (chars: number): void => {
    setCharsOverride(chars)
    const controller = new AbortController()
    saveAbortRef.current = controller
    savingRef.current = api
      .setNodeTargetChars(node.id, chars || null, controller.signal)
      .then(onNodeChanged)
      .catch((e) => {
        if (!isAbortError(e)) setError(String(e))
      })
  }

  // いま何を映しているか。生成完了時に「まだ同じ条件を見ているか」の判定に使う
  const shownRef = useRef({ nodeId: node.id, presetId, povChar })
  useEffect(() => {
    shownRef.current = { nodeId: node.id, presetId, povChar }
  }, [node.id, presetId, povChar])

  useEffect(() => {
    if (!presetId) {
      setRender(null)
      setLoading(false)
      return
    }
    let ignore = false
    setLoading(true)
    setError(null)
    void api
      .getRender(node.id, presetId, povChar)
      .then((r) => {
        if (!ignore) setRender(r.render)
      })
      .catch((e) => {
        if (!ignore) setError(String(e))
      })
      .finally(() => {
        if (!ignore) setLoading(false)
      })
    return () => {
      ignore = true
    }
    // updated_at はシーン編集後に stale 表示を取り直すために見る
  }, [node.id, node.updated_at, presetId, povChar])

  // 自分以外が書いた清書(右クリックの一括清書・鑑賞モード発の清書)も
  // 書き上がった時点で反映する。runner の setRender は積んだインスタンス
  // にしか届かないので、保存通知から取り直す
  useEffect(
    () =>
      onRenderSaved((savedNodeId) => {
        if (savedNodeId !== node.id || !presetId) return
        void api
          .getRender(node.id, presetId, povChar)
          .then((r) => {
            const shown = shownRef.current
            if (shown.nodeId === node.id && shown.presetId === presetId && shown.povChar === povChar) {
              setRender(r.render)
            }
          })
          .catch(() => undefined)
      }),
    [node.id, presetId, povChar]
  )

  // 生成中は末尾に追従する
  const liveText = live?.nodeId === node.id ? live.text : null
  useEffect(() => {
    if (liveText === null) return
    const el = bodyRef.current
    if (el) {
      const layout = el.parentElement
      if (layout && getComputedStyle(layout).display === 'block') layout.scrollTop = el.offsetTop + el.scrollHeight - layout.clientHeight
      else el.scrollTop = el.scrollHeight
    }
  }, [liveText])

  const runRender = (): void => {
    if (!presetId) return
    const targetId = node.id // 実行までに別のシーンへ移っても対象は変えない
    const preset = presetId
    const pov = povChar
    const chars = style.targetChars
    setError(null)
    enqueueTask({
      label: '清書',
      detail: node.title || '(無題)',
      kind: 'render',
      nodeId: targetId,
      runner: async ({ signal }) => {
        onNodeBusyChange(targetId, true)
        setLive({ nodeId: targetId, text: '' })
        // 中止されたら保存も中止する(保存待ちのまま固まらないように)。
        // 止めるのは開始時点で待っている保存だけ(後から変えた分量の保存は巻き込まない)
        const pendingSave = saveAbortRef.current
        const onAbort = (): void => pendingSave?.abort()
        signal.addEventListener('abort', onAbort, { once: true })
        try {
          // 直前に分量を変えていたら、その保存を待ってから流す
          // (シーン個別の分量はサーバーがノードから読むため)
          await savingRef.current.catch(() => undefined)
          await renderStream(
            {
              preset_id: preset,
              pov_char: pov,
              node_ids: [targetId],
              skip_existing: false,
              target_chars: chars
            },
            (e) => {
              if (e.delta) setLive((l) => (l && l.nodeId === targetId ? { ...l, text: l.text + e.delta } : l))
              if (e.scene_done && e.render) {
                const shown = shownRef.current
                if (shown.nodeId === targetId && shown.presetId === preset && shown.povChar === pov) {
                  setRender(e.render)
                }
              }
              // エラーも同じ条件を見ているときだけ出す(別のシーンに混ざらないように)
              if (e.error && shownRef.current.nodeId === targetId) setError(e.error)
            },
            signal
          )
        } catch (err) {
          setError(isAbortError(err) ? '清書を中止しました(書きかけは保存されません)' : String(err))
        } finally {
          signal.removeEventListener('abort', onAbort)
          onNodeBusyChange(targetId, false)
          setLive(null)
        }
      }
    })
  }

  // 本文はシーンタブと同じ UI フォント・サイズで出す(鑑賞用の proseFont / fontSize は
  // 鑑賞モード側だけに使う。インスペクタ内は他タブと見た目を揃える方針。2026-07-31)
  const proseClass = 'whitespace-pre-wrap text-[13px] leading-relaxed'
  const stale = render?.stale === 1

  return (
    <div className="scene-detail flex min-h-0 flex-1 flex-col">
      <DetailSplit storageKey="renderDetailMetaWidth" mainOnRight mainScrollRef={bodyRef} main={<>
        {liveText !== null ? (
          <div className={proseClass} style={{ color: 'var(--text)' }}>
            {liveText}
            <span
              className="node-generating-border ml-0.5 inline-block h-4 w-1.5 align-middle"
              style={{ background: 'var(--accent)' }}
            />
          </div>
        ) : render ? (
          <div className={proseClass} style={{ color: 'var(--text)', opacity: stale ? 0.6 : 1 }}>
            {render.prose}
          </div>
        ) : loading ? (
          <div className="pt-6 text-center text-[12px]" style={{ color: 'var(--text-faint)' }}>
            読み込み中…
          </div>
        ) : (
          <div
            className="rounded-xl border border-dashed px-4 py-6 text-center text-[12px]"
            style={{ borderColor: 'var(--border-strong)', color: 'var(--text-faint)' }}
          >
            {presetId ? 'このシーンはまだ清書されていません' : 'スタイルプリセットがありません'}
            <div className="mt-1 text-[11px]">{node.beat}</div>
          </div>
        )}

      </>} secondary={<>
      {/* 左の列は上から 挿絵 / プリセット(人称と文体)/ POV / 分量 / 清書ボタン(2026-10-15 ユーザー指定)。
          挿絵は見るだけ(差し替えはシーンタブで)。シーンタブと同じく列の全幅・縦横比のまま */}
      <NodeThumb node={node} className="block h-auto w-full rounded-xl" />
      {/* 条件。プリセットと POV は鑑賞モードと共通、分量はこのシーンだけの指定 */}
      <RenderStyleControls style={style} variant="compact" showLength={false} />
      <div className="flex items-center gap-1.5">
        <LengthSelect
          value={nodeChars}
          onChange={saveNodeChars}
          zeroLabel={`分量: 共通に従う(${lengthLabel(style.targetChars)})`}
          className="min-w-0 flex-1"
          tip="このシーンだけの目安の字数。共通の設定より優先される(鑑賞モードの全編清書にも効く)"
        />
      </div>
      <div className="flex items-center gap-1.5">
        {running || task ? (
          <button
            onClick={() => task && cancelTask(task.id)}
            className="rounded-lg border px-2.5 py-1 text-[12px]"
            style={{ borderColor: 'rgba(239,68,68,0.5)', color: 'var(--danger)' }}
          >
            ■ {running ? `清書中… (${elapsed}s)` : '待機中… 取り消す'}
          </button>
        ) : (
          <button
            onClick={runRender}
            disabled={!presetId}
            className="rounded-lg px-2.5 py-1 text-[12px] font-medium text-white disabled:opacity-40"
            style={{ background: 'var(--accent)' }}
            data-tip={
              (render ? '同じ条件で書き直す(前の清書は履歴として残る)' : 'このシーンを散文にする') +
              '\n\n' +
              RENDER_INPUTS_HELP
            }
          >
            {render ? '⟳ 清書し直す' : '▶ このシーンを清書'}
          </button>
        )}
        {stale && (
          <span
            className="rounded px-1.5 py-px text-[10px] uppercase"
            style={{ background: 'rgba(239,68,68,0.12)', color: '#f2a3a3' }}
            data-tip="このシーンか上流が編集されたので、清書が古くなっています"
          >
            stale
          </span>
        )}
        {render && !liveText && (
          <span
            className="ml-auto text-[11px] tabular-nums"
            style={{ color: 'var(--text-faint)' }}
            data-tip={
              effectiveChars
                ? `目安は ${effectiveChars} 字(${nodeChars ? 'このシーンの指定' : '共通の設定'})`
                : undefined
            }
          >
            {render.prose.length} 字{effectiveChars ? ` / 目安 ${effectiveChars}` : ''}
          </span>
        )}
      </div>
      {!isCanon && (
        <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
          正史パス外のシーンです。直前シーンの文末に接続する処理は効きません(単独で書かれます)。
        </p>
      )}
      {error && (
        <p className="text-[11px] leading-relaxed" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}
      {/* 生成統計と、生成に送った内容(プロンプト)の確認。チャットの返事と同じ部品。
          列追加(2026-07-31)以前の清書には残っていないので、その場合は出さない */}
      {render && !liveText && (render.meta || render.prompt_messages) && (
        <div className="flex items-center gap-1.5">
          {render.meta && <StatsLine stats={render.meta} />}
          {render.prompt_messages && (
            <MsgActionButton
              kind="prompt"
              tip="この清書の生成に送った内容(システムプロンプトなど)を見る"
              onClick={() => setPromptView(render.prompt_messages!)}
            />
          )}
        </div>
      )}

      </>} />
      {promptView !== null && createPortal(<SystemPromptModal messages={promptView} onClose={() => setPromptView(null)} />, document.body)}
    </div>
  )
}
