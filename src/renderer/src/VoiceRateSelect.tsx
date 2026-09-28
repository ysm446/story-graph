import { setVoiceRate, useVoiceRate, VOICE_RATES } from './voiceRate'

/** 読み上げの再生速度の選択(鑑賞モードの読み上げ表示と、設定の「音声読み上げ」)。
 *  変えるとその場で鳴っている行にも効き、設定 tts_playback_rate に保存する */
export default function VoiceRateSelect({ className = '' }: { className?: string }): React.JSX.Element {
  const rate = useVoiceRate()
  const options = VOICE_RATES.includes(rate as (typeof VOICE_RATES)[number]) ? [...VOICE_RATES] : [...VOICE_RATES, rate]
  return (
    <select
      value={String(rate)}
      onChange={(e) => setVoiceRate(Number(e.target.value))}
      className={`rounded-md border px-1 py-0.5 text-[11px] tabular-nums outline-none ${className}`}
      style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }}
      aria-label="読み上げの速さ"
      data-tip="読み上げの速さ(合成し直さず、再生の速さだけを変えます。声の高さはそのまま)"
    >
      {options.map((r) => (
        <option key={r} value={String(r)}>
          {r === 1 ? '等速' : `${r}×`}
        </option>
      ))}
    </select>
  )
}
