// Small presentational pieces shared by the pages: badges, spinner, side drawer, JSON block,
// and the useAction hook that gives every long action a spinner, a disabled button and an error banner.
import { useCallback, useState, type ReactNode } from 'react'
import { useErrors } from './ErrorBanner.tsx'

// Tone per status/priority/outcome value; anything unknown renders neutral.
const TONES: Record<string, string> = {
  // ticket / draft / action statuses
  open: 'info',
  generated: 'info',
  edited: 'info',
  approved: 'ok',
  sent: 'ok',
  executed: 'ok',
  rejected: 'danger',
  failed: 'danger',
  approval_required: 'warn',
  requested: 'info',
  executing: 'warn',
  cancelled: 'neutral',
  completed: 'ok',
  running: 'warn',
  // priorities
  low: 'neutral',
  medium: 'info',
  high: 'warn',
  urgent: 'danger',
  // guardrail outcomes
  allow: 'ok',
  allow_with_escalation: 'warn',
  refuse_and_escalate: 'danger',
  // risk / trust
  trusted: 'ok',
  untrusted: 'danger',
}

export function Badge({ value, tone, title }: { value: string; tone?: string; title?: string }) {
  const t = tone ?? TONES[value] ?? 'neutral'
  return (
    <span className={`badge badge-${t}`} title={title}>
      {value}
    </span>
  )
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="spinner-wrap" role="status">
      <span className="spinner" />
      {label ? <span className="muted small">{label}</span> : null}
    </span>
  )
}

export function Drawer({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  if (!open) return null
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()} aria-label={title}>
        <div className="row row-between">
          <h3>{title}</h3>
          <button type="button" className="btn btn-sm" onClick={onClose}>
            Close
          </button>
        </div>
        {children}
      </aside>
    </div>
  )
}

export function JsonBlock({ value, maxHeight }: { value: unknown; maxHeight?: number }) {
  return (
    <pre className="json" style={maxHeight ? { maxHeight } : undefined}>
      {value === undefined ? 'undefined' : JSON.stringify(value, null, 2)}
    </pre>
  )
}

export function Kv({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="kv">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * useAction: run(name, fn) marks `name` busy while fn runs, reports any error to the banner, and
 * never throws. Buttons use `busy === name` for their spinner and `busy !== null` to disable.
 */
export function useAction() {
  const { report } = useErrors()
  const [busy, setBusy] = useState<string | null>(null)
  const run = useCallback(
    async (name: string, fn: () => Promise<void>, context?: string) => {
      setBusy(name)
      try {
        await fn()
      } catch (err) {
        report(err, context ?? name)
      } finally {
        setBusy(null)
      }
    },
    [report],
  )
  return { busy, run }
}

export function ActionButton({
  name,
  busy,
  onClick,
  children,
  className,
  disabled,
  title,
}: {
  name: string
  busy: string | null
  onClick: () => void
  children: ReactNode
  className?: string
  disabled?: boolean
  title?: string
}) {
  const running = busy === name
  return (
    <button type="button" className={`btn ${className ?? ''}`} onClick={onClick} disabled={disabled || busy !== null} title={title}>
      {running ? <span className="spinner spinner-inline" /> : null}
      {children}
    </button>
  )
}

export const fmt = (iso: string | null | undefined): string => (iso ? iso.replace('T', ' ').replace(/\.\d{3}Z$/, 'Z') : '—')
