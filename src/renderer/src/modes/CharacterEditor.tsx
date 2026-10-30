import { useEffect, useRef, useState } from 'react'
import { api, assetUrl, uploadAsset } from '../api'
import CharacterVoicePanel from '../CharacterVoicePanel'
import ImageCropModal, { type CropState } from '../ImageCropModal'
import RefImagePanel from '../RefImagePanel'
import ProofreadTextarea from '../ProofreadTextarea'
import type { Character } from '../types'
import SceneUsage, { type SceneUsageProps } from '../SceneUsage'
import { EditActions, EditPencil, ReadText, editKeys as fieldEditKeys, focusEditGroup } from '../FieldEdit'
import { Icon } from '../icons'
import { askConfirm, showAlert } from '../ConfirmDialog'

/** キャラクターの編集(プロフィール・画像・声)。資料庫と、構造モードの詳細欄「資料」タブで共用する。
 *
 *  資料庫の `CharactersMode.tsx` に直書きされていたものを切り出した(2026-10-14。場所の `PlaceEditor` と同じ作法)。
 *  読む表示が既定で、鉛筆(または本文)を押した単位だけを編集欄にし、単位ごとに確定して保存する。
 *  人物を切り替えるときは親が `key` を変えて作り直す(下書き・編集状態を持ち越さない)。
 */

/** 新しいキャラの色。色の欄の「既定の色に戻す」もこの色にする */
export const DEFAULT_CHAR_COLOR = '#7c5af7'

const EDITABLE_FIELDS = ['name', 'color', 'profile', 'appearance', 'voice', 'reading'] as const

const FIELD_DEFS: Array<{ key: 'profile' | 'appearance' | 'voice'; label: string; short: string; rows: number }> = [
  { key: 'profile', label: 'プロフィール(性格の基調・背景)', short: 'プロフィール', rows: 5 },
  { key: 'appearance', label: '外見', short: '外見', rows: 3 },
  { key: 'voice', label: '口調・一人称', short: '口調・一人称', rows: 3 }
]

/** 編集の単位。名前・読み・色は「誰か」を決めるひとまとまりなので一緒に編集する。 */
type EditGroup = 'identity' | 'profile' | 'appearance' | 'voice'
const GROUP_FIELDS: Record<EditGroup, ReadonlyArray<(typeof EDITABLE_FIELDS)[number]>> = {
  identity: ['name', 'reading', 'color'],
  profile: ['profile'],
  appearance: ['appearance'],
  voice: ['voice']
}
const ALL_GROUPS: EditGroup[] = ['identity', 'profile', 'appearance', 'voice']

