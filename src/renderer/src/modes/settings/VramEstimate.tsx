import { useEffect, useState } from 'react'
import { api } from '../../api'

type Estimate = { ctx: number; weights: number; kv: number; compute: number; total: number }

const gb = (bytes: number): string => (bytes / 1024 ** 3).toFixed(1)

/** Context Length のスライダーの下に出す、VRAM の目安(モデルの GGUF のヘッダーから計算。backend/gguf_info.py)。
 *
 *  目盛りぶんの目安を 1 回で受け取り、スライダーを動かしたときはその場で切り替える(動かすたびに問い合わせない)。
 *  目安が GPU の搭載量を超えるなら警告。ComfyUI・TTS・Embedding も同じ GPU を使うので、
 *  搭載量の 9 割を超えるときも注意を出す */
export default function VramEstimate({
  ctxSize,
  presets,
  modelPath
}: {
  ctxSize: number
  presets: readonly number[]
  /** 空 = 次に起動するときのモデル(バックエンドが決める) */
  modelPath: string
}): React.JSX.Element | null {
  const [data, setData] = useState<{
    key: string
    estimates: Estimate[]
    vramTotal: number | null
    maxCtx: number
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  // 目盛りに無い値(手で書いた設定)も 1 件足して取る
  const sizes = presets.includes(ctxSize) ? presets : [...presets, ctxSize]
  const key = `${modelPath}|${sizes.join(',')}`
  useEffect(() => {
    let ignore = false
    setError(null)
    void api
      .vramEstimate(sizes, modelPath || undefined)
      .then((r) => {
        if (!ignore) setData({ key, estimates: r.estimates, vramTotal: r.vram_total, maxCtx: r.context_length })
      })
      .catch((e) => {
        if (!ignore) setError(String(e))
      })
    return () => {
      ignore = true
    }
    // sizes は key に畳んである
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  if (error) {
    return (
      <p className="settings-field-hint" style={{ color: 'var(--text-faint)' }} data-tip={error}>
        VRAM の目安: モデルのヘッダーを読めませんでした
      </p>
    )
  }
  // 別のモデルの目安を出したままにしない
  const estimate = data?.key === key ? data.estimates.find((e) => e.ctx === ctxSize) : undefined
  if (!data || !estimate) return null
  const total = data.vramTotal
  const over = total !== null && estimate.total > total
  const tight = total !== null && !over && estimate.total > total * 0.9
  const beyondModel = data.maxCtx > 0 && ctxSize > data.maxCtx
  return (
    <div className="mt-1.5 flex flex-col gap-0.5 text-[12px]" data-vram-estimate>
      <div className="flex flex-wrap items-baseline gap-x-2" style={{ color: 'var(--text-dim)' }}>
        <span>
          VRAM の目安 <span className="font-medium tabular-nums" style={{ color: 'var(--text)' }}>約 {gb(estimate.total)} GB</span>
        </span>
        <span
          className="tabular-nums text-[11px]"
          style={{ color: 'var(--text-faint)' }}
          data-tip={[
            '重み: モデルのうち GPU に載る部分(ファイルの大きさから、CPU に置かれる埋め込みを引いたもの)',
            'KV: 会話の記憶の領域。コンテキスト長に比例して増える(ウィンドウ層は一定)',
            '作業: 計算用の領域と CUDA の起動分'
          ].join('\n')}
        >
          重み {gb(estimate.weights)} + KV {gb(estimate.kv)} + 作業 {gb(estimate.compute)}
          {total !== null && ` / 搭載 ${gb(total)} GB`}
        </span>
      </div>
      {over && (
        <span style={{ color: 'var(--danger-text)' }}>⚠ GPU の搭載量を超えます。起動できないか、とても遅くなります。</span>
      )}
      {tight && (
        <span style={{ color: '#f59e0b' }}>
          ⚠ 搭載量の 9 割を超えます。ComfyUI・TTS・Embedding と同時に使うと足りない可能性があります。
        </span>
      )}
      {beyondModel && (
        <span style={{ color: '#f59e0b' }}>
          ⚠ このモデルが扱える最大({Math.round(data.maxCtx / 1024)}K)を超えています。
        </span>
      )}
    </div>
  )
}
