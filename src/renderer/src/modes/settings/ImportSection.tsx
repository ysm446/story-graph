import { useRef, useState } from 'react'
import { api, type ImportCheck, type ImportSummary } from '../../api'

/** 取り込み: 外部の LLM が書いた JSON を検査して、一括で登録する(docs/design/import-json.md)。
 *  ファイルを選ぶと検査だけを行い、内容を確かめてから「取り込む」で書き込む。 */
export default function ImportSection({ onImported }: { onImported?: (message: string) => void }): React.JSX.Element {
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const [data, setData] = useState<unknown>(null)
  const [check, setCheck] = useState<(ImportCheck & { blocked: string[] }) | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const choose = async (file: File): Promise<void> => {
    setBusy(true)
    setFileName(file.name)
    setData(null)
    setCheck(null)
    setProblem(null)
    setDone(null)
    setCopied(false)
    try {
      let parsed: unknown
      try {
        parsed = JSON.parse((await file.text()).replace(/^\uFEFF/, ''))
      } catch (e) {
        setProblem(`JSON として読めません: ${String(e)}`)
        return
      }
      setCheck(await api.importValidate(parsed))
      setData(parsed)
    } catch (e) {
      setProblem(`検査できませんでした: ${String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const run = async (): Promise<void> => {
    if (data === null || busy) return
    setBusy(true)
    setProblem(null)
    try {
      const result = await api.importApply(data)
      const message = `取り込みました(${importCounts(result)})`
      setDone(message)
      setData(null)
      setCheck(null)
      onImported?.(message)
    } catch (e) {
      setProblem(`取り込めませんでした: ${String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  // 誤りの一覧は、外部の LLM にそのまま貼り返して直してもらえる形でコピーする
  const errors = check ? [...check.errors, ...check.blocked] : []
  const copyErrors = async (): Promise<void> => {
    if (!check) return
    try {
      // 画面に出している一覧(errors + blocked)と同じものを写す
      await navigator.clipboard.writeText(
        ['取り込み JSON の検査で、次の誤りがありました。直してください。', ...errors.map((e) => `- ${e}`)].join('\n')
      )
      setCopied(true)
    } catch (e) {
      setProblem(`コピーできませんでした: ${String(e)}`)
    }
  }

  return (
    <div className="settings-field">
      <div className="settings-field-header">
        <span className="settings-field-label">取り込み JSON</span>
        <div className="settings-field-controls">
          <button
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            className="rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-50"
            style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
            data-tip="取り込む JSON ファイルを選びます。選んだ時点では検査だけを行い、何も書き込みません"
          >
            ファイルを選ぶ
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            aria-label="取り込み JSON のファイル"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = '' // 同じファイルを直して選び直せるようにする
              if (file) void choose(file)
            }}
          />
        </div>
      </div>
      <p className="settings-field-hint">
        外部の LLM(Claude Code など)に書いてもらった作品のデータを、このライブラリへ一括で登録します。
        書き方は docs/reference/import-format.md にあります。取り込めるのは、シーンが 1 つも無いライブラリだけです。
      </p>
      {fileName && (
        <p className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
          {busy && !check ? `${fileName} を検査しています…` : fileName}
        </p>
      )}
      {problem && (
        <p role="alert" className="text-[12px] [overflow-wrap:anywhere]" style={{ color: 'var(--danger-text)' }}>
          {problem}
        </p>
      )}
      {check && (
        <div className="flex flex-col gap-2" data-import-result={errors.length ? 'errors' : 'ok'}>
          <p className="text-[12px]" style={{ color: 'var(--text)' }}>
            {check.summary.title ? `「${check.summary.title}」 ` : ''}
            {importCounts(check.summary)}
          </p>
          {errors.length > 0 && (
            <>
              <div className="flex items-center gap-2">
                <span className="text-[12px]" style={{ color: 'var(--danger-text)' }}>
                  誤りが {errors.length} 件あります。直してから、もう一度ファイルを選んでください。
                </span>
                {check.errors.length > 0 && (
                  <button
                    onClick={() => void copyErrors()}
                    className="shrink-0 rounded-md border px-2 py-0.5 text-[11px]"
                    style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
                    data-tip="誤りの一覧をコピーします。JSON を書いた LLM に貼って、直してもらえます"
                  >
                    {copied ? 'コピーしました' : '誤りをコピー'}
                  </button>
                )}
              </div>
              <ul
                className="inspector-scrollbar max-h-64 list-disc overflow-y-auto rounded-lg border py-2 pl-7 pr-3 text-[12px] leading-relaxed"
                style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)', color: 'var(--text-dim)' }}
              >
                {errors.map((message, i) => (
                  <li key={i} className="[overflow-wrap:anywhere]">
                    {message}
                  </li>
                ))}
              </ul>
            </>
          )}
          {check.warnings.length > 0 && (
            <details className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
              <summary className="cursor-pointer">注意 {check.warnings.length} 件(取り込みはできます)</summary>
              <ul className="mt-1 list-disc pl-5 leading-relaxed">
                {check.warnings.map((message, i) => (
                  <li key={i} className="[overflow-wrap:anywhere]">
                    {message}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {errors.length === 0 && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => void run()}
                disabled={busy}
                className="rounded-md px-3 py-1 text-[12px] font-medium text-white disabled:opacity-50"
                style={{ background: 'var(--accent)' }}
                data-tip="この内容を、いま開いているライブラリへ登録します。登録の前に、スナップショットを自動で保存します"
              >
                {busy ? '取り込んでいます…' : '取り込む'}
              </button>
              <span className="text-[12px]" style={{ color: 'var(--text-faint)' }}>
                問題ありません。取り込めます。
              </span>
            </div>
          )}
        </div>
      )}
      {done && (
        <p role="status" className="text-[12px]" style={{ color: 'var(--text)' }}>
          {done}
        </p>
      )}
    </div>
  )
}

function importCounts(summary: ImportSummary): string {
  return `キャラクター ${summary.characters} / 場所 ${summary.places} / 設定資料 ${summary.documents} / 章 ${summary.chapters} / シーン ${summary.scenes} / イベント ${summary.events}`
}
