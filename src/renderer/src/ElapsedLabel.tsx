import { useElapsedSeconds } from './useElapsed'

/** 経過秒の表示 `(12s)` だけを小さな部品に分け、1 秒ごとの再描画を親に広げない。
 *
 * useElapsedSeconds を大きな画面(構造モード・鑑賞モード)で直接呼ぶと、処理中は
 * 毎秒その画面全体が描き直される。表示する場所にこれを置き、親では呼ばない。
 */
export function ElapsedLabel({ active }: { active: boolean }): React.JSX.Element {
  const seconds = useElapsedSeconds(active)
  return <>({seconds}s)</>
}

/** 括弧なしの秒数だけ(`12`)。呼び出し側で単位や前後の文言を付ける */
export function ElapsedSeconds({ active }: { active: boolean }): React.JSX.Element {
  const seconds = useElapsedSeconds(active)
  return <>{seconds}</>
}
