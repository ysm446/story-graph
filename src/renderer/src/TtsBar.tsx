import { useCallback, useState } from 'react'
import { api } from './api'
import ServiceBar from './ServiceBar'

const start = (): Promise<unknown> => api.ttsStart()
const stop = (): Promise<unknown> => api.ttsStop()

/** ヘッダー右の TTS(清書の読み上げ)の状態バー。表示名はエンジン定義の label
 *  (tts_engines/<id>.json)なので、エンジンを差し替えるとバーの名前も変わる */
export default function TtsBar(): React.JSX.Element {
  const [name, setName] = useState('TTS')
  const fetchStatus = useCallback(async () => {
    const s = await api.ttsStatus()
    setName(s.engine.label)
    return s
  }, [])
  return (
    <ServiceBar
      name={name}
      icon="speaker"
      fetchStatus={fetchStatus}
      start={start}
      stop={stop}
      startTip="読み上げ時は自動でも起動します。初回はモデルの取得で数分かかります"
      notInstalledTip="TTS エンジンが未導入です。設定 →「音声読み上げ」からインストールしてください"
    />
  )
}
