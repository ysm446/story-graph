import DetailSplit from '../../DetailSplit'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../api'
import AutoTextarea from '../../AutoTextarea'
import { showStatusNotice } from '../../statusNotice'
import CharAvatar from '../../CharAvatar'
import { EditActions, editKeys, EditPencil, focusEditGroup } from '../../FieldEdit'
import { Icon } from '../../icons'
import type { RenderStyleState } from '../../RenderStyle'
import { enqueueTask, notifyGraphChanged, useTasks } from '../../tasks'
import type { Character, EventInput, Group, RenderResult, StoryNode } from '../../types'
import { chapterCast, chapterCoverNode, NodeThumb } from './StructureNodes'

// ---- 章タブ(章ノードを選択したときのインスペクタ。docs/design/chapters.md §6) ----

/** 見出し「章のまとめ」の ⓘ のツールチップ(2026-10-19 までは見出しの下に常に出していた説明) */
const DIGEST_HELP = [
  '章を閉じたときの人物ごとの要約記憶。',
  '次の章からは、この章の生の記憶の代わりにこのまとめが引き継がれます(生の記憶は清書時の検索などで引き続き参照されます)。',
  'まとめを更新しない限り、章の中の記憶の編集は次の章へ波及しません。'
].join('\n')

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

  // まとめのカードは読む表示が既定で、鉛筆(または本文)を押したカードだけを編集欄にし、
  // カードごとに確定(すぐ保存)・取り消しする(資料庫の読む表示と同じ型。2026-10-19 ユーザー決定)。
  // 編集は 1 枚ずつ。key は保存済みイベントの id(無ければ並び順)で、まとめを取り直しても同じカードを指す
  const [editing, setEditing] = useState<{ key: string; summary: string; importance: number } | null>(null)
  const [editSaving, setEditSaving] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  const entryKey = (e: EventInput, i: number): string => e.id ?? `#${i}`
  const editIndex = editing ? digest.findIndex((e, i) => entryKey(e, i) === editing.key) : -1
  const editOriginal = editIndex >= 0 ? digest[editIndex] : undefined
  const editDirty =
    !!editing &&
    !!editOriginal &&
    (editing.summary !== String(editOriginal.payload.summary ?? '') ||
      editing.importance !== Number(editOriginal.payload.importance ?? 0.6))
  // 作り直し・削除で編集中のカードが無くなったら閉じる
  useEffect(() => {
    if (editing && !loading && !editOriginal) setEditing(null)
  }, [editing, loading, editOriginal])
  const editBlocked = !editing
    ? undefined
    : !editing.summary.trim()
      ? 'まとめの本文が空です'
      : !(editing.importance >= 0 && editing.importance <= 1)
        ? '重要度は 0〜1 で入れてください'
        : undefined
  const startEdit = (e: EventInput, i: number): void => {
    const key = entryKey(e, i)
    if (editing?.key === key) return
    if (editDirty && !window.confirm('編集中のまとめの変更を捨てて、別のカードを編集しますか?')) return
    setEditing({ key, summary: String(e.payload.summary ?? ''), importance: Number(e.payload.importance ?? 0.6) })
    setEditError(null)
    focusEditGroup(`digest-${key}`)
  }
  const cancelEdit = (): void => {
    setEditing(null)
    setEditError(null)
  }
  const commitEdit = async (): Promise<void> => {
    if (!editing || editSaving || editBlocked || editIndex < 0) return
    if (!editDirty) {
      cancelEdit()
      return
    }
    setEditSaving(true)
    setEditError(null)
    try {
      const next = digest.map((e, i) =>
        i === editIndex ? { ...e, payload: { ...e.payload, summary: editing.summary, importance: editing.importance } } : e
      )
      await api.putGroupDigest(group.id, next)
      setEditing(null)
      await refetch()
      onChanged()
    } catch (e) {
      setEditError(String(e))
    } finally {
      setEditSaving(false)
    }
  }

  // まとめは人物ごとに 1 枚のカードにまとめて見せる(見せ方だけ。保存・編集の単位は項目のまま。
  // 2026-10-19 ユーザー決定)。人物の順は章カードと同じ(読む道で出番の多い順、同数は初登場順)、
  // 章の登場人物に入っていない人物はその後ろに保存順で。1 人の中の項目は保存順
  const digestCards = useMemo(() => {
    const charMap = Object.fromEntries(characters.map((c) => [c.id, c]))
    const castOrder = chapterCast(group, nodeById, charMap).map((m) => m.char.id)
    const byChar = new Map<string, Array<{ e: EventInput; i: number }>>()
    digest.forEach((e, i) => {
      if (e.type !== 'memory_compress') return
      const charId = String(e.payload.char ?? '')
      byChar.set(charId, [...(byChar.get(charId) ?? []), { e, i }])
    })
    const rank = (charId: string): number => {
      const at = castOrder.indexOf(charId)
      return at >= 0 ? at : castOrder.length
    }
    // Map は挿入順(保存順で最初に出た順)を保つので、安定ソートで登場人物外の人物は保存順になる
    return [...byChar.entries()]
      .sort((a, b) => rank(a[0]) - rank(b[0]))
      .map(([charId, entries]) => ({ charId, entries }))
  }, [digest, characters, group, nodeById])

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
        <p className="text-[11px] leading-relaxed" style={{ color: 'var(--danger-text)' }}>
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
        {/* 見出しの行: 「章のまとめ ⓘ 状態 …… 削除 作る」。説明は ⓘ のツールチップへ(常設の説明文は面積を取るので)、
            LLM を走らせるボタンは見出しの行の右端(2026-10-19 ユーザー指摘) */}
        <div className="mb-2 flex items-center gap-2">
          <span className="text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-faint)' }}>
            章のまとめ
          </span>
          <span
            role="img"
            aria-label={DIGEST_HELP}
            data-tip={DIGEST_HELP}
            className="inline-flex shrink-0"
            style={{ color: 'var(--text-faint)' }}
          >
            <Icon name="info" size={12} />
          </span>
          {hasDigest &&
            (digestStale ? (
              <span
                className="rounded px-1.5 py-px text-[10px]"
                style={{ background: 'rgba(239,68,68,0.12)', color: 'var(--danger-text)' }}
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
          {/* 主な操作(作る)を右端に、削除はその手前 */}
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {hasDigest && (
              <button
                onClick={() => void removeDigest()}
                disabled={busy}
                className="delete-action rounded-lg border px-2 py-1 text-[12px] disabled:opacity-50"
                data-tip="まとめを削除する(次の章からは生の記憶に戻ります)"
              >
                削除
              </button>
            )}
            <button
              onClick={generate}
              disabled={generateQueued}
              className="rounded-md px-3 py-1 text-[12px] font-medium text-white disabled:opacity-50"
              style={{ background: 'var(--accent)' }}
              data-tip="LLM で章のまとめを作る(既存のまとめは置き換え)"
            >
              {generateQueued ? '生成待ち…' : hasDigest ? '⟳ まとめを作り直す' : '▶ まとめを作る'}
            </button>
          </span>
        </div>
        {error && (
          <p className="mb-2 text-[11px]" style={{ color: 'var(--danger-text)' }}>
            {error}
          </p>
        )}
        {loading ? (
          <p className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
            読み込み中…
          </p>
        ) : digest.length === 0 ? (
          // 説明が要るのは作る前なので、まとめが無いときだけ本文にも短く出す(詳しくは見出しの ⓘ)
          <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
            まだまとめはありません。まとめは章を閉じたときの人物ごとの要約記憶で、次の章へはこの章の生の記憶の代わりにこれが引き継がれます。
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {digestCards.map(({ charId, entries }) => {
              const char = charOf(charId)
              return (
                // 人物ごとに 1 枚。シーンの Events の記憶カードと同じ見た目(左にだれのアイコン、1 行目に名前、本文は下に幅いっぱい)
                <div
                  key={charId}
                  data-digest-card
                  className="flex gap-2.5 rounded-lg border px-3 py-2 text-[12px]"
                  style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)' }}
                >
                  {/* まとめはキャラごとの要約記憶なので、誰のものかをアイコンでも示す */}
                  {char && <CharAvatar char={char} size={28} />}
                  <div className="min-w-0 flex-1">
                    <div className="mb-0.5 flex items-center gap-2">
                      <span className="min-w-0 truncate font-medium" style={{ color: 'var(--text)' }}>
                        {nameOf(charId)}
                      </span>
                      {entries.length > 1 && (
                        <span className="shrink-0 text-[11px] tabular-nums" style={{ color: 'var(--text-faint)' }}>
                          {entries.length} 件
                        </span>
                      )}
                    </div>
                    {entries.map(({ e, i }, n) => {
                      const key = entryKey(e, i)
                      const open = editing?.key === key
                      return (
                        // 同じ人物の項目は薄い線で区切る。保存・編集の単位はこの項目
                        <div
                          key={key}
                          data-digest-entry
                          className={n > 0 ? 'mt-1.5 border-t pt-1.5' : ''}
                          style={n > 0 ? { borderColor: 'var(--border)' } : undefined}
                        >
                          {open && editing ? (
                            <div
                              data-edit-group={`digest-${key}`}
                              onKeyDown={editKeys(true, () => void commitEdit(), cancelEdit)}
                            >
                              <AutoTextarea
                                value={editing.summary}
                                onChange={(v) => setEditing({ ...editing, summary: v })}
                                className="w-full rounded-md border px-2 py-1 text-[12px] leading-relaxed outline-none"
                                style={{ background: 'var(--bg-input)', borderColor: 'var(--border)', color: 'var(--text)' }}
                              />
                              <label className="mt-1.5 flex items-center gap-2 text-[11px]" style={{ color: 'var(--text-faint)' }}>
                                重要度
                                <input
                                  type="number"
                                  min={0}
                                  max={1}
                                  step={0.1}
                                  value={editing.importance}
                                  onChange={(ev) => setEditing({ ...editing, importance: Number(ev.target.value) })}
                                  className="w-16 rounded-md border px-1.5 py-0.5 text-[11px] outline-none"
                                  style={{ background: 'var(--bg-input)', borderColor: 'var(--border)', color: 'var(--text)' }}
                                  data-tip="0 些細 〜 1 人生を変える"
                                />
                              </label>
                              <EditActions
                                dirty={editDirty}
                                saving={editSaving}
                                blocked={editBlocked}
                                error={editError ?? undefined}
                                onCommit={() => void commitEdit()}
                                onCancel={cancelEdit}
                              />
                            </div>
                          ) : (
                            // 編集に入るのは鉛筆だけ。本文のクリックでは入らない(2026-10-19 ユーザー指摘。読むつもりで押して編集になると、鉛筆の意味が無い)
                            <div className="flex items-start gap-2">
                              <div className="min-w-0 flex-1 leading-relaxed" style={{ color: 'var(--text-dim)' }}>
                                「{String(e.payload.summary ?? '')}」
                                <span className="whitespace-nowrap text-[11px]" style={{ color: 'var(--text-faint)' }}>
                                  重要度 {Number(e.payload.importance ?? 0.6).toFixed(2)}
                                </span>
                              </div>
                              <EditPencil label="このまとめ" onClick={() => startEdit(e, i)} />
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}
            {/* memory_compress 以外(fact_set など)は中身をそのまま出すだけ(編集しない) */}
            {digest.map((e, i) =>
              e.type === 'memory_compress' ? null : (
                <div
                  key={entryKey(e, i)}
                  className="rounded-lg border px-3 py-2 text-[11px]"
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
            {editDirty ? (
              <span className="shrink-0 text-[10px]" style={{ color: 'var(--text-dim)' }} data-tip="編集中のまとめのカードに、確定していない変更があります">
                未保存
              </span>
            ) : (
              hasDigest &&
              digestStale && (
                <span className="shrink-0 text-[10px]" style={{ color: 'var(--danger-text)' }}>
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
            style={{ background: 'rgba(239,68,68,0.12)', color: 'var(--danger-text)' }}
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
        <p className="text-[11px]" style={{ color: 'var(--danger-text)' }}>
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
