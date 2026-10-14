import type { ProductionOperation, ProductionSelectedNode } from './api'

interface ContextMessage {
  role: string
  content: string
  execute?: boolean
  operation?: ProductionOperation
  snapshot?: unknown
  instruction?: unknown
}

/** 候補は押した時点でそのまま送る。execute は「制作を実行」として送るもの(作品を書き換える) */
export interface ProductionSuggestion { label: string; text: string; execute: boolean }

/**
 * 初期版は選択・開いている章・直近の応答・確定済み操作から候補を組み立てる。
 * 選択と章のレビューは会話の起点になるので、会話が空でも出す。章はシーンを選択していないときだけ。
 * どちらも無い(作品全体の画面で何も選んでいない)ときは作品全体のレビューを出す(2026-10-15)。
 * 「この案で進めて」は、応答に案があるときだけ・案を指して出したいので LLM の候補に任せている。
 * proceedFallback は、LLM の候補が使えないとき(設定オフ・未起動・失敗・過去の会話)に代わりを出す指定。
 * 実行として送った依頼の応答(完了報告)の後には出さない。
 */
export function productionSuggestions(messages: ContextMessage[], selection: ProductionSelectedNode[],
  chapter: { id: string; title: string } | null = null, proceedFallback = true): ProductionSuggestion[] {
  const reverseUser = [...messages].reverse().findIndex((message) => message.role === 'user')
  const lastUser = reverseUser < 0 ? -1 : messages.length - 1 - reverseUser
  const recent = messages.slice(lastUser + 1)
  const reply = [...recent].reverse().find((message) => message.role === 'assistant' && !message.operation && !message.snapshot && !message.instruction && message.content.trim())
  const changes = recent.flatMap((message) => message.operation ? [message.operation] : [])
  const result: ProductionSuggestion[] = []
  if (reply && proceedFallback && messages[lastUser]?.execute !== true) result.push({
    label: 'この案で進めて', execute: true,
    text: 'この会話の直前の回答で提示された案で進めてください。対象と作業範囲はその案に従い、画面の選択だけを理由に変更しないでください。完了済みの変更は繰り返さず、残りの作業を進めてください。複数の案があり採用案が特定できない場合は確認してください。'
  })
  const review = '保存内容は変更せず、気になる点と改善案を示してください。'
  if (selection.length) {
    const label = selection.length === 1 ? `選択中の「${selection[0].title}」をレビュー` : `選択中の${selection.length}件をレビュー`
    result.push({ label, execute: false, text: `次の選択対象をレビューしてください。対象はこの一覧に固定し、送信時の選択が変わっていても変更しないでください。\n${selection.map((node) => `・${node.title}（ID: ${node.id}）`).join('\n')}\n${review}` })
  } else if (chapter) {
    const title = chapter.title || '無題'
    result.push({ label: `章「${title}」をレビュー`, execute: false, text: `次の章をレビューしてください。対象はこの章に固定し、送信時の画面や選択が変わっていても変更しないでください。\n・${title}（章ID: ${chapter.id}）\nまず章の構成で読む順と分岐を確認し、その順に本文を読んでください。シーンの前後は本文の並びではなく接続（prev / next）で判断し、章全体の流れも見たうえで、${review}` })
  } else {
    // 作品全体の画面で何も選んでいない: 全部を読む全体レビュー(章のまとめだけで済ませる軽い版は、作品が大きくなって遅いと感じたら足す)
    result.push({ label: '作品全体をレビュー', execute: false, text: `作品全体をレビューしてください。対象は作品全体に固定し、送信時の画面や選択が変わっていても変更しないでください。
まず章の構成で章の一覧と読む順(正史)を確認し、その順に各章のシーン本文を読んでください。シーンの前後は本文の並びではなく接続（prev / next）で判断してください。章をまたぐ流れ、伏線の回収漏れ、人物の言動と記憶・事実の一貫性を中心に見たうえで、${review}` })
  }
  if (changes.length) {
    const targets = [...new Set(changes.map((operation) => `${operation.title || '無題'}（${'entity_id' in operation ? operation.entity_type + ': ' + operation.entity_id : 'scene: ' + operation.node_id}）`))]
    result.push({ label: '今回の変更をレビュー', execute: false, text: `直前の制作で行った次の対象への変更を、会話の変更履歴と現在の内容に基づいてレビューしてください。画面の選択は対象に含めません。削除済みの対象は変更履歴を確認してください。\n${targets.join('\n')}\n${review}` })
  }
  if (reply) {
    const settings = /設定|世界観|社会情勢|制度|文化/.test((messages[lastUser]?.content ?? '') + reply.content)
    const subject = settings ? '今の設定案' : '直前の回答内容'
    result.push({ label: `${subject}をレビュー`, execute: false, text: `画面の選択ではなく、この会話の直前の回答内容をレビューしてください。前提の矛盾や不足を確認し、${review}` })
    if (!changes.length) result.push(settings
      ? { label: '今の設定案を資料庫に保存', execute: true, text: '画面の選択ではなく、この会話の直前の回答でまとめた設定案を、設定資料として保存してください。既存の同名資料があれば内容を確認し、指定外の内容を維持してください。新規資料は「構想」としてください。' }
      : { label: '直前の案の別案を考える', execute: false, text: '画面の選択ではなく、この会話の直前の回答で示した案について、別の方向性を提案してください。作品はまだ変更しないでください。' })
  }
  return result.slice(0, 3)
}
