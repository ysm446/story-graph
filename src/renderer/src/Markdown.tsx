import DOMPurify from 'dompurify'
import { marked } from 'marked'

/** LLM 出力の Markdown を安全に描画する(news-picker から移植)。リンクは OS ブラウザで開く。 */
export function Markdown({ text }: { text: string }): React.JSX.Element {
  // breaks: チャットの単一改行を <br> にする(pre-wrap 表示だった頃の見た目に合わせる)
  const html = DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true, breaks: true }) as string)
  return (
    <div
      className="chat-md"
      onClick={(e) => {
        const anchor = (e.target as HTMLElement).closest('a')
        if (anchor?.href) {
          e.preventDefault()
          window.open(anchor.href) // main の setWindowOpenHandler で shell.openExternal に振られる
        }
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
