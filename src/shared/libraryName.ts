/** ライブラリ名(= フォルダ名)に使えない理由を返す。使えるなら null。前後の空白は呼ぶ側で落とす。
 *  入力中の表示(レンダラ)と、実際に作る前の確認(メインプロセス)で同じ判定を使う。 */
export function libraryNameError(name: string): string | null {
  if (!name) return '名前を入力してください'
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(name)) return 'フォルダ名に使えない文字が入っています( \\ / : * ? " < > | )'
  if (name.endsWith('.')) return '名前の最後にピリオドは使えません'
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(name)) return `「${name}」は Windows が予約している名前なので使えません`
  return null
}
