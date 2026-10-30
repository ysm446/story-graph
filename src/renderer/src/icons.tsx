/** フラットな線画アイコン(lucide 準拠のパス)。色は currentColor に従う。
 *  チャット周りの絵文字を置き換えるために用意した最小セット。 */

export type IconName =
  | 'alignNodes' // 基準線にノードを揃える
  | 'robotLock' // AI編集から保護(閉じた鍵)
  | 'robotUnlock' // AI編集を許可(開いた鍵)
  | 'chat' // 吹き出し(相談チャット)
  | 'globe' // 世界(人物に属さない事実)
  | 'arrowUp' // 送信
  | 'list' // 会話一覧
  | 'chatPlus' // 新しい会話(吹き出しに +)
  | 'trash' // ゴミ箱(今の会話を削除)
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
  | 'activity' // 脈拍の折れ線(システムリソース表示の切り替え)
  | 'info' // 丸に i(見出しの説明をツールチップで出す)
  | 'relation' // 左右の矢印(イベントの「関係」)
  | 'fact' // 荷札(イベントの「事実」)
  | 'more' // 横の三点(イベントの「その他」)
  | 'rotateCcw' // 左回りの矢印(既定値に戻す)
  | 'download' // 受け皿に下向きの矢印(ダウンロード / 書き出し)
  | 'upload' // 受け皿に上向きの矢印(読み込み)
  | 'pause' // 縦棒 2 本(一時停止)
  | 'play' // 右向きの三角(再開)

const PATHS: Record<IconName, React.JSX.Element> = {
  alignNodes: (
    <>
      <path d="M3 21h18" />
      <rect x="3" y="9" width="4" height="8" rx="1" />
      <rect x="10" y="3" width="4" height="14" rx="1" />
      <rect x="17" y="6" width="4" height="11" rx="1" />
    </>
  ),
  robotLock: (
    <>
      <path d="M10 5V2H8M2 9v4M18 9V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h5M7 9v1M13 9v1M8 14h3" />
      <rect x="13" y="15" width="9" height="7" rx="1.5" />
      <path d="M15 15v-2.5a2.5 2.5 0 0 1 5 0V15M17.5 18v1" />
    </>
  ),
  robotUnlock: (
    <>
      <path d="M10 5V2H8M2 9v4M18 9V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h5M7 9v1M13 9v1M8 14h3" />
      <rect x="13" y="15" width="9" height="7" rx="1.5" />
      <path d="M15 15v-2.5a2.5 2.5 0 0 1 5 0M17.5 18v1" />
    </>
  ),
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
  // lucide の list
  list: (
    <>
      <path d="M8 6h13M8 12h13M8 18h13" />
      <path d="M3 6h.01M3 12h.01M3 18h.01" />
    </>
  ),
  // lucide の message-square-plus
  chatPlus: (
    <>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      <path d="M12 7v6M9 10h6" />
    </>
  ),
  // lucide の trash-2
  trash: (
    <>
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M10 11v6M14 11v6" />
    </>
  ),
  // lucide の arrow-up
  arrowUp: (
    <>
      <path d="m5 12 7-7 7 7" />
      <path d="M12 19V5" />
    </>
  ),
  // lucide の globe
  globe: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
      <path d="M2 12h20" />
    </>
  ),
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
  ),
  // lucide の activity
  activity: <path d="M22 12h-4l-3 9L9 3l-3 9H2" />,
  // lucide の arrow-left-right
  relation: (
    <>
      <path d="M8 3 4 7l4 4" />
      <path d="M4 7h16" />
      <path d="m16 21 4-4-4-4" />
      <path d="M20 17H4" />
    </>
  ),
  // lucide の tag(旧版。点は線で描く)
  fact: (
    <>
      <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
      <path d="M7 7h.01" />
    </>
  ),
  // lucide の ellipsis
  more: (
    <>
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
      <circle cx="5" cy="12" r="1" />
    </>
  ),
  // lucide の rotate-ccw
  rotateCcw: (
    <>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </>
  ),
  // lucide の download
  download: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" x2="12" y1="15" y2="3" />
    </>
  ),
  // lucide の upload
  upload: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" x2="12" y1="3" y2="15" />
    </>
  ),
  // lucide の pause
  pause: (
    <>
      <rect x="14" y="4" width="4" height="16" rx="1" />
      <rect x="6" y="4" width="4" height="16" rx="1" />
    </>
  ),
  // lucide の play
  play: <polygon points="6 3 20 12 6 21 6 3" />,
  // lucide の info
  info: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
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

/** 読み込み中の回転(ModelBar・ServiceBar の起動中) */
export function SpinnerIcon(): React.JSX.Element {
  return (
    <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <path d="M21 12a9 9 0 1 1-6.2-8.5" />
    </svg>
  )
}

/** 取り外し(モデル・サービスを止める) */
export function EjectIcon(): React.JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5l7 10H5z" />
      <path d="M5 19h14" />
    </svg>
  )
}
