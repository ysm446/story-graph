/** フラットな線画アイコン(lucide 準拠のパス)。色は currentColor に従う。
 *  チャット周りの絵文字を置き換えるために用意した最小セット。 */

export type IconName =
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
  | 'pen' // 文章に手を入れる(校正)
  | 'image' // 挿絵(章の表紙にする)
  | 'speaker' // 読み上げ(TTS)
  | 'stop' // 読み上げを止める
  | 'skipBack' // 読み上げの前の行へ
  | 'skipForward' // 読み上げの次の行へ
  | 'users' // 人が二人(キャラ同士の会話室)

const PATHS: Record<IconName, React.JSX.Element> = {
  // lucide の users
  users: (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </>
  ),
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
  ),
  // 下線付きのペン。「書き直す」ではなく「文章に手を入れる」を表す
  pen: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
    </>
  ),
  // 枠 + 太陽 + 山。絵柄を減らしても「絵」に見える最小の形
  image: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="m21 15-4.5-4.5L6 21" />
    </>
  ),
  // スピーカー + 音の波 2 本
  speaker: (
    <>
      <path d="M11 5 6 9H2v6h4l5 4z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
      <path d="M19 5a10 10 0 0 1 0 14" />
    </>
  ),
  stop: <rect x="6" y="6" width="12" height="12" rx="1.5" />,
  // 縦棒 + 三角(lucide の skip-back / skip-forward)
  skipBack: (
    <>
      <path d="M19 20 9 12l10-8z" />
      <path d="M5 19V5" />
    </>
  ),
  skipForward: (
    <>
      <path d="m5 4 10 8-10 8z" />
      <path d="M19 5v14" />
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
