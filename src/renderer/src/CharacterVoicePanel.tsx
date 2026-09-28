import { useEffect, useState } from 'react'
import { api, isAbortError, voiceApi, type VoiceProfileList } from './api'
import { Icon } from './icons'
import { enqueueTask } from './tasks'
import type { Character } from './types'
import VoiceProfileEditor from './VoiceProfileEditor'

const secondaryStyle = { borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }

/** キャラクター画面の「読み上げの声」(docs/design/voice.md §5)。声を選ぶか、この人の声を作る。
 *  割り当ては選んだその場で保存する(参照画像と同じく、下の「保存」ボタンを待たない)。
 *  割り当てた声はここでそのまま直せる(同じ声を使う人全員に効く)。 */
export default function CharacterVoicePanel({
  character,
  onChanged
}: {
  character: Character
  onChanged: () => Promise<void> | void
}): React.JSX.Element {
  const [list, setList] = useState<VoiceProfileList | null>(null)
  const [characters, setCharacters] = useState<Character[]>([])
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  const reload = async (): Promise<void> => {
    try {
      setList(await voiceApi.list())
    } catch (e) {
      setError(String(e))
    }
  }

  useEffect(() => {
    void reload()
    api.listCharacters().then(setCharacters).catch(() => undefined)
  }, [character.id])

  const assignedId = character.voice_profile_id ?? null
  const assigned = list?.profiles.find((p) => p.id === assignedId) ?? null

  const assign = async (profileId: string | null): Promise<void> => {
    setError(null)
    try {
      await api.updateCharacter(character.id, { voice_profile_id: profileId })
      await onChanged()
      await reload()
    } catch (e) {
      setError(String(e))
    }
  }

  // 声を作って割り当て、資料から声の説明の下書きを LLM で作る(LLM はタスクキューに積む)
  const handleCreate = async (): Promise<void> => {
    setError(null)
    try {
      const created = await voiceApi.create({ name: character.name })
      await assign(created.id)
      setOpen(true)
      const charId = character.id
      enqueueTask({
        label: '声の説明',
        detail: character.name,
        kind: 'voice-caption',
        nodeId: created.id,
        runner: async ({ signal }) => {
          try {
            const { caption } = await voiceApi.draftCaption(charId, signal)
            await voiceApi.update(created.id, { caption })
            await reload()
          } catch (e) {
            if (!isAbortError(e)) setError(`声の説明の下書きに失敗しました: ${String(e).replace(/^Error:\s*/, '')}`)
          }
        }
      })
    } catch (e) {
      setError(String(e))
    }
  }

  const usedBy = (id: string): string[] => {
    const users: string[] = []
    if (list?.narrator_profile_id === id) users.push('語り手')
    for (const c of characters) if (list?.assignments[c.id] === id) users.push(c.name)
    return users
  }

  return (
    <div className="mb-4">
      <span className="mb-1 block text-[12px]" style={{ color: 'var(--text-dim)' }}>
        読み上げの声
      </span>
      <div className="flex items-center gap-2">
        <select
          value={assignedId ?? ''}
          onChange={(e) => void assign(e.target.value || null)}
          className="min-w-0 flex-1 rounded-lg border px-3 py-1.5 text-[13px] outline-none"
          style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
        >
          <option value="">(語り手の声で読む)</option>
          {list?.profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {assigned && (
          <button
            onClick={() => setOpen((v) => !v)}
            className="shrink-0 rounded-md border px-2 py-0.5 text-[11px]"
            style={open ? { ...secondaryStyle, background: 'var(--accent-soft)', color: 'var(--text)' } : secondaryStyle}
            data-tip="この声の説明・参照音声・seed を直します"
          >
            {open ? '閉じる' : '声を直す'}
          </button>
        )}
        <button
          onClick={() => void handleCreate()}
          className="accent-action inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium"
          data-tip="このキャラ用の声を作って割り当て、プロフィール・外見・口調から声の説明の下書きを LLM で作ります"
        >
          <Icon name="sparkle" size={11} />
          この人の声を作る
        </button>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
        台本でこの人の台詞になった行を、この声で読みます。声の一覧は設定の「音声読み上げ」にもあります。
      </p>
      {assigned && open && (
        <div className="mt-2 rounded-lg border p-3" style={{ borderColor: 'var(--border)', background: 'var(--bg-elevated)' }}>
          <VoiceProfileEditor
            // 「この人の声を作る」の下書きは後から届くので、説明が変わったら欄を読み直す
            key={`${assigned.id}:${assigned.caption ?? ''}`}
            profile={assigned}
            usedBy={usedBy(assigned.id)}
            draftFromCharId={character.id}
            sampleText={`「はじめまして。${character.name}です。今日はよろしくお願いします」`}
            onChanged={(p) =>
              setList((prev) => (prev ? { ...prev, profiles: prev.profiles.map((x) => (x.id === p.id ? p : x)) } : prev))
            }
          />
        </div>
      )}
      {error && (
        <p className="mt-1 whitespace-pre-wrap text-[12px]" style={{ color: '#f2a3a3' }}>
          {error}
        </p>
      )}
    </div>
  )
}
