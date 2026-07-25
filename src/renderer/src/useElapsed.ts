import { useEffect, useState } from 'react'

/** active の間、経過秒数を返す(0.25 秒刻みで更新)。LLM 処理の所要時間表示用 */
export function useElapsedSeconds(active: boolean): number {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (!active) {
      setElapsed(0)
      return
    }
    const start = Date.now()
    setElapsed(0)
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 250)
    return () => clearInterval(timer)
  }, [active])
  return elapsed
}
