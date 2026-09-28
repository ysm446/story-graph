import { useEffect, useState } from 'react'
import { api, voiceApi, type VoiceProfile, type VoiceProfileList } from './api'
import type { Character } from './types'
import VoiceProfileEditor from './VoiceProfileEditor'

/** 設定 →「音声読み上げ」の声の一覧(docs/design/voice.md §5)。語り手の声を選び、声を足して直す。
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
    for (const c of characters) if (list?.assignments[c.id] === id) users.push(c.name)
    return users
  }

  const handleNarrator = async (id: string): Promise<void> => {
    setError(null)
    try {
      await api.putSettings({ tts_narrator_profile: id })
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

  const replace = (profile: VoiceProfile): void =>
    setList((prev) => (prev ? { ...prev, profiles: prev.profiles.map((p) => (p.id === profile.id ? profile : p)) } : prev))

  const selected = list?.profiles.find((p) => p.id === selectedId) ?? null

  return (
    <div className="settings-card">
      <div className="settings-field">
        <div className="settings-field-header">
          <span className="settings-field-label">語り手の声</span>
        </div>
        <select
          value={list?.narrator_profile_id ?? ''}
          onChange={(e) => void handleNarrator(e.target.value)}
          className="w-full rounded-lg border px-3 py-2 text-[13px] outline-none"
          style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
        >
          <option value="">(未設定: エンジンの既定の声)</option>
          {list?.profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <p className="settings-field-hint">
          地の文と、声を割り当てていない人物の台詞を読む声です。キャラクターの声はキャラクター画面の「読み上げの声」で選びます。
        </p>
      </div>

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
              <button
                key={p.id}
                onClick={() => setSelectedId(p.id)}
                className="flex items-center gap-2 rounded-lg border px-3 py-1.5 text-left text-[12px]"
                style={{
                  background: p.id === selectedId ? 'var(--accent-soft)' : 'var(--bg-elevated)',
                  borderColor: p.id === selectedId ? 'var(--accent-border)' : 'var(--border)'
                }}
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
            )
          })}
        </div>
      </div>

      {selected && (
        <div className="settings-field">
          <VoiceProfileEditor
            profile={selected}
            usedBy={usedBy(selected.id)}
            onChanged={replace}
            onDeleted={() => {
              setSelectedId(null)
              void reload()
            }}
          />
        </div>
      )}
      {error && (
        <p className="whitespace-pre-wrap text-[12px]" style={{ color: '#f2a3a3' }}>
          {error}
        </p>
      )}
    </div>
  )
}
