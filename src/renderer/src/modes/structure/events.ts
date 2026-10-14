import { api } from '../../api'
import type { EventInput, StoryEvent } from '../../types'

// putEvents は全件置換なので、手元の node.events を土台にすると、直前の保存が
// reload 前だった場合にそのイベントが消える。保存前にサーバーの最新を取り直す
export async function latestEventInputs(nodeId: string, fallback: StoryEvent[]): Promise<EventInput[]> {
  let events = fallback
  try {
    events = (await api.getNode(nodeId)).events ?? fallback
  } catch {
    /* 取れなければ手元の値で続行 */
  }
  // id を引き継ぐ(編集で ID が変わると replaces / reasons の参照が壊れる)
  return events.map((e) => ({ id: e.id, type: e.type, payload: e.payload, source: e.source }))
}
