import { useSyncExternalStore } from 'react'

let message: string | null = null
let timer: ReturnType<typeof setTimeout> | undefined
const listeners = new Set<() => void>()
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function showStatusNotice(text: string): void {
  clearTimeout(timer)
  message = text
  listeners.forEach((listener) => listener())
  timer = setTimeout(() => {
    message = null
    listeners.forEach((listener) => listener())
  }, 5000)
}

export function useStatusNotice(): string | null {
  return useSyncExternalStore(subscribe, () => message)
}
