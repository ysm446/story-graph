import { api } from './api'
import ServiceBar from './ServiceBar'

// ServiceBar の useEffect が参照の変化で張り直さないよう、モジュールの外に置く
const fetchStatus = (): ReturnType<typeof api.comfyStatus> => api.comfyStatus()
const start = (): Promise<unknown> => api.comfyStart()
const stop = (): Promise<unknown> => api.comfyStop()

/** ヘッダー右の ComfyUI(画像生成)の状態バー */
export default function ComfyBar(): React.JSX.Element {
  return (
    <ServiceBar
      name="ComfyUI"
      icon="image"
      fetchStatus={fetchStatus}
      start={start}
      stop={stop}
      startTip="画像生成時は自動でも起動します"
      notInstalledTip="ComfyUI が未導入です。設定 →「画像生成」からインストールしてください"
    />
  )
}
