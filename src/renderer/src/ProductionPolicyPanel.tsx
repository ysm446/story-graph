import { useEffect, useRef, useState } from 'react'
import type { ProductionPolicy } from './api'
import type { Group, StoryNode } from './types'

export const defaultProductionPolicy = (): ProductionPolicy => ({ allowed_ids: null, protected_ids: [], group_id: null })

export function policySummary(policy: ProductionPolicy, nodes: StoryNode[], groups: Group[]): string {
  const scope = policy.group_id ? `章「${groups.find((g) => g.id === policy.group_id)?.title ?? policy.group_id}」`
    : policy.allowed_ids === null ? '全体' : `個別指定 ${policy.allowed_ids.length} 件`
  const protectedNames = policy.protected_ids.map((id) => nodes.find((n) => n.id === id)?.title || id)
  return `変更範囲: ${scope} / 保護: ${protectedNames.length ? protectedNames.join('、') : 'なし'}`
}

export default function ProductionPolicyPanel({ value, onChange, nodes, groups, busy }: {
  value: ProductionPolicy
  onChange: (value: ProductionPolicy) => void
  nodes: StoryNode[]
  groups: Group[]
  busy: boolean
}): React.JSX.Element {
  const [search, setSearch] = useState('')
  const detailsRef = useRef<HTMLDetailsElement>(null)
  useEffect(() => { if (busy && detailsRef.current) detailsRef.current.open = false }, [busy])
  const mode = value.group_id ? `chapter:${value.group_id}` : value.allowed_ids === null ? 'all' : 'selected'
  const toggle = (field: 'allowed_ids' | 'protected_ids', id: string): void => {
    const ids = value[field] ?? []
    onChange({ ...value, [field]: ids.includes(id) ? ids.filter((v) => v !== id) : [...ids, id] })
  }
  const missing = [...(value.allowed_ids ?? []), ...value.protected_ids].filter((id) => !nodes.some((n) => n.id === id))
  const visible = nodes.filter((n) => `${n.title ?? ''} ${n.id}`.toLowerCase().includes(search.toLowerCase()))
  const buttonStyle = (on: boolean): React.CSSProperties => ({ borderColor: 'var(--border-strong)',
    ...(on ? { background: 'var(--accent-soft)', color: 'var(--text)' } : { color: 'var(--text-faint)' }) })
  return <details ref={detailsRef} className="max-h-[50%] shrink-0 overflow-y-auto rounded-lg border px-3 py-1.5 text-[12px]" style={{ borderColor: 'var(--border)', background: 'var(--bg-elevated)' }}>
    <summary className="cursor-pointer text-[11px]" data-tip="この制作で変更できる範囲と保護するシーンを指定します">{policySummary(value, nodes, groups)}</summary>
    <div className="mt-2 flex flex-col gap-2">
      <select aria-label="制作の変更範囲" value={mode} disabled={busy}
        onChange={(e) => onChange({ ...value, group_id: e.target.value.startsWith('chapter:') ? e.target.value.slice(8) : null,
          allowed_ids: e.target.value === 'selected' ? [] : null })}
        className="rounded-md border px-2 py-0.5 text-[12px] outline-none disabled:opacity-50"
        style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }} data-tip={busy ? '条件の変更は制作を停止してから行えます' : '読み取りは全体、変更だけをこの範囲に制限します'}>
        <option value="all">全体を変更対象にする</option>
        <option value="selected">シーンを個別に選ぶ</option>
        {groups.map((g) => <option key={g.id} value={`chapter:${g.id}`}>章: {g.title}</option>)}
        {value.group_id && !groups.some((g) => g.id === value.group_id) && <option value={mode}>対象の章が見つかりません</option>}
      </select>
      <p className="text-[11px]" style={{ color: 'var(--text-dim)' }}>保護は本文・削除・直接の接続変更を禁止します。保護・範囲外のシーンが参照するキャラクターや場所の設定も変更できません。前のシーンの編集による状態・記憶の再計算は行います。条件は今回の実行中は固定です。</p>
      {mode === 'selected' && <p className="text-[11px]" style={{ color: 'var(--text-dim)' }}>挿入・削除では接続が変わる前後も選んでください。はじまり・章の境界・結末は接続の対象として選べます。</p>}
      {!!missing.length && <p role="alert" className="text-[11px]" style={{ color: 'var(--danger)' }}>存在しない指定があります: {missing.join('、')}。範囲を選び直すか保護を解除してください。
        <button disabled={busy} onClick={() => onChange({ ...value, allowed_ids: value.allowed_ids?.filter((id) => !missing.includes(id)) ?? null,
          protected_ids: value.protected_ids.filter((id) => !missing.includes(id)) })}
          className="ml-2 rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-50" style={buttonStyle(false)} data-tip="削除済みのシーンの指定だけを取り除きます">存在しない指定を外す</button>
      </p>}
      <input aria-label="条件のシーン検索" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="シーンを検索"
        className="rounded-md border px-2 py-0.5 text-[12px] outline-none" style={{ background: 'var(--bg-input)', borderColor: 'var(--border)' }} />
      <div className="max-h-40 overflow-y-auto">
        {visible.map((node) => <div key={node.id} className="flex items-center gap-2 py-0.5">
          <span className="min-w-0 flex-1 truncate" data-tip={`${node.title || '(無題)'} (${node.id})`}>{node.title || '(無題)'}</span>
          {mode === 'selected' && <button aria-label={`対象: ${node.title || node.id}`} aria-pressed={value.allowed_ids?.includes(node.id)} disabled={busy}
            onClick={() => toggle('allowed_ids', node.id)} className="shrink-0 rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-50"
            style={buttonStyle(!!value.allowed_ids?.includes(node.id))} data-tip={busy ? '制作を停止してから変更できます' : 'このシーンと直接の接続を変更範囲に含めます'}>{value.allowed_ids?.includes(node.id) ? '☑' : '☐'} 対象</button>}
          <button aria-label={`保護: ${node.title || node.id}`} aria-pressed={value.protected_ids.includes(node.id)} disabled={busy}
            onClick={() => toggle('protected_ids', node.id)} className="shrink-0 rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-50"
            style={buttonStyle(value.protected_ids.includes(node.id))} data-tip={busy ? '制作を停止してから変更できます' : 'このシーンの本文・削除・直接の接続変更を禁止します'}>{value.protected_ids.includes(node.id) ? '☑' : '☐'} 保護</button>
        </div>)}
      </div>
    </div>
  </details>
}
