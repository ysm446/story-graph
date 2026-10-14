import { useEffect, useState } from 'react'
import { api } from '../../api'

// 設定では変えられず、システムプロンプトに必ず付く部分。編集欄の内容と食い違う指示を
// 書いても残るので、読み取り専用で見せる(組み込みの校正プリセットと同じ見た目)
export function FixedPrompt({ label, text, hint, collapsed = false }: {
  label: string
  text: string | undefined
  hint: string
  collapsed?: boolean
}): React.JSX.Element {
  if (!text) return <></>
  const body = (
    <p
      className="whitespace-pre-wrap rounded-lg border px-3 py-2 text-[12px] leading-relaxed"
      style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)', color: 'var(--text-faint)' }}
    >
      {text}
    </p>
  )
  return (
    <div className="settings-field">
      <div className="settings-field-header">
        <span className="settings-field-label">{label}</span>
      </div>
      {collapsed ? (
        <details>
          <summary className="cursor-pointer text-[12px]" style={{ color: 'var(--text-dim)' }}>全文を表示</summary>
          <div className="mt-2">{body}</div>
        </details>
      ) : body}
      <p className="settings-field-hint">{hint}</p>
    </div>
  )
}

// 組み込みの校正プリセット(軽く / 標準 / 積極的)の中身。どれを選ぶかは
// プロンプトの文面を見ないと判断できないので、読み取り専用で表示する
export function BuiltinProofreadPrompts(): React.JSX.Element {
  const [presets, setPresets] = useState<Array<{ id: string; name: string; prompt: string }>>([])
  useEffect(() => {
    let ignore = false
    void api
      .listProofreadPresets()
      .then((list) => {
        // カスタムは下の編集欄そのものなので、ここには出さない
        if (!ignore) setPresets(list.filter((p) => p.id !== 'custom'))
      })
      .catch(() => undefined)
    return () => {
      ignore = true
    }
  }, [])
  if (presets.length === 0) return <></>
  return (
    <div className="settings-field">
      <div className="settings-field-header">
        <span className="settings-field-label">組み込みプリセット</span>
      </div>
      <div className="flex flex-col gap-2">
        {presets.map((p) => (
          <div
            key={p.id}
            className="rounded-lg border px-3 py-2"
            style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)' }}
          >
            <div className="mb-1 text-[12px] font-medium" style={{ color: 'var(--text-dim)' }}>
              {p.name}
            </div>
            <p className="whitespace-pre-wrap text-[12px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
              {p.prompt}
            </p>
          </div>
        ))}
      </div>
      <p className="settings-field-hint">
        組み込みは編集できません。文面を変えたいときは下のカスタム校正プロンプトを使ってください。
      </p>
    </div>
  )
}
