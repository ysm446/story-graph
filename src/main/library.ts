import { existsSync, mkdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { libraryNameError } from '../shared/libraryName'

/** そのフォルダが既にライブラリか(本体の DB があるか) */
export function isLibraryFolder(root: string): boolean {
  return existsSync(join(root, 'story-graph.db'))
}

/** 新しいライブラリのフォルダを作る。中身(DB)は切り替えのときにバックエンドが作る。
 *  既にあるフォルダは使わない(新規作成のつもりで既存のフォルダへ書き込まないため)。 */
export function createLibraryFolder(parent: string, rawName: string): { root: string } | { error: string } {
  const name = rawName.trim()
  const nameError = libraryNameError(name)
  if (nameError) return { error: nameError }
  if (!isAbsolute(parent)) return { error: `場所はドライブから書いてください: ${parent}` }
  const root = join(parent, name)
  try {
    mkdirSync(root)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST') return { error: `同じ名前のフォルダが既にあります: ${root}` }
    if (code === 'ENOENT') return { error: `場所のフォルダが見つかりません: ${parent}` }
    return { error: `フォルダを作れませんでした: ${root}(${String(error)})` }
  }
  return { root }
}