export default function CharacterEditor({
  character,
  usage,
  onChanged,
  onDirty,
  onDeleted,
  startEditing,
  onStartedEditing
}: {
  character: Character
  /** 出番の図(登場するシーン)。資料庫だけが渡す(詳細欄の人物専用の表示では出さない) */
  usage?: SceneUsageProps
  /** 保存・画像の変更のあとに呼ぶ(親が一覧を読み直す) */
  onChanged: () => Promise<void>
  /** 未保存の下書き・保存中・切り抜き中のどれかがあるか(親の未保存ガード用) */
  onDirty?: (dirty: boolean) => void
  /** 削除後に呼ぶ。渡さなければ削除ボタンを出さない(詳細欄では資料庫に限定する) */
  onDeleted?: () => void
  /** 作ったばかりの人物: 全部の項目を編集状態で開く */
  startEditing?: boolean
  onStartedEditing?: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState<Partial<Character>>(character)
  const [draftReset, setDraftReset] = useState(0)
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState<ReadonlySet<EditGroup>>(() => new Set(startEditing ? ALL_GROUPS : []))
  const [saveError, setSaveError] = useState<{ group: EditGroup; message: string } | null>(null)
  const [cropTarget, setCropTarget] = useState<{
    source: File | string
    isNewFile: boolean
    initial: CropState | null
    /** 保存済みアセットから切り抜くときの元画像パス(参照画像からの顔切り抜き用。省略時は今の元画像) */
    sourcePath?: string
  } | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  // プロフィール画像へのドラッグ&ドロップ。子要素をまたぐと dragleave が誤発火するので、
  // 深さを数えて 0 になったときだけハイライトを消す(シーンの挿絵と同じ作り)
  const [portraitDragOver, setPortraitDragOver] = useState(false)
  const portraitDragDepth = useRef(0)

  useEffect(() => {
    if (startEditing) onStartedEditing?.()
    // マウント時だけ(作ったばかりの人物を編集状態で開いたことを親に返す)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 選択・ドロップされた画像を切り抜きモーダルへ渡す(既に画像があれば差し替え)。
   *  アイコンなので画像のみ受け付ける(挿絵と違って動画は扱わない)。 */
  const acceptPortraitFile = (file: File | undefined): void => {
    if (!file) return
    if (!file.type.startsWith('image/')) return
    setCropTarget({ source: file, isNewFile: true, initial: null })
  }

  const openRecrop = (): void => {
    // 保存済みの元画像から切り抜き直す(前回の位置・ズームを復元)
    const sourcePath = draft.portrait_source_path
    const url = assetUrl(sourcePath)
    if (!url) return
    let initial: CropState | null = null
    try {
      initial = draft.portrait_crop ? (JSON.parse(draft.portrait_crop) as CropState) : null
    } catch {
      initial = null
    }
    setCropTarget({ source: url, isNewFile: false, initial })
  }

  /** 参照画像(全身の立ち絵)から顔を切り抜いてプロフィール画像にする。元画像は参照画像そのものを指す */
  const cropFromRefImage = (): void => {
    const sourcePath = character.ref_image_path
    const url = assetUrl(sourcePath)
    if (!sourcePath || !url) return
    setCropTarget({ source: url, isNewFile: false, initial: null, sourcePath })
  }

  const handleCropped = async (blob: Blob, state: CropState): Promise<void> => {
    const target = cropTarget
    if (!target) {
      setCropTarget(null)
      return
    }
    // 失敗時はモーダルを残す(切り抜き結果を黙って捨てない)
    try {
      const sourcePath = target.isNewFile
        ? (await uploadAsset(target.source as File)).path
        : target.sourcePath ?? draft.portrait_source_path
      const cropped = new File([blob], 'portrait.png', { type: 'image/png' })
      const { path } = await uploadAsset(cropped)
      const patch = {
        portrait_path: path,
        portrait_source_path: sourcePath,
        portrait_crop: JSON.stringify(state)
      }
      await api.updateCharacter(character.id, patch)
      setCropTarget(null)
      setDraft((d) => ({ ...d, ...patch }))
      await onChanged()
    } catch (e) {
      void showAlert(`画像の保存に失敗しました: ${String(e)}`)
    }
  }

  const groupDirty = (group: EditGroup): boolean =>
    GROUP_FIELDS[group].some((key) => (draft[key] ?? '') !== (character[key] ?? ''))

  const closeEdit = (group: EditGroup): void => {
    setEditing((current) => {
      const next = new Set(current)
      next.delete(group)
      return next
    })
    setSaveError((current) => (current?.group === group ? null : current))
  }

  const startEdit = (group: EditGroup): void => {
    if (saving || editing.has(group)) return
    // 下書きは選択時点のコピー。その後に制作チャットなどが保存した値を取りこぼさないよう、開く単位だけ読み直す
    const saved = Object.fromEntries(GROUP_FIELDS[group].map((key) => [key, character[key]]))
    setDraft((current) => ({ ...current, ...saved }))
    setEditing((current) => new Set(current).add(group))
    focusEditGroup(group)
  }

  const cancelEdit = (group: EditGroup): void => {
    if (saving) return
    const saved = Object.fromEntries(GROUP_FIELDS[group].map((key) => [key, character[key]]))
    setDraft((current) => ({ ...current, ...saved }))
    setDraftReset((value) => value + 1)
    closeEdit(group)
  }

  const commitEdit = async (group: EditGroup): Promise<void> => {
    if (saving) return
    if (group === 'identity' && !(draft.name ?? '').trim()) return
    // 変えた項目だけ送る。draft を丸ごと PATCH すると、選択後にその場で保存された項目(参照画像・
    // 関係図の座標など)を古い値で巻き戻す。未設定(null)の項目を '' に変えて送ると色の既定値
    // (char.color ?? …)が効かなくなるので、空にしたときは name 以外 null にする
    const patch = Object.fromEntries(
      GROUP_FIELDS[group].filter((k) => (draft[k] ?? '') !== (character[k] ?? ''))
        .map((k) => [k, k === 'name' ? (draft[k] ?? '') : (draft[k] || null)])
    )
    setSaving(true)
    try {
      if (Object.keys(patch).length > 0) {
        await api.updateCharacter(character.id, patch)
        await onChanged()
      }
      closeEdit(group)
    } catch (e) {
      setSaveError({ group, message: `保存できませんでした: ${String(e)}` })
    } finally {
      setSaving(false)
    }
  }

  const editKeys = (group: EditGroup): ((event: React.KeyboardEvent) => void) =>
    fieldEditKeys(editing.has(group), () => void commitEdit(group), () => cancelEdit(group))

  const editButton = (group: EditGroup, label: string): React.JSX.Element => (
    <EditPencil label={label} onClick={() => startEdit(group)} />
  )

  const editActions = (group: EditGroup): React.JSX.Element => (
    <EditActions
      dirty={groupDirty(group)}
      saving={saving}
      blocked={group === 'identity' && !(draft.name ?? '').trim() ? '名前を入力してください' : undefined}
      error={saveError?.group === group ? saveError.message : undefined}
      onCommit={() => void commitEdit(group)}
      onCancel={() => cancelEdit(group)}
    />
  )

  // 下書きが保存値と異なるか(シーンエディタと同じ判定方式)。画像は
  // 切り抜き確定時にその場で保存されるので、ここでは判定に含めない
  const dirty = EDITABLE_FIELDS.some((key) => (draft[key] ?? '') !== (character[key] ?? ''))

  useEffect(() => {
    onDirty?.(dirty || saving || cropTarget !== null)
  }, [dirty, saving, cropTarget, onDirty])
  useEffect(() => () => onDirty?.(false), [onDirty])

  // アイコンの頭文字と縁の色。名前・色を編集している間は下書きを映し、それ以外は保存値
  const shownName = editing.has('identity') ? draft.name : character.name
  const shownColor = editing.has('identity') ? draft.color : character.color

  const handleDelete = async (): Promise<void> => {
    if (!(await askConfirm(`「${character.name}」を削除しますか?`, '削除'))) return
    try {
      await api.deleteCharacter(character.id)
      onDeleted?.()
      await onChanged()
    } catch (e) {
      void showAlert(`削除に失敗しました: ${String(e)}`)
    }
  }

  return (
    <div className="character-editor mx-auto max-w-4xl">
      {cropTarget && (
        <ImageCropModal
          source={cropTarget.source}
          initial={cropTarget.initial}
          title="プロフィール画像の切り抜き"
          onCancel={() => setCropTarget(null)}
          onCropped={handleCropped}
        />
      )}
      {/* 読む表示が既定(SNS のプロフィールのように)。鉛筆か本文を押した項目だけ編集欄になり、項目ごとに確定して保存する。
          上段(固定): 左にアイコン・名前・読み、右に参照画像。下段: 文章の項目と声(スクロール)。配置は index.css の character-editor */}
      <div className="character-editor-scroll inspector-scrollbar">
      <div className="character-editor-head">
      <div className="character-editor-id">
      <div className="mb-4 flex items-start gap-4">
        <div className="flex shrink-0 flex-col items-center gap-1.5">
        {/* プロフィール画像(装飾専用。無くても成り立つ) */}
        <button
          onClick={() => {
            if (draft.portrait_source_path) openRecrop()
            else fileInputRef.current?.click()
          }}
          onDragEnter={(e) => {
            e.preventDefault()
            portraitDragDepth.current += 1
            setPortraitDragOver(true)
          }}
          onDragOver={(e) => e.preventDefault()}
          onDragLeave={() => {
            portraitDragDepth.current -= 1
            if (portraitDragDepth.current <= 0) {
              portraitDragDepth.current = 0
              setPortraitDragOver(false)
            }
          }}
          onDrop={(e) => {
            e.preventDefault()
            portraitDragDepth.current = 0
            setPortraitDragOver(false)
            acceptPortraitFile(e.dataTransfer.files?.[0])
          }}
          className="group relative h-36 w-36 shrink-0 overflow-hidden rounded-full border-2 transition-colors"
          style={{
            borderColor: shownColor ?? '#8a8fa8',
            background: 'var(--bg-input)',
            ...(portraitDragOver ? { outline: '2px dashed var(--accent)', outlineOffset: 2 } : {})
          }}
          data-tip={
            draft.portrait_source_path
              ? 'クリックで切り抜き直し / 画像をドロップで差し替え'
              : 'クリックで画像を設定 / 画像をドロップ'
          }
        >
          {assetUrl(draft.portrait_path) ? (
            <img src={assetUrl(draft.portrait_path)!} className="h-full w-full object-cover" />
          ) : (
            <span className="flex h-full w-full items-center justify-center text-[46px]" style={{ color: 'var(--text-faint)' }}>
              {(shownName || '?').slice(0, 1)}
            </span>
          )}
          <span
            className="absolute inset-0 hidden items-center justify-center bg-black/50 text-[11px] text-white group-hover:flex"
          >
            {draft.portrait_source_path ? '調整' : '設定'}
          </span>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            // 直接アップロードせず、切り抜きモーダルを挟む(元画像も保存される)
            acceptPortraitFile(file)
          }}
        />
        {/* 画像のすぐ下に画像操作(差し替え・外すは画像があるとき、参照画像からは参照画像があるとき) */}
        {(draft.portrait_path || character.ref_image_path) && (
          <div className="flex flex-wrap items-center gap-1.5">
            {draft.portrait_path && (
              <button
                onClick={() => fileInputRef.current?.click()}
                className="rounded-md border px-2 py-0.5 text-[11px]"
                style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
                data-tip="別の画像に差し替える"
              >
                画像を差し替え
              </button>
            )}
            {character.ref_image_path && (
              <button
                onClick={cropFromRefImage}
                className="rounded-md border px-2 py-0.5 text-[11px]"
                style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
                data-tip="参照画像から顔を切り抜いてプロフィール画像にします"
              >
                参照画像から
              </button>
            )}
            {draft.portrait_path && (
              <button
                onClick={() => {
                  const patch = { portrait_path: null, portrait_source_path: null, portrait_crop: null }
                  void api.updateCharacter(character.id, patch)
                    .then(async () => {
                      setDraft((d) => ({ ...d, ...patch }))
                      await onChanged()
                    })
                    .catch((e) => void showAlert(`画像を外せませんでした: ${String(e)}`))
                }}
                className="rounded-md border px-2 py-0.5 text-[11px]"
                style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
                data-tip="プロフィール画像を外す"
              >
                外す
              </button>
            )}
          </div>
        )}
        </div>
        <div className="min-w-0 flex-1 pt-1" data-edit-group="identity" onKeyDown={editKeys('identity')}>
          {editing.has('identity') ? (
            <>
              {/* 名前と色。色はキャラの識別に使うので名前の隣に項目として並べる */}
              <div className="flex w-full items-end gap-2">
                <label className="min-w-0 flex-1 block">
                  <span className="mb-1 block text-[12px]" style={{ color: 'var(--text-dim)' }}>
                    名前
                  </span>
                  {/* 色のスウォッチと高さを揃えるため、padding ではなく高さで指定する */}
                  <input
                    value={draft.name ?? ''}
                    onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing && !e.ctrlKey && !e.metaKey) void commitEdit('identity')
                    }}
                    className="block h-11 w-full rounded-lg border px-3 text-[18px] font-semibold outline-none"
                    style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
                  />
                </label>
                {/* 戻すボタンを label の中に置くと、押したときに色の選択も開くので div で包む */}
                <div className="shrink-0">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
                      色
                    </span>
                    <button
                      onClick={() => setDraft((d) => ({ ...d, color: DEFAULT_CHAR_COLOR }))}
                      disabled={(draft.color ?? '').toLowerCase() === DEFAULT_CHAR_COLOR}
                      aria-label="既定の色に戻す"
                      data-tip={`既定の色(${DEFAULT_CHAR_COLOR})に戻す`}
                      className="rounded-md p-0.5 hover:bg-[var(--accent-soft)] disabled:opacity-50 disabled:hover:bg-transparent"
                      style={{ color: 'var(--text-faint)' }}
                    >
                      <Icon name="rotateCcw" size={12} />
                    </button>
                  </div>
                  <input
                    type="color"
                    value={draft.color ?? DEFAULT_CHAR_COLOR}
                    onChange={(e) => setDraft((d) => ({ ...d, color: e.target.value }))}
                    className="color-swatch block h-11 w-12 cursor-pointer"
                    data-tip="シーンのカード・関係図・チャットで使われるキャラの色"
                  />
                </div>
              </div>
              <label className="mt-3 block">
                <span className="mb-1 block text-[12px]" style={{ color: 'var(--text-dim)' }}>
                  読み(ひらがな)
                </span>
                <input
                  value={draft.reading ?? ''}
                  onChange={(e) => setDraft((d) => ({ ...d, reading: e.target.value }))}
                  className="block w-full rounded-lg border px-3 py-1.5 text-[13px] outline-none"
                  style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
                  data-tip={[
                    '読み上げで、このキャラの名前をこの読みで読ませます(台本や本文の表示は漢字のまま)。',
                    '名前と読みを同じように空白で区切ると、姓だけ・名だけも正しく読みます(2 文字以上の部分だけ)。'
                  ].join('\n')}
                />
              </label>
              {editActions('identity')}
            </>
          ) : (
            <>
              <div className="flex items-start gap-1.5">
                <h2 data-character-name className="min-w-0 text-[22px] font-semibold leading-tight [overflow-wrap:anywhere]" style={{ color: 'var(--text)' }}>
                  {character.name || '(名前なし)'}
                </h2>
                {editButton('identity', '名前・読み・色')}
              </div>
              <p className="mt-1 text-[12px]" style={{ color: character.reading ? 'var(--text-dim)' : 'var(--text-faint)' }}>
                {character.reading || '読みは未設定'}
              </p>
            </>
          )}
        </div>
      </div>
      </div>
      <div className="character-editor-ref">
      {/* 参照画像(全身の立ち絵)。外見の記述から生成するか、手持ちの画像を置く。
          場面画像を作るときに編集モデルの入力として渡す(docs/design/image-gen.md) */}
      <RefImagePanel
        character={character}
        appearance={editing.has('appearance') ? (draft.appearance ?? '') : (character.appearance ?? '')}
        onChanged={async (patch) => {
          setDraft((d) => ({ ...d, ...patch }))
          await onChanged()
        }}
      />
      </div>
      </div>
      <div className="character-editor-body inspector-scrollbar">
      {FIELD_DEFS.map((f) => {
        const saved = character[f.key] ?? ''
        return (
          <section key={f.key} className="mb-5" data-edit-group={f.key} onKeyDown={editKeys(f.key)}>
            {!editing.has(f.key) && (
              <div className="mb-1 flex items-center gap-1.5">
                <span className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
                  {f.label}
                </span>
                {editButton(f.key, f.short)}
              </div>
            )}
            {editing.has(f.key) ? (
              <>
                {/* 高さの自動調整と校正ボタン(見出しの右端に常に出る)は共通コンポーネントに任せる */}
                <ProofreadTextarea
                  label={<span className="text-[12px]" style={{ color: 'var(--text-dim)' }}>{f.label}</span>}
                  key={`${character.id}:${f.key}:${draftReset}`}
                  rows={f.rows}
                  value={(draft[f.key] as string | null) ?? ''}
                  onChange={(next) => setDraft((d) => ({ ...d, [f.key]: next }))}
                  style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
                />
                {editActions(f.key)}
              </>
            ) : (
              <ReadText value={saved} emptyLabel={f.short} onEdit={() => startEdit(f.key)} />
            )}
          </section>
        )
      })}
      {usage && (
        <SceneUsage kind="character" entityId={character.id} name={character.name || '(名前なし)'} color={character.color} {...usage} />
      )}
      {/* 読み上げの声(docs/design/voice.md §5)。選んだその場で保存する */}
      <CharacterVoicePanel character={character} onChanged={onChanged} />
      {onDeleted && (
        <div className="mt-6 flex border-t pt-3" style={{ borderColor: 'var(--border)' }}>
          <button onClick={() => void handleDelete()} className="delete-action ml-auto text-[12px]">
            このキャラクターを削除
          </button>
        </div>
      )}
      </div>
      </div>
    </div>
  )
}
