import { useEffect, useRef } from 'react'
import { useProductionPreview } from './productionPreview'
import type { StoryNode } from './types'

/**
 * AI が書いている途中の本文(未確定の編集案)。制作チャットの時系列のいちばん下に、点滅する丸の
 * 1 項目として出し、確定・失敗・終了で消える(確定すれば、同じ場所に緑の丸の操作が入る)。
 * 以前は入力欄の上の箱だったが、会話の流れの外にあり、出入りのたびに入力欄の位置が動いていた。
 * 更新は本文が伸びるたびに届くので、制作チャット本体を描き直さないようこの部品だけで購読する。
 */
export default function ProductionPreviewPanel({ nodes }: { nodes: StoryNode[] }): React.JSX.Element | null {
  const preview = useProductionPreview()
  const item = useRef<HTMLElement>(null)
  const body = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // 長い本文は項目の中でスクロールさせ、末尾を追う。会話欄もこの項目が見える位置まで送る
    if (body.current) body.current.scrollTop = body.current.scrollHeight
    item.current?.scrollIntoView({ block: 'nearest' })
  }, [preview])
  if (!preview) return null
  const title = preview.node_id ? nodes.find((node) => node.id === preview.node_id)?.title || '(無題)' : null
  return (
    <section ref={item} className="timeline-item" aria-label="AI編集中の本文プレビュー">
      <span className="timeline-dot animate-pulse" style={{ background: 'var(--accent)' }} />
      <div className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
        編集案を作成中{title ? `: ${title}` : '(対象を確認中)'}
        <span className="ml-2" style={{ color: 'var(--text-faint)' }}>未確定・検証後に反映</span>
      </div>
      <div ref={body} className="inspector-scrollbar max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-[12px] leading-relaxed"
        style={{ color: 'var(--text-dim)' }}>
        {preview.beat || '本文を生成しています…'}
      </div>
    </section>
  )
}
