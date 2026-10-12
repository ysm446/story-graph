import type { ProductionOperation, ProductionSelectedNode } from './api'

interface ContextMessage {
  role: string
  content: string
  operation?: ProductionOperation
  snapshot?: unknown
  instruction?: unknown
}

/**
 * 初期版は選択・開いている章・直近の応答・確定済み操作から候補を組み立てる。
 * 選択と章のレビューは会話の起点になるので、会話が空でも出す。章はシーンを選択していないときだけ。
 */
export function productionSuggestions(messages: ContextMessage[], selection: ProductionSelectedNode[],
  chapter: { id: string; title: string } | null = null): { label: string; text: string }[] {
  const reverseUser = [...messages].reverse().findIndex((message) => message.role === 'user')
  const lastUser = reverseUser < 0 ? -1 : messages.length - 1 - reverseUser
  const recent = messages.slice(lastUser + 1)
  const reply = [...recent].reverse().find((message) => message.role === 'assistant' && !message.operation && !message.snapshot && !message.instruction && message.content.trim())
  const changes = recent.flatMap((message) => message.operation ? [message.operation] : [])
  const result: { label: string; text: string }[] = []
  if (reply) result.push({
    label: 'この案で進めて',
    text: 'この会話の直前の回答で提示された案で進めてください。対象と作業範囲はその案に従い、画面の選択だけを理由に変更しないでください。完了済みの変更は繰り返さず、残りの作業を進めてください。複数の案があり採用案が特定できない場合は確認してください。'
  })
  const review = '保存内容は変更せず、気になる点と改善案を示してください。'
  if (selection.length) {
    const label = selection.length === 1 ? `選択中の「${selection[0].title}」をレビュー` : `選択中の${selection.length}件をレビュー`
    result.push({ label, text: `次の選択対象をレビューしてください。対象はこの一覧に固定し、送信時の選択が変わっていても変更しないでください。\n${selection.map((node) => `・${node.title}（ID: ${node.id}）`).join('\n')}\n${review}` })
  } else if (chapter) {
    const title = chapter.title || '無題'
    result.push({ label: `章「${title}」をレビュー`, text: `次の章をレビューしてください。対象はこの章に固定し、送信時の画面や選択が変わっていても変更しないでください。\n・${title}（章ID: ${chapter.id}）\n章に含まれるシーンを確認して本文を読み、章全体の流れも見たうえで、${review}` })
  }
  if (changes.length) {
    const targets = [...new Set(changes.map((operation) => `${operation.title || '無題'}（${'entity_id' in operation ? operation.entity_type + ': ' + operation.entity_id : 'scene: ' + operation.node_id}）`))]
    result.push({ label: '今回の変更をレビュー', text: `直前の制作で行った次の対象への変更を、会話の変更履歴と現在の内容に基づいてレビューしてください。画面の選択は対象に含めません。削除済みの対象は変更履歴を確認してください。\n${targets.join('\n')}\n${review}` })
  }
  if (reply) {
    const settings = /設定|世界観|社会情勢|制度|文化/.test((messages[lastUser]?.content ?? '') + reply.content)
    const subject = settings ? '今の設定案' : '直前の回答内容'
    result.push({ label: `${subject}をレビュー`, text: `画面の選択ではなく、この会話の直前の回答内容をレビューしてください。前提の矛盾や不足を確認し、${review}` })
    if (!changes.length) result.push(settings
      ? { label: '今の設定案を資料庫に保存', text: '画面の選択ではなく、この会話の直前の回答でまとめた設定案を、設定資料として保存してください。既存の同名資料があれば内容を確認し、指定外の内容を維持してください。新規資料は「構想」としてください。' }
      : { label: '直前の案の別案を考える', text: '画面の選択ではなく、この会話の直前の回答で示した案について、別の方向性を提案してください。作品はまだ変更しないでください。' })
  }
  return result.slice(0, 3)
}
