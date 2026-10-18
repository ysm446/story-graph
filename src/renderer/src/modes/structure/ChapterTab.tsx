import DetailSplit from '../../DetailSplit'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../api'
import AutoTextarea from '../../AutoTextarea'
import { showStatusNotice } from '../../statusNotice'
import CharAvatar from '../../CharAvatar'
import { Icon } from '../../icons'
import type { RenderStyleState } from '../../RenderStyle'
import { enqueueTask, notifyGraphChanged, useTasks } from '../../tasks'
import type { Character, EventInput, Group, RenderResult, StoryNode } from '../../types'
import { chapterCoverNode, NodeThumb } from './StructureNodes'
import { useSaveShortcut } from './useSaveShortcut'

// ---- 章タブ(章ノードを選択したときのインスペクタ。docs/design/chapters.md §6) ----

export function ChapterTab({
  group,
  number,
  nodes,
  characters,
  renderStyle,
  onSelectScene,
  onChanged,
  onRename,
  onDissolve,
  onSetCover
}: {
  group: Group
  number: number
  nodes: StoryNode[]
  characters: Character[]
  /** シーンの清書を見るときのスタイルプリセット / POV(清書タブと共通) */
  renderStyle: RenderStyleState
  /** シーンを開く(章の中に入ってそのシーンを選ぶ) */
  onSelectScene: (nodeId: string) => void
  onChanged: () => void
  /** 章名をその場で変更して保存する(変更なし・空は呼ばれない) */
  onRename: (title: string) => void
  onDissolve: () => void
  /** 章カードの表紙にするシーン(null = 自動に戻す) */
  onSetCover: (nodeId: string | null) => void
}): React.JSX.Element {
  const [digest, setDigest] = useState<EventInput[]>([])
  const [hasDigest, setHasDigest] = useState(false)
  const [digestStale, setDigestStale] = useState(false)
  const [loading, setLoading] = useState(true)
  const [dirty, setDirty] = useState(false) // ローカル編集が未保存
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 章名のその場編集。null = 表示中、文字列 = 入力中の値
  const [renameText, setRenameText] = useState<string | null>(null)
  const finishRename = (): void => {
    if (renameText === null) return
    const title = renameText.trim()
    setRenameText(null)
    if (title && title !== group.title) onRename(title)
  }
  // まとめの生成は LLM キューに積む(他の生成と同じ 1 件ずつの逐次実行)。
  // ラベルだけで見ると別の章の生成待ちでもこの章のボタンが待機中になる
  const generateQueued = useTasks().some(
    (t) => t.kind === 'digest' && t.nodeId === group.id
  )

  const charOf = (charId: string): Character | undefined => characters.find((c) => c.id === charId)
  const nameOf = (charId: string): string => charOf(charId)?.name ?? charId
  const nodeTitle = (id: string): string => nodes.find((n) => n.id === id)?.title || '(無題)'
  // 章カードの表紙。指定が無ければ章内で最初に挿絵があるシーン(章カードと同じ導出)
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])
  const cover = chapterCoverNode(group, nodeById)
  // シーン一覧にサムネイルの列を出すか(挿絵のあるシーンが 1 つでもあれば)
  const hasAnyThumb = group.node_ids.some((id) => !!nodeById.get(id)?.image_path)

  // 右の列に何を出すか。null = 章のまとめ、文字列 = そのシーンの内容(読むだけ)。
  // シーン一覧は「何を見るか」を選ぶ場所で、シーンを開く(章の中に入る)のはダブルクリックか右の列のボタン
  const [shownId, setShownId] = useState<string | null>(null)
  const shownNode = shownId && group.node_ids.includes(shownId) ? nodeById.get(shownId) : undefined
  // シーンの内容を清書で見るか本文で見るか。シーンを移っても選んだほうを保つ
  const [sceneText, setSceneText] = useState<'render' | 'beat'>('render')
  const listRef = useRef<HTMLDivElement | null>(null)
  // ↑↓ キーで一覧(先頭がまとめ)を移る。フォーカスも移して、押し続けて下っていけるようにする
  const moveShown = (step: number): void => {
    const order: Array<string | null> = [null, ...group.node_ids]
    const at = order.indexOf(shownNode ? shownNode.id : null)
    const next = order[Math.max(0, Math.min(order.length - 1, at + step))]
    setShownId(next)
    listRef.current?.querySelector<HTMLButtonElement>(`[data-shown-key="${next ?? ''}"]`)?.focus()
  }
  // 見るものを切り替えたら右の列を先頭から読めるようにする
  const mainScrollRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (mainScrollRef.current) mainScrollRef.current.scrollTop = 0
  }, [shownNode?.id])

  const refetch = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const d = await api.getGroupDigest(group.id)
      setDigest(d.digest_events ?? [])
      setHasDigest(d.digest_events !== null)
      setDigestStale(d.digest_stale === 1)
      setDirty(false)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [group.id])

  // 生成タスクの完了は notifyGraphChanged → reload → groups の変化で伝わるので、
  // has_digest / digest_stale が動いたときも取り直す
  useEffect(() => {
    void refetch()
  }, [refetch, group.has_digest, group.digest_stale])

  const generate = (): void => {
    enqueueTask({
      label: '章のまとめ',
      detail: group.title,
      kind: 'digest',
      nodeId: group.id, // 章 ID を目印にする(useTasks の絞り込み用)
      runner: async () => {
        // キュー(tasks.ts)は runner の例外を握りつぶすので、ここで知らせる。
        // 章タブはタスク完了前に閉じられていることがあるため、setError ではなく全体の通知に出す
        try {
          await api.generateGroupDigest(group.id)
          notifyGraphChanged()
        } catch (e) {
          showStatusNotice(`章のまとめを作れませんでした(${group.title}): ${String(e)}`)
        }
      }
    })
  }

  const save = async (): Promise<boolean> => {
    setBusy(true)
    setError(null)
    try {
      await api.putGroupDigest(group.id, digest)
      await refetch()
      onChanged()
      return true
    } catch (e) {
      setError(String(e))
      return false
    } finally {
      setBusy(false)
    }
  }
  const saveButtonRef = useRef<HTMLButtonElement | null>(null)
  useSaveShortcut(saveButtonRef, save, '章のまとめを保存しました')

  const removeDigest = async (): Promise<void> => {
    if (!window.confirm('まとめを削除しますか?(次の章からは生の記憶に戻ります)')) return
    setBusy(true)
    setError(null)
    try {
      await api.deleteGroupDigest(group.id)
      await refetch()
      onChanged()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const updateEntry = (index: number, patch: Record<string, unknown>): void => {
    setDigest((prev) => prev.map((e, i) => (i === index ? { ...e, payload: { ...e.payload, ...patch } } : e)))
    setDirty(true)
  }

  return (
    <div className="scene-detail flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b px-5 py-2" style={{ borderColor: 'var(--border)' }}>

      <div className="flex items-center gap-2">
        <span className="shrink-0 text-[10px] uppercase tracking-[0.2em]" style={{ color: 'var(--text-faint)' }}>
          {group.on_canon ? `第${number}章` : '別ルートの章'}
        </span>
        {renameText !== null ? (
          // その場編集。Enter / 欄を離れると保存、Escape で取り消し(会話履歴の名前変更と同じ型)
          <input
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            value={renameText}
            onChange={(e) => setRenameText(e.target.value)}
            onBlur={finishRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault()
                finishRename()
              }
              if (e.key === 'Escape') setRenameText(null)
            }}
            aria-label="章の名前"
            className="min-w-0 flex-1 rounded-md border px-1.5 py-1 text-[14px] font-semibold outline-none"
            style={{ background: 'var(--bg-input)', borderColor: 'var(--accent-border)', color: 'var(--text)' }}
          />
        ) : (
          <>
            {/* 鉛筆は章名のすぐ右に寄せる(flex-1 は付けない)。ダブルクリックでも編集に入る */}
            <span
              className="min-w-0 truncate text-[14px] font-semibold"
              style={{ color: 'var(--text)' }}
              onDoubleClick={() => setRenameText(group.title)}
              data-tip="ダブルクリックで名前を変更"
            >
              {group.title}
            </span>
            <button
              onClick={() => setRenameText(group.title)}
              aria-label="章の名前を変更"
              data-tip="章の名前をその場で変更"
              className="shrink-0 rounded p-0.5 hover:bg-[var(--accent-soft)]"
              style={{ color: 'var(--text-faint)' }}
            >
              ✎
            </button>
          </>
        )}
        <button
          onClick={onDissolve}
          data-tip="章を解除する(シーンは残る)"
          className="ml-auto shrink-0 rounded p-0.5 text-[11px] hover:bg-[var(--accent-soft)]"
          style={{ color: 'var(--text-faint)' }}
        >
          解除
        </button>
      </div>
      {group.warning && (
        <p className="text-[11px] leading-relaxed" style={{ color: '#f2a3a3' }}>
          ⚠ {group.warning}
        </p>
      )}
      </div>
      <DetailSplit storageKey="chapterDetailListWidth" defaultWidth={34} mainScrollRef={mainScrollRef} main={shownNode ? (
        <ChapterScenePreview
          node={shownNode}
          routeIndex={group.route.indexOf(shownNode.id)}
          renderStyle={renderStyle}
          textKind={sceneText}
          onTextKind={setSceneText}
          onOpen={() => onSelectScene(shownNode.id)}
        />
      ) : <>
      <div>
        <div className="mb-1 flex items-center gap-2">
          <span className="text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-faint)' }}>
            章のまとめ
          </span>
          {hasDigest &&
            (digestStale ? (
              <span
                className="rounded px-1.5 py-px text-[10px]"
                style={{ background: 'rgba(239,68,68,0.12)', color: '#f2a3a3' }}
                data-tip="章の中が編集されたので、まとめが古くなっている可能性があります"
              >
                要更新
              </span>
            ) : (
              <span
                className="rounded px-1.5 py-px text-[10px]"
                style={{ background: 'var(--accent-soft)', color: 'var(--text-dim)' }}
              >
                最新
              </span>
            ))}
        </div>
        <p className="mb-2 text-[11px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
          章を閉じたときのキャラごとの要約記憶。次の章からは、この章の生の記憶の代わりに
          このまとめが引き継がれます(生の記憶は清書時の検索などで引き続き参照されます)。
          まとめを更新しない限り、章の中の記憶の編集は次の章へ波及しません。
        </p>
        <div className="mb-2 flex gap-1.5">
          <button
            onClick={generate}
            disabled={generateQueued}
            className="rounded-lg px-2.5 py-1 text-[12px] font-medium text-white disabled:opacity-50"
            style={{ background: 'var(--accent)' }}
            data-tip="LLM で章のまとめを作る(既存のまとめは置き換え)"
          >
            {generateQueued ? '生成待ち…' : hasDigest ? '⟳ まとめを作り直す' : '▶ まとめを作る'}
          </button>
          {hasDigest && (
            <button
              onClick={() => void removeDigest()}
              disabled={busy}
              className="delete-action rounded-lg border px-2 py-1 text-[12px] disabled:opacity-50"
            >
              削除
            </button>
          )}
        </div>
        {error && (
          <p className="mb-2 text-[11px]" style={{ color: 'var(--danger)' }}>
            {error}
          </p>
        )}
        {loading ? (
          <p className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
            読み込み中…
          </p>
        ) : digest.length === 0 ? (
          <p className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
            まだまとめはありません
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {digest.map((e, i) =>
              e.type === 'memory_compress' ? (
                <div
                  key={e.id ?? i}
                  className="rounded-xl border p-2"
                  style={{ borderColor: 'var(--border)', background: 'var(--bg-card)' }}
                >
                  <div className="mb-1 flex items-center gap-2 text-[11px]" style={{ color: 'var(--text-dim)' }}>
                    {/* まとめはキャラごとの要約記憶なので、誰のものかをアイコンでも示す */}
                    {charOf(String(e.payload.char ?? '')) && (
                      <CharAvatar char={charOf(String(e.payload.char ?? ''))!} size={28} />
                    )}
                    <span className="font-medium" style={{ color: 'var(--text)' }}>
                      {nameOf(String(e.payload.char ?? ''))}
                    </span>
                    <span className="ml-auto" style={{ color: 'var(--text-faint)' }}>
                      重要度
                    </span>
                    <input
                      type="number"
                      min={0}
                      max={1}
                      step={0.1}
                      value={Number(e.payload.importance ?? 0.6)}
                      onChange={(ev) => updateEntry(i, { importance: Number(ev.target.value) })}
                      className="w-16 rounded-md border px-1.5 py-0.5 text-[11px]"
                      style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
                    />
                  </div>
                  <AutoTextarea
                    value={String(e.payload.summary ?? '')}
                    onChange={(v) => updateEntry(i, { summary: v })}
                    className="w-full rounded-md border px-2 py-1 text-[12px] leading-relaxed outline-none"
                    style={{ background: 'var(--bg-input)', borderColor: 'var(--border)', color: 'var(--text)' }}
                  />
                </div>
              ) : (
                <div
                  key={e.id ?? i}
                  className="rounded-xl border p-2 text-[11px]"
                  style={{ borderColor: 'var(--border)', color: 'var(--text-dim)' }}
                >
                  {e.type}: {JSON.stringify(e.payload)}
                </div>
              )
            )}

          </div>
        )}
      </div>      </>} aside={<>
      {/* 表紙(章カードのサムネイル)。挿絵はシーンのもので、章はどれを使うかだけを持つ */}
      {cover ? (
        <div>
          <div className="mb-1 flex items-center gap-2">
            <span className="text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-faint)' }}>
              表紙
            </span>
            <span className="min-w-0 flex-1 truncate text-[11px]" style={{ color: 'var(--text-faint)' }}>
              {group.cover_node_id ? nodeTitle(cover.id) : `自動(${nodeTitle(cover.id)})`}
            </span>
            {group.cover_node_id && (
              <button
                onClick={() => onSetCover(null)}
                data-tip="表紙の指定を外して、章内で最初に挿絵があるシーンに戻す"
                className="shrink-0 rounded px-1 text-[11px] hover:bg-[var(--accent-soft)]"
                style={{ color: 'var(--text-faint)' }}
              >
                自動に戻す
              </button>
            )}
          </div>
          <NodeThumb node={cover} className="h-auto w-full rounded-xl" />
        </div>
      ) : (
        <div>
          <span className="mb-1 block text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-faint)' }}>
            表紙
          </span>
          <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
            まだ表紙がありません。章の中のシーンに挿絵を付けると、最初の1枚が表紙になります。
          </p>
        </div>
      )}
      </>} secondary={<>
      <div>
        <span className="mb-1 block text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-faint)' }}>
          シーン({group.node_ids.length})
          {group.node_ids.length > group.route.length && (
            <span className="ml-1.5 normal-case tracking-normal">
              うち読む道 {group.route.length}
            </span>
          )}
        </span>
        <div
          ref={listRef}
          className="flex flex-col"
          onKeyDown={(e) => {
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
            e.preventDefault()
            moveShown(e.key === 'ArrowDown' ? 1 : -1)
          }}
        >
          {/* 先頭は章のまとめ。シーンと同じ行の形にして、右の列に出すものを選ぶ一覧にする */}
          <button
            data-view-ok
            data-shown-key=""
            onClick={() => setShownId(null)}
            aria-current={!shownNode}
            className="flex items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] hover:bg-[var(--accent-soft)]"
            style={!shownNode ? { background: 'var(--accent-soft)', color: 'var(--text)' } : { color: 'var(--text-dim)' }}
            data-tip="章のまとめを右に表示"
          >
            {/* シーンの行のサムネイルの列と、タイトルの位置を揃える */}
            {hasAnyThumb && <span className="block w-16 shrink-0" />}
            <span className="min-w-0 flex-1 truncate">章のまとめ</span>
            {dirty ? (
              <span className="shrink-0 text-[10px]" style={{ color: 'var(--text-dim)' }}>
                未保存
              </span>
            ) : (
              hasDigest &&
              digestStale && (
                <span className="shrink-0 text-[10px]" style={{ color: '#f2a3a3' }}>
                  要更新
                </span>
              )
            )}
          </button>
          {group.node_ids.map((id, i) => (
            <div
              key={id}
              className="group/scene flex items-center rounded-md hover:bg-[var(--accent-soft)]"
              style={shownNode?.id === id ? { background: 'var(--accent-soft)' } : undefined}
            >
              <button
                data-view-ok
                data-shown-key={id}
                onClick={() => setShownId(id)}
                onDoubleClick={() => onSelectScene(id)}
                aria-current={shownNode?.id === id}
                className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1 text-left text-[12px]"
                style={{ color: shownNode?.id === id ? 'var(--text)' : 'var(--text-dim)' }}
                data-tip="右にこのシーンの内容を表示(ダブルクリックでシーンを開く)"
              >
                {/* 挿絵のサムネイル(Memories と同じ大きさで中央を切り抜く)。番号付きの一覧なので、
                    挿絵の無いシーンも同じ大きさの空の枠を置いてタイトルの位置を揃える。
                    挿絵が 1 枚も無い章は空の枠が並ぶだけなので、列ごと出さない */}
                {hasAnyThumb && (
                  <span
                    className="block h-10 w-16 shrink-0 overflow-hidden rounded-md"
                    style={{ background: 'var(--bg-canvas)' }}
                  >
                    {nodeById.get(id) && <NodeThumb node={nodeById.get(id)!} className="block h-full w-full object-cover" />}
                  </span>
                )}
                {/* ルート(読む道)のシーンだけ番号を振る。分岐・島は番号なし */}
                <span className="min-w-0 flex-1 truncate">
                  {i < group.route.length ? `${i + 1}. ` : '⌁ '}
                  {nodeTitle(id)}
                </span>
              </button>
              {i >= group.route.length && (
                <span
                  className="shrink-0 px-1 text-[10px]"
                  style={{ color: 'var(--text-faint)' }}
                  data-tip="この章のシーンですが、読む道(鑑賞モード・まとめ)には乗っていません"
                >
                  別の道
                </span>
              )}
              {/* 挿絵のあるシーンだけ、表紙にできる */}
              {nodeById.get(id)?.image_path && (
                <button
                  onClick={() => onSetCover(group.cover_node_id === id ? null : id)}
                  aria-label="章の表紙にする"
                  data-tip={
                    group.cover_node_id === id
                      ? '表紙の指定を外す(自動に戻す)'
                      : 'このシーンの挿絵を章の表紙にする'
                  }
                  className={`shrink-0 rounded px-1.5 py-1 ${
                    group.cover_node_id === id ? '' : 'opacity-0 group-hover/scene:opacity-100'
                  }`}
                  style={
                    group.cover_node_id === id
                      ? { background: 'var(--accent-soft)', color: 'var(--accent)' }
                      : { color: 'var(--text-faint)' }
                  }
                >
                  <Icon name="image" size={12} />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
      </>} />
      <div className="flex shrink-0 items-center justify-end gap-2 border-t px-5 py-2" style={{ borderColor: 'var(--border)' }}>
        {dirty && <span className="mr-auto text-[11px]" style={{ color: 'var(--text-dim)' }}>未保存の変更があります</span>}
        <button ref={saveButtonRef} onClick={() => void save()} disabled={busy || !dirty}
          className="rounded-md px-3 py-1 text-[12px] font-medium disabled:opacity-50"
          style={{ background: 'var(--accent)', color: 'var(--text)' }}
          data-tip={dirty ? '章のまとめの変更を保存します(Ctrl+S)' : '変更はありません'}>まとめを保存</button>
      </div>
    </div>
  )
}

/** 章タブの右の列に出す、選んだシーンの内容(読むだけ)。清書か本文かを切り替えて見る。
 *  書き直しはシーンを開いてから(清書タブ・本文タブ)行う */
function ChapterScenePreview({
  node,
  routeIndex,
  renderStyle,
  textKind,
  onTextKind,
  onOpen
}: {
  node: StoryNode
  /** 読む道の何番目か(-1 = 別の道) */
  routeIndex: number
  renderStyle: RenderStyleState
  textKind: 'render' | 'beat'
  onTextKind: (kind: 'render' | 'beat') => void
  onOpen: () => void
}): React.JSX.Element {
  const { presetId, povChar } = renderStyle
  const [render, setRender] = useState<RenderResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setError(null)
    if (!presetId) {
      setRender(null)
      setLoading(false)
      return
    }
    let ignore = false
    setLoading(true)
    void api
      .getRender(node.id, presetId, povChar)
      .then((r) => {
        if (!ignore) setRender(r.render)
      })
      .catch((e) => {
        if (ignore) return
        setRender(null)
        setError(String(e))
      })
      .finally(() => {
        if (!ignore) setLoading(false)
      })
    return () => {
      ignore = true
    }
    // updated_at はシーン編集後に stale 表示を取り直すために見る(清書タブと同じ)
  }, [node.id, node.updated_at, presetId, povChar])

  // 清書を選んでいても、まだ無いシーンは本文を出す(空の列にしない)
  const showRender = textKind === 'render' && render !== null
  const stale = showRender && render.stale === 1

  return (
    <>
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-[10px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-faint)' }}>
          {routeIndex >= 0 ? `シーン ${routeIndex + 1}` : '別の道'}
        </span>
        <span className="min-w-0 flex-1 truncate text-[14px] font-semibold" style={{ color: 'var(--text)' }}>
          {node.title || '(無題)'}
        </span>
        <button
          data-view-ok
          onClick={onOpen}
          className="shrink-0 rounded-md border px-2 py-0.5 text-[11px]"
          style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
          data-tip="章の中に入って、このシーンを選ぶ(編集はシーンのタブで)"
        >
          シーンを開く →
        </button>
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <div className="flex shrink-0 overflow-hidden rounded-md border" style={{ borderColor: 'var(--border-strong)' }}>
          {(
            [
              ['render', '清書', 'いまのスタイルプリセット / 視点で書いた清書を表示'],
              ['beat', '本文', 'シーン本文(清書の材料)を表示']
            ] as const
          ).map(([value, label, tip]) => (
            <button
              key={value}
              data-view-ok
              onClick={() => onTextKind(value)}
              className="px-2.5 py-0.5 text-[12px]"
              style={textKind === value ? { background: 'var(--accent-soft)', color: 'var(--text)' } : { color: 'var(--text-faint)' }}
              data-tip={tip}
            >
              {label}
            </button>
          ))}
        </div>
        {stale && (
          <span
            className="shrink-0 rounded px-1.5 py-px text-[10px]"
            style={{ background: 'rgba(239,68,68,0.12)', color: '#f2a3a3' }}
            data-tip="清書のあとにシーンが編集されたので、清書が古くなっている可能性があります"
          >
            要更新
          </span>
        )}
        {textKind === 'render' && !loading && !error && render === null && (
          <span className="min-w-0 truncate text-[11px]" style={{ color: 'var(--text-faint)' }}>
            {presetId
              ? 'このスタイルの清書はまだありません(本文を表示しています)'
              : 'スタイルプリセットが未選択です(本文を表示しています)'}
          </span>
        )}
      </div>
      {error && (
        <p className="text-[11px]" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}
      {textKind === 'render' && loading ? (
        <p className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
          読み込み中…
        </p>
      ) : showRender ? (
        <div
          className="whitespace-pre-wrap text-[13px] leading-relaxed"
          style={{ color: 'var(--text)', opacity: stale ? 0.6 : 1 }}
        >
          {render.prose}
        </div>
      ) : node.beat.trim() ? (
        <div className="whitespace-pre-wrap text-[13px] leading-relaxed" style={{ color: 'var(--text)' }}>
          {node.beat}
        </div>
      ) : (
        <p className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
          本文はまだありません
        </p>
      )}
    </>
  )
}
