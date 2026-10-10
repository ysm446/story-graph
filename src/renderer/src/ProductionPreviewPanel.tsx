import { useEffect, useRef } from 'react'
import { useProductionPreview } from './productionPreview'

export default function ProductionPreviewPanel(): React.JSX.Element | null {
  const preview = useProductionPreview()
  const body = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (body.current) body.current.scrollTop = body.current.scrollHeight
  }, [preview])
  if (!preview) return null
  return <section className="shrink-0 border-b px-3 py-2" style={{ borderColor: 'var(--accent-border)', background: 'var(--accent-soft)' }} aria-label="AI編集中の本文プレビュー">
    <p className="mb-1 text-[11px]" style={{ color: 'var(--text-dim)' }}>AI編集中 · 未確定の編集案（検証後に反映）{preview.node_id === null ? ' · 対象シーンを確認中' : ''}</p>
    <div ref={body} className="inspector-scrollbar max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-[12px] leading-relaxed">
      {preview.beat || '本文を生成しています…'}
    </div>
  </section>
}
