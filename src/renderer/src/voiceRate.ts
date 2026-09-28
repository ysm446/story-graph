import { useSyncExternalStore } from 'react'
import { api } from './api'

/** 読み上げの再生速度(docs/design/voice.md §6)。合成し直さず、再生の速さだけを変える
 *  (HTMLMediaElement.playbackRate。声の高さは preservesPitch で保つ)。行の後ろの間も同じ割合で縮める。
 *  値は設定 tts_playback_rate に保存し(ライブラリごと)、鑑賞モード・チャット・試聴で共有する */
export const VOICE_RATES = [0.8, 1, 1.2, 1.5, 2] as const
const SETTING_KEY = 'tts_playback_rate'

let rate = 1
let loaded = false
const listeners = new Set<() => void>()
// 再生中の音声。速さを変えたら、鳴っている最中の行にもその場で効かせる
const playing = new Set<HTMLAudioElement>()

function parse(value: string | undefined): number {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0.5 && n <= 3 ? n : 1
}

function load(): void {
  if (loaded) return
  loaded = true
  api
    .getSettings()
    .then((s) => {
      rate = parse(s[SETTING_KEY])
      listeners.forEach((l) => l())
    })
    .catch(() => {
      /* 読めなければ等速のまま */
    })
}

export function getVoiceRate(): number {
  load()
  return rate
}

export function setVoiceRate(next: number): void {
  rate = parse(String(next))
  playing.forEach((a) => (a.playbackRate = rate))
  listeners.forEach((l) => l())
  void api.putSettings({ [SETTING_KEY]: String(rate) }).catch(() => undefined)
}

/** 音声を今の速さで鳴らす準備をする。終わったら返り値を呼んで登録を外す */
export function applyVoiceRate(audio: HTMLAudioElement): () => void {
  audio.preservesPitch = true
  audio.playbackRate = getVoiceRate()
  playing.add(audio)
  return () => {
    playing.delete(audio)
  }
}

/** 行の後ろの間を、再生の速さに合わせて縮める */
export function scaledPause(ms: number): number {
  return ms / getVoiceRate()
}

function subscribe(listener: () => void): () => void {
  load()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** いまの速さ(変わると再描画する) */
export function useVoiceRate(): number {
  return useSyncExternalStore(subscribe, getVoiceRate)
}
