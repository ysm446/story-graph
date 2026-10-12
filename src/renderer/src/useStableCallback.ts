import { useCallback, useInsertionEffect, useRef } from 'react'

/** 参照が変わらない関数を返す。中身は毎レンダー最新のものに差し替わる。
 *
 * React Flow の onNodeClick などに毎レンダー新しい関数を渡すと、ライブラリ側の
 * memo が効かず、画面に出ている全カード・全エッジが描き直される。ここで包むと
 * 参照が固定され、ハンドラの中身だけが最新に追従する(useCallback の依存配列を
 * 1 つずつ管理しなくてよい)。レンダー中に呼ぶものには使わない。
 */
export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn)
  useInsertionEffect(() => {
    ref.current = fn
  })
  return useCallback((...args: A): R => ref.current(...args), [])
}
