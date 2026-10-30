import { useRef, useState } from 'react'

/** 画像のドロップ枠。`{...bind(onFile)}` を枠の要素に付け、`dragOver` で枠を光らせる。
 *  子要素との境界で dragleave が発火してもチラつかないよう、入った深さを数える。 */
export function useFileDrop(): {
  dragOver: boolean
  bind: (onFile: (file: File | undefined) => void) => {
    onDragEnter: (e: React.DragEvent) => void
    onDragOver: (e: React.DragEvent) => void
    onDragLeave: () => void
    onDrop: (e: React.DragEvent) => void
  }
} {
  const [dragOver, setDragOver] = useState(false)
  const depth = useRef(0)
  const bind = (onFile: (file: File | undefined) => void) => ({
    onDragEnter: (e: React.DragEvent): void => {
      e.preventDefault()
      depth.current += 1
      setDragOver(true)
    },
    onDragOver: (e: React.DragEvent): void => e.preventDefault(),
    onDragLeave: (): void => {
      depth.current -= 1
      if (depth.current <= 0) {
        depth.current = 0
        setDragOver(false)
      }
    },
    onDrop: (e: React.DragEvent): void => {
      e.preventDefault()
      depth.current = 0
      setDragOver(false)
      onFile(e.dataTransfer.files?.[0])
    }
  })
  return { dragOver, bind }
}
