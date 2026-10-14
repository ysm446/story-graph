import { useRef, useState } from 'react'
import { api } from '../../api'

// プロンプトの書き出し / 読み込み。シーン生成・校正・スタイルプリセット
// (散文用システムプロンプト)を 1 ファイルにまとめて扱う。
// プロンプトはライブラリごとの設定なので、別のストーリーへ持ち込むのに使う
const PROMPT_FILE_KIND = 'story-graph-prompts'

export default function PromptIoSection({
  values,
  save
}: {
  values: Record<string, string>
  save: (patch: Record<string, string>) => Promise<void>
}): React.JSX.Element {
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const importRef = useRef<HTMLInputElement | null>(null)

  const handleExport = async (): Promise<void> => {
    setBusy(true)
    try {
      const custom = (await api.listPresets()).filter((p) => !p.builtin)
      const payload = {
        kind: PROMPT_FILE_KIND,
        version: 1,
        exported_at: new Date().toISOString(),
        generation_system_prompt: values.generation_system_prompt ?? '',
        proofread_custom_prompt: values.proofread_custom_prompt ?? '',
        presets: custom.map((p) => ({ name: p.name, person: p.person, tone: p.tone }))
      }
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: 'application/json;charset=utf-8'
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'story-graph-prompts.json'
      a.click()
      URL.revokeObjectURL(url)
      setStatus(`書き出しました(スタイルプリセット ${custom.length} 件 + シーン生成 / 校正)`)
    } catch (e) {
      setStatus(`書き出しに失敗しました: ${String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const handleImport = async (file: File): Promise<void> => {
    setBusy(true)
    try {
      const data = JSON.parse(await file.text())
      // 旧形式(style-presets.json: 配列 or {presets})も読める
      const list = Array.isArray(data) ? data : data?.presets
      const presets: Array<Record<string, unknown>> = Array.isArray(list) ? list : []
      const patch: Record<string, string> = {}
      for (const key of ['generation_system_prompt', 'proofread_custom_prompt'] as const) {
        if (typeof data?.[key] === 'string') patch[key] = data[key]
      }
      if (presets.length === 0 && Object.keys(patch).length === 0) {
        throw new Error('プロンプトが見つかりません')
      }
      const parts = [
        presets.length > 0 ? `スタイルプリセット ${presets.length} 件を追加` : null,
        patch.generation_system_prompt !== undefined ? 'シーン生成プロンプトを置き換え' : null,
        patch.proofread_custom_prompt !== undefined ? '校正プロンプトを置き換え' : null
      ].filter(Boolean)
      if (!window.confirm(`次の内容を読み込みます。\n\n・${parts.join('\n・')}\n\nよろしいですか?`)) {
        return
      }
      let imported = 0
      for (const item of presets) {
        const name = String(item?.name ?? '').trim()
        if (!name) continue
        // id は付けない(常に新規プリセットとして取り込み、既存・組み込みを壊さない)
        await api.upsertPreset({
          name,
          person: item?.person === 'first' ? 'first' : 'third',
          tone: String(item?.tone ?? '')
        })
        imported += 1
      }
      if (Object.keys(patch).length > 0) await save(patch)
      setStatus(`読み込みました(プリセット ${imported} 件${Object.keys(patch).length > 0 ? ' + プロンプト' : ''})`)
    } catch (e) {
      setStatus(`読み込みに失敗しました: ${String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-field">
      <div className="settings-field-header">
        <span className="settings-field-label">プロンプトをまとめて書き出す / 読み込む</span>
        <div className="settings-field-controls">
          <button
            onClick={() => void handleExport()}
            disabled={busy}
            className="rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-50"
            style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
          >
            ⬆ 書き出し
          </button>
          <button
            onClick={() => importRef.current?.click()}
            disabled={busy}
            className="rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-50"
            style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
          >
            ⬇ 読み込み
          </button>
          <input
            ref={importRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) void handleImport(file)
            }}
          />
        </div>
      </div>
      <p className="settings-field-hint">
        シーン生成プロンプト・校正プロンプト・カスタムのスタイルプリセット(清書の文体指示)を
        1 つの JSON にまとめます。プロンプトはライブラリごとの設定なので、別のストーリーに
        持ち込むときに使います。読み込むとスタイルプリセットは<b>新規として追加</b>され
        (既存・組み込みは変わりません)、シーン生成・校正のプロンプトは<b>置き換え</b>られます。
        以前の `style-presets.json` もそのまま読み込めます。
      </p>
      {status && (
        <p className="settings-field-hint" style={{ color: 'var(--text-dim)' }}>
          {status}
        </p>
      )}
    </div>
  )
}
