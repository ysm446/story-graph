import type { LlamaInstallProgress } from '../../api'

export function fmtSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

export function fmtBytes(bytes: number | null): string {
  if (bytes == null) return '?'
  const gb = bytes / 1024 ** 3
  return gb >= 1 ? `${gb.toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(0)} MB`
}

export function describeProgress(p: LlamaInstallProgress): string {
  if (p.phase === 'download') {
    const pct = p.percent != null ? ` ${p.percent}%` : ''
    return `${p.file_label} をダウンロード中${pct}(${fmtBytes(p.received)}${p.total ? ` / ${fmtBytes(p.total)}` : ''})`
  }
  if (p.phase === 'extract') return `${p.file_label} を展開中…`
  if (p.phase === 'done') return `インストール完了(${p.build ?? '?'})`
  return `エラー: ${p.message}`
}
