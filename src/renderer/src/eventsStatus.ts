import type { EventsStatus } from './types'

// 本文とイベントが食い違っている印の文言(docs/design/event-staleness.md §5)。
// シーンのカードと、詳細欄のイベントの見出しで同じ言葉を使う

export const EVENTS_STATUS_LABEL: Record<EventsStatus, string> = {
  stale: 'イベント要更新',
  missing: 'イベント未作成'
}

export const EVENTS_STATUS_TIP: Record<EventsStatus, string> = {
  stale: '本文・登場人物・場所を変えたあと、イベントを作り直していません',
  missing: '本文はありますが、イベントをまだ作っていません'
}

/** 印を消すボタン。イベントは変えず、いまの本文に合っているものとして扱う */
export const EVENTS_CONFIRM_LABEL: Record<EventsStatus, string> = {
  stale: 'このままでよい',
  missing: 'イベントなしでよい'
}

export const EVENTS_CONFIRM_TIP: Record<EventsStatus, string> = {
  stale: 'イベントは変えず、いまの本文に合っているものとして印を消します(誤字の修正など、内容が変わっていないとき)',
  missing: 'このシーンにはイベントが無いものとして印を消します'
}
