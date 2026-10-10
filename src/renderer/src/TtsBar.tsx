import { useCallback, useState } from 'react'
import { api } from './api'
import ServiceBar from './ServiceBar'

const start = (): Promise<unknown> => api.ttsStart()
const stop = (): Promise<unknown> => api.ttsStop()

/** ヘッダー右の TTS(清書の読み上げ)の状態バー。表示名は TTS で固定。
 *  使用中のエンジン名はツールチップに表示する */
export default function TtsBar(): React.JSX.Element {
  const [engineName, setEngineName] = useState('')
  const fetchStatus = useCallback(async () => {
    const s = await api.ttsStatus()
    setEngineName(s.engine.label)
    return s
  }, [])
  return (
    <ServiceBar
      name="TTS"
      tooltipName={engineName ? `TTS（${engineName}）` : 'TTS'}
      icon="speaker"
      fetchStatus={fetchStatus}
      start={start}
      stop={stop}
      startTip="読み上げ時は自動でも起動します。初回はモデルの取得で数分かかります"
      notInstalledTip={`${engineName || 'TTS エンジン'} が未導入です。設定 →「音声読み上げ」からインストールしてください`}
    />
  )
}
