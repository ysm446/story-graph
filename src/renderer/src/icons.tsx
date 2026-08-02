/** フラットな線画アイコン(lucide 準拠のパス)。色は currentColor に従う。
 *  チャット周りの絵文字を置き換えるために用意した最小セット。 */

type IconName =
  | 'chat' // 吹き出し(相談チャット)
  | 'mask' // 芝居の仮面(キャラクターと話す)
  | 'search' // ツール実行(調査)
  | 'recall' // 記憶をたどる
  | 'sparkle' // 内容から生成された候補 / 自動生成
  | 'zap' // 生成速度
  | 'tokens' // トークン数
  | 'clock' // 所要時間
  | 'tool' // ツールのステップ数
  | 'insert' // 線の途中に挿し込む(シーンの割り込み追加)

const PATHS: Record<IconName, React.JSX.Element> = {
  chat: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
  mask: (
    <>
      <path d="M3 5v6a7 7 0 0 0 7 7 7 7 0 0 0 7-7V5z" />
      <path d="M7 9h.01" />
      <path d="M13 9h.01" />
      <path d="M8 13c1.5 1 3.5 1 5 0" />
      <path d="M17 6h2a2 2 0 0 1 2 2v3a5 5 0 0 1-3 4.58" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </>
  ),
  recall: (
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 8v4l3 2" />
    </>
  ),
  sparkle: (
    <>
      <path d="M12 3l1.9 4.6L18.5 9.5 13.9 11.4 12 16l-1.9-4.6L5.5 9.5l4.6-1.9z" />
      <path d="M18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8z" />
    </>
  ),
  zap: <path d="M13 2 4 14h7l-1 8 9-12h-7z" />,
  tokens: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  tool: (
    <path d="M14.7 6.3a4 4 0 0 0 5 5l-9.4 9.4a2.1 2.1 0 0 1-3-3z" />
  ),
  // 「つながりの途中に足す」を絵にする(⤵ だと分岐と区別が付かなかった)。
  // 左右の線がちょうど円に接するので -⊕- に見える
  insert: (
    <>
      <path d="M2 12h5" />
      <path d="M17 12h5" />
      <circle cx="12" cy="12" r="5" />
      <path d="M12 9.5v5" />
      <path d="M9.5 12h5" />
    </>
  )
}

export function Icon({
  name,
  size = 14,
  className,
  strokeWidth = 2
}: {
  name: IconName
  size?: number
  className?: string
  strokeWidth?: number
}): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {PATHS[name]}
    </svg>
  )
}
