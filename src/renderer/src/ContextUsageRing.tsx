export interface ContextUsage {
  token_count: number
  ctx_size: number
  estimated: boolean
}

/** 相談・制作で共通のコンテキスト使用量表示。 */
export default function ContextUsageRing({ usage }: { usage: ContextUsage }): React.JSX.Element {
  const pct = (usage.token_count / Math.max(usage.ctx_size, 1)) * 100
  const fill = Math.min(pct, 100)
  const color = pct >= 90 ? 'var(--danger)' : pct >= 70 ? 'var(--context-warning)' : 'var(--accent)'
  const circumference = 2 * Math.PI * 10
  const description = `入力コンテキスト: ${usage.token_count.toLocaleString()}${usage.estimated ? '(概算)' : ''}\n` +
    `コンテキスト上限: ${usage.ctx_size.toLocaleString()}\n${pct.toFixed(1)}% 使用中\n` +
    '入力の目安です。応答生成用の領域と会話テンプレート分は含みません。'
  return <div className="flex shrink-0 items-center gap-1" role="img" aria-label={description} data-tip={description}>
    <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
      <circle cx="13" cy="13" r="10" fill="none" stroke="var(--border-strong)" strokeWidth="2.2" />
      <circle cx="13" cy="13" r="10" fill="none" stroke={color} strokeWidth="2.2"
        strokeDasharray={circumference} strokeDashoffset={circumference * (1 - fill / 100)}
        strokeLinecap="round" transform="rotate(-90 13 13)"
        style={{ transition: 'stroke-dashoffset 0.4s ease, stroke 0.3s' }} />
    </svg>
    <span className="text-[11px] tabular-nums" style={{ color }}>{usage.estimated ? '≈' : ''}{Math.round(pct)}%</span>
  </div>
}
