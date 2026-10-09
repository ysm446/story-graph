import DOMPurify from 'dompurify'
import { marked } from 'marked'

// LLM が「A $\to$ B」のように数式記法で書く癖の後始末(2026-10-09 ユーザー報告)。
// 数式の描画機能は入れず、よく出る記号だけを普通の文字へ置き換える。
// システムプロンプトでも禁じている(chat_agent.NO_MATH_RULE)ので、ここは漏れた分の保険
const LATEX_SYMBOLS: Record<string, string> = {
  to: '→',
  rightarrow: '→',
  Rightarrow: '⇒',
  leftarrow: '←',
  leftrightarrow: '↔',
  times: '×',
  cdot: '・',
  leq: '≤',
  le: '≤',
  geq: '≥',
  ge: '≥',
  neq: '≠',
  ne: '≠',
  approx: '≈',
  ldots: '…',
  dots: '…'
}
const LATEX_COMMAND = new RegExp(`\\\\(${Object.keys(LATEX_SYMBOLS).join('|')})(?![A-Za-z])`, 'g')

/** `\to` などの記号を置き換え、残った `$…$` / `\(…\)` の囲いを外す。
 *  囲いの中にまだバックスラッシュ(未対応の命令)が残る場合と、`$5 and $10` のように
 *  中身が数字で始まる場合(金額)は触らない */
export function normalizeMath(text: string): string {
  const replaced = text.replace(LATEX_COMMAND, (_m, name: string) => LATEX_SYMBOLS[name])
  const unwrap = (_m: string, inner: string): string =>
    inner.includes('\\') || /^\s*\d/.test(inner) ? _m : inner.trim()
  return replaced.replace(/\$([^$\n]{1,60})\$/g, unwrap).replace(/\\\(([^\n]{1,60}?)\\\)/g, unwrap)
}

/** LLM 出力の Markdown を安全に描画する(news-picker から移植)。リンクは OS ブラウザで開く。 */
export function Markdown({ text }: { text: string }): React.JSX.Element {
  // breaks: チャットの単一改行を <br> にする(pre-wrap 表示だった頃の見た目に合わせる)
  const html = DOMPurify.sanitize(
    marked.parse(normalizeMath(text), { async: false, gfm: true, breaks: true }) as string
  )
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
