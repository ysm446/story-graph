export default function ReaderMode(): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center">
      <div
        className="rounded-2xl border px-8 py-6 text-[13px]"
        style={{ background: 'var(--bg-card)', borderColor: 'var(--border)', color: 'var(--text-dim)' }}
      >
        鑑賞モード(レンダリング)は Phase 4 で実装します。
      </div>
    </div>
  )
}
