import { useEffect, useState } from 'react'
import { api, voiceApi, type VoiceProfile, type VoiceProfileList } from './api'
import type { Character } from './types'
import VoiceProfileEditor from './VoiceProfileEditor'
import { askConfirm } from './ConfirmDialog'
import { Icon } from './icons'

/** 設定 →「読み上げの声」の声の一覧(docs/design/voice.md §5)。声を足して直し、選んだ声の編集欄の先頭で
 *  語り手・相談チャットへ割り当てる(作る → 割り当てるの順に上から並べる。2026-11-17 に一覧の上の選択欄から移した)。
 *  キャラクターへの割り当てはキャラクター画面で行い、ここでは誰が使っているかだけを見せる。 */
export default function VoiceProfilesCard(): React.JSX.Element {
  const [list, setList] = useState<VoiceProfileList | null>(null)
  const [characters, setCharacters] = useState<Character[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = async (): Promise<VoiceProfileList | null> => {
    try {
      const next = await voiceApi.list()
      setList(next)
      return next
    } catch (e) {
      setError(String(e))
      return null
    }
  }

  useEffect(() => {
    void reload().then((next) => {
      if (next) setSelectedId(next.narrator_profile_id ?? next.profiles[0]?.id ?? null)
    })
    api.listCharacters().then(setCharacters).catch(() => undefined)
  }, [])

  const usedBy = (id: string): string[] => {
    const users: string[] = []
    if (list?.narrator_profile_id === id) users.push('語り手')
    if (list?.chat_profile_id === id) users.push('相談チャット')
    for (const c of characters) if (list?.assignments[c.id] === id) users.push(c.name)
    return users
  }

  const assignSetting = async (key: 'tts_narrator_profile' | 'tts_chat_profile', id: string): Promise<void> => {
    setError(null)
    try {
      await api.putSettings({ [key]: id })
      await reload()
    } catch (e) {
      setError(String(e))
    }
  }

  const handleAdd = async (): Promise<void> => {
    setError(null)
    try {
      const created = await voiceApi.create({ name: `声 ${(list?.profiles.length ?? 0) + 1}` })
      await reload()
      setSelectedId(created.id)
    } catch (e) {
      setError(String(e))
    }
  }

  const handleDelete = async (profile: VoiceProfile): Promise<void> => {
    const names = usedBy(profile.id)
    const users = names.length ? `\n使っているもの(${names.join('、')})は語り手の声で読むようになります。` : ''
    if (!(await askConfirm(`声「${profile.name}」を削除しますか?${users}`, '削除'))) return
    setError(null)
    try {
      await voiceApi.remove(profile.id)
      if (selectedId === profile.id) setSelectedId(null)
      await reload()
    } catch (e) {
      setError(String(e))
    }
  }

  const replace = (profile: VoiceProfile): void =>
    setList((prev) => (prev ? { ...prev, profiles: prev.profiles.map((p) => (p.id === profile.id ? profile : p)) } : prev))

  const selected = list?.profiles.find((p) => p.id === selectedId) ?? null
  const nameOf = (id: string | null | undefined): string | null => list?.profiles.find((p) => p.id === id)?.name ?? null
  const selectedCharacters = selected ? characters.filter((c) => list?.assignments[c.id] === selected.id).map((c) => c.name) : []

  // 選んだ声を語り手 / 相談チャットに使うかどうかのトグル。オンにすると、いま別の声が受け持っていても入れ替える
  const roleToggle = (
    key: 'tts_narrator_profile' | 'tts_chat_profile',
    label: string,
    currentId: string | null | undefined,
    offTip: string
  ): React.JSX.Element | null => {
    if (!selected) return null
    const on = currentId === selected.id
    const other = on ? null : nameOf(currentId)
    return (
      <button
        onClick={() => void assignSetting(key, on ? '' : selected.id)}
        aria-pressed={on}
        className="rounded-md border px-2 py-0.5 text-[11px]"
        style={
          on
            ? { borderColor: 'var(--border-strong)', background: 'var(--accent-soft)', color: 'var(--text)' }
            : { borderColor: 'var(--border-strong)', color: 'var(--text-faint)' }
        }
        data-tip={
          on
            ? `オフにすると、${offTip}`
            : other
              ? `オンにすると、${label}の声を「${other}」からこの声に替えます`
              : `オンにすると、${label}をこの声で読みます`
        }
      >
        {on ? '☑' : '☐'} {label}
      </button>
    )
  }

  return (
    <div className="settings-card">
      <div className="settings-field">
        <div className="settings-field-header">
          <span className="settings-field-label">声の一覧</span>
          <div className="settings-field-controls">
            <button
              onClick={() => void handleAdd()}
              className="rounded-md border px-2 py-0.5 text-[11px]"
              style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
              data-tip="新しい声を作ります"
            >
              + 声を追加
            </button>
          </div>
        </div>
        {list && list.profiles.length === 0 && (
          <p className="text-[12px]" style={{ color: 'var(--text-faint)' }}>
            まだ声がありません。「+ 声を追加」で作るか、キャラクター画面の「この人の声を作る」から作れます。
          </p>
        )}
        <div className="flex flex-col gap-1">
          {list?.profiles.map((p) => {
            const users = usedBy(p.id)
            return (
              // 行の中に削除ボタンを置くので、行そのものは button にしない(選ぶのは左側の button)
              <div
                key={p.id}
                className="flex items-center gap-2 rounded-lg border py-1 pl-3 pr-1.5 text-[12px]"
                style={{
                  background: p.id === selectedId ? 'var(--accent-soft)' : 'var(--bg-elevated)',
                  borderColor: p.id === selectedId ? 'var(--accent-border)' : 'var(--border)'
                }}
              >
                <button
                  onClick={() => setSelectedId(p.id)}
                  aria-pressed={p.id === selectedId}
                  className="flex min-w-0 flex-1 items-center gap-2 py-0.5 text-left"
                >
                  <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--text)' }}>
                    {p.name}
                  </span>
                  <span className="shrink-0 truncate text-[11px]" style={{ color: 'var(--text-faint)', maxWidth: '50%' }}>
                    {users.length ? users.join('、') : '未使用'}
                  </span>
                  {p.ref_paths.length > 0 && (
                    <span className="shrink-0 rounded px-1 text-[10px]" style={{ background: 'var(--bg-input)', color: 'var(--text-faint)' }}>
                      参照 {p.ref_paths.length}
                    </span>
                  )}
                </button>
                <button
                  onClick={() => void handleDelete(p)}
                  className="delete-action inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border"
                  aria-label={`声「${p.name}」を削除`}
                  data-tip="この声を削除する(確認が出ます)"
                >
                  <Icon name="trash" size={13} />
                </button>
              </div>
            )
          })}
        </div>
        {list && list.profiles.length > 0 && !list.narrator_profile_id && (
          <p className="settings-field-hint">
            語り手の声がまだ決まっていません(エンジンの既定の声で読みます)。声を選んで、下の「語り手」をオンにしてください。
          </p>
        )}
      </div>

      {selected && (
        <div className="settings-field">
          <div>
            <span className="mb-1 block text-[12px]" style={{ color: 'var(--text-dim)' }}>
              この声を使う場所
            </span>
            <div className="flex flex-wrap items-center gap-2">
              {roleToggle('tts_narrator_profile', '語り手', list?.narrator_profile_id, '語り手はエンジンの既定の声で読みます')}
              {roleToggle('tts_chat_profile', '相談チャット', list?.chat_profile_id, '相談チャットは語り手の声で読みます')}
              {selectedCharacters.length > 0 && (
                <span className="min-w-0 truncate text-[11px]" style={{ color: 'var(--text-faint)' }} data-tip={selectedCharacters.join('、')}>
                  キャラクター: {selectedCharacters.join('、')}
                </span>
              )}
            </div>
            <p className="mt-1 text-[11px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
              語り手は、地の文と、声を割り当てていない人物の台詞を読みます。相談チャットは、返事を読む声です(どの声にも付けなければ語り手の声で読みます)。
              キャラクターの声はキャラクター画面の「読み上げの声」で選びます。
            </p>
          </div>
          <VoiceProfileEditor
            profile={selected}
            usedBy={usedBy(selected.id)}
            onChanged={replace}
          />
        </div>
      )}
      {error && (
        <p className="whitespace-pre-wrap text-[12px]" style={{ color: 'var(--danger-text)' }}>
          {error}
        </p>
      )}
    </div>
  )
}
