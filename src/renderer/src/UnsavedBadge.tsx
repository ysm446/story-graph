/** 資料庫の一覧・保存欄で共用する未保存表示。 */
export default function UnsavedBadge(): React.JSX.Element {
  return <span className="shrink-0 rounded-md px-1.5 py-0.5 text-[10px]"
    style={{ background: 'var(--accent-soft)', color: 'var(--text)' }}
    data-tip="この資料には未保存の変更があります">未保存</span>
}
