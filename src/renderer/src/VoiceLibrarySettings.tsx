import { useEffect, useState } from 'react'
import { api, type TtsStatus } from './api'
import ReadingDictCard from './ReadingDictCard'
import VoiceProfilesCard from './VoiceProfilesCard'
import VoiceRateSelect from './VoiceRateSelect'
import { fmtBytes } from './modes/settings/format'

// 設定 →「読み上げの声」。作品(ライブラリ)ごとに持つ読み上げの設定: 声の割り当てと声の一覧・読み辞書・
// 読み方・音声キャッシュ(docs/design/voice.md)。サーバーとエンジン(この PC の設定)は「音声読み上げ」
// (VoiceSettings.tsx)に置く
export default function VoiceLibrarySection({
  values,
  save
}: {
  values: Record<string, string>
  save: (patch: Record<string, string>) => Promise<void>
}): React.JSX.Element {
  const [status, setStatus] = useState<TtsStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = async (): Promise<void> => {
    try {
      setStatus(await api.ttsStatus())
    } catch {
      setStatus(null)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  const handleClearCache = async (): Promise<void> => {
    setError(null)
    try {
      await api.ttsClearCache()
    } catch (e) {
      setError(String(e))
    } finally {
      void refresh()
    }
  }

  const directionsOn = (values.tts_chat_directions ?? '1') !== '0'

  return (
    <>
      <p className="settings-field-hint">
        TTS サーバーの起動・エンジン・インストールは、環境設定の「音声読み上げ」にあります。
      </p>

      <VoiceProfilesCard />

      <ReadingDictCard value={values.tts_reading_dict} save={save} />

      <div className="settings-card">
        <div className="settings-field">
          <div className="settings-field-header">
            <span className="settings-field-label">読み上げの速さ</span>
            <div className="settings-field-controls">
              <VoiceRateSelect />
            </div>
          </div>
          <p className="settings-field-hint">
            鑑賞モードとチャットの読み上げの速さです。合成し直さず再生の速さだけを変えるので、すぐ効きます(声の高さはそのまま、行の間も同じ割合で縮みます)。
            鑑賞モードの読み上げ中の表示からも変えられます。声の試し読みは、声を確かめるため等速のままです。
          </p>
        </div>
        <div className="settings-field">
          <div className="settings-field-header">
            <span className="settings-field-label">チャットの（）のト書き</span>
            <div className="settings-field-controls">
              <button
                onClick={() => void save({ tts_chat_directions: directionsOn ? '0' : '1' })}
                className="rounded-md border px-2 py-0.5 text-[11px]"
                style={
                  directionsOn
                    ? { borderColor: 'var(--border-strong)', background: 'var(--accent-soft)', color: 'var(--text)' }
                    : { borderColor: 'var(--border-strong)', color: 'var(--text-faint)' }
                }
                data-tip={
                  directionsOn ? 'オフにすると（）のト書きは読まず、台詞だけを読みます' : 'オンにすると（）のト書きを語り手の声で読みます'
                }
              >
                {directionsOn ? '☑' : '☐'} 読む
              </button>
            </div>
          </div>
          <p className="settings-field-hint">
            キャラとの劇中会話・キャラ同士の会話で、「（小さく笑って）台詞」のような（）の部分を語り手の声で読むかどうか。
            オフにすると台詞だけが本人の声で流れます。インタビューのト書きはもとから読みません。
          </p>
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-field">
          <div className="settings-field-header">
            <span className="settings-field-label">音声キャッシュ</span>
            <div className="settings-field-controls">
              <span className="text-[12px] tabular-nums" style={{ color: 'var(--text-dim)' }}>
                {status ? `${status.cache.files} 件・${fmtBytes(status.cache.bytes)}` : '—'}
              </span>
              <button
                onClick={() => void handleClearCache()}
                disabled={!status || status.cache.files === 0}
                className="delete-action rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-40"
                data-tip="合成済みの音声を消します。次に読むときに合成し直します"
              >
                キャッシュを消す
              </button>
            </div>
          </div>
          {error && (
            <p className="whitespace-pre-wrap text-[12px]" style={{ color: 'var(--danger-text)' }}>
              {error}
            </p>
          )}
          <p className="settings-field-hint">
            読み上げた行の音声をライブラリの assets/audio/ に残し、同じ行・同じ声なら合成し直しません。
            清書の上書き・声や台本の変更・シーンの削除で使われなくなった音声は自動で消します(作り直した清書でも、変わらなかった文の音声は使い回します)。
            バックアップには含めません。
          </p>
        </div>
      </div>
    </>
  )
}
