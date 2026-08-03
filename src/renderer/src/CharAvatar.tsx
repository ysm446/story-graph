import { assetUrl } from './api'
import type { Character } from './types'

/** キャラのアイコン。画像が無いときは色付きの頭文字で代替する
 *  (プロフィール画像は装飾専用なので、無くても成り立つのが前提)。
 *
 *  相談チャットのために作ったものを、インスペクタの記憶カード・章のまとめでも
 *  使うので共通部品として切り出した。 */
export default function CharAvatar({
  char,
  size
}: {
  char: Character
  size: number
}): React.JSX.Element {
  const src = assetUrl(char.portrait_path)
  const color = char.color ?? '#8a8fa8'
  const style = { width: size, height: size, border: `1.5px solid ${color}` }
  if (src) {
    return (
      <img
        src={src}
        alt={char.name}
        title={char.name}
        className="shrink-0 rounded-full object-cover"
        style={style}
      />
    )
  }
  return (
    <span
      title={char.name}
      className="flex shrink-0 items-center justify-center rounded-full font-semibold"
      style={{ ...style, background: `${color}33`, color, fontSize: Math.round(size * 0.45) }}
    >
      {char.name.slice(0, 1)}
    </span>
  )
}
