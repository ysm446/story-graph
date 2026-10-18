/** 関係の値(-1〜+1)のバー。0 を中心に、好意は右へ・反感は左へ伸ばす。
 *
 *  どこが 0 か分かるように、中央の目盛りはバーより上下に 2px はみ出させ、塗りは中央側を角ばらせて
 *  外側の端だけ丸くする(どちらから伸びているかが形で分かる)。
 *  before を渡すと、直前の値を同じ色の薄い塗りで下に敷く(線を増やすと中央の目盛りと紛れるため。
 *  伸びた・縮んだ・向きが変わったが面積で分かる)。キャラタブの関係とシーンの Events で共用する */
export default function RelationBar({
  score,
  before,
  tip,
  className = ''
}: {
  score: number
  /** 直前の値(null / 省略 = 出さない) */
  before?: number | null
  tip?: string
  className?: string
}): React.JSX.Element {
  const fill = (value: number, faint: boolean): React.JSX.Element | null => {
    if (value === 0) return null
    const color = value > 0 ? 'var(--rel-positive)' : 'var(--rel-negative)'
    return (
      <div
        className={`absolute inset-y-0 ${value > 0 ? 'rounded-r-full' : 'rounded-l-full'}`}
        style={{
          width: `${Math.min(Math.abs(value), 1) * 50}%`,
          [value > 0 ? 'left' : 'right']: '50%',
          background: faint ? `color-mix(in srgb, ${color} 30%, transparent)` : color
        }}
      />
    )
  }
  return (
    <div
      className={`relative h-1.5 rounded-full ${className}`}
      style={{ background: 'var(--bg-input)' }}
      data-tip={tip}
    >
      {before !== null && before !== undefined && fill(before, true)}
      {fill(score, false)}
      {/* 0 の目盛り。塗りの上に描く */}
      <div
        className="absolute -inset-y-0.5 left-1/2 w-0.5 -translate-x-1/2 rounded-full"
        style={{ background: 'var(--text-faint)' }}
      />
    </div>
  )
}
