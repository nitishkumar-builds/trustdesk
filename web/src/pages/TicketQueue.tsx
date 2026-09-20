import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useErrors } from '../components/ErrorBanner.tsx'
import { Badge, Spinner, fmt } from '../components/ui.tsx'
import { api } from '../lib/api.ts'
import type { TicketListItem } from '../lib/types.ts'

type Loaded = { status: string; items: TicketListItem[] | null } // items null = the load failed

export default function TicketQueue() {
  const navigate = useNavigate()
  const { report } = useErrors()
  const [status, setStatus] = useState('')
  // The list is tagged with the filter it was loaded for, so "loading" is derived, not set.
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  // Status values are whatever the API has returned so far (the pack only has "open"); never invented.
  const [knownStatuses, setKnownStatuses] = useState<string[]>(['open'])
  const current = loaded?.status === status ? loaded : null
  const tickets = current?.items ?? null
  const loading = current === null
  const failed = current !== null && current.items === null

  useEffect(() => {
    let cancelled = false
    api
      .listTickets(status || undefined)
      .then((page) => {
        if (cancelled) return
        setLoaded({ status, items: page.items })
        setKnownStatuses((known) => Array.from(new Set([...known, ...page.items.map((t) => t.status)])))
      })
      .catch((err) => {
        if (cancelled) return
        report(err, 'GET /api/tickets')
        setLoaded({ status, items: null })
      })
    return () => {
      cancelled = true
    }
  }, [status, report])

  const open = (ticketId: string) => navigate(`/tickets/${ticketId}`)

  return (
    <section>
      <div className="row row-between">
        <h2>Ticket queue</h2>
        <label className="row">
          <span className="muted">Status</span>
          <select className="input input-sm" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">all</option>
            {knownStatuses.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        {loading ? <Spinner label="loading" /> : failed ? <span className="text-danger small">could not load tickets (see the error banner)</span> : <span className="muted small">{tickets?.length ?? 0} tickets · click a row to open it</span>}
      </div>
      <table className="table clickable">
        <thead>
          <tr>
            <th>Ticket</th>
            <th>Subject</th>
            <th>Channel</th>
            <th>Customer</th>
            <th>Tier</th>
            <th>Triage</th>
            <th>Escalation</th>
            <th>Status</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {tickets?.map((t) => (
            <tr key={t.ticket_id} onClick={() => open(t.ticket_id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && open(t.ticket_id)}>
              <td>
                <code>{t.ticket_id}</code>
              </td>
              <td>{t.subject}</td>
              <td>{t.channel}</td>
              <td>{t.customer.name}</td>
              <td>
                <Badge value={t.customer.tier} tone="neutral" />
              </td>
              <td>
                {t.latest_triage ? (
                  <span className="row">
                    <Badge value={t.latest_triage.category} tone="info" />
                    <Badge value={t.latest_triage.priority} />
                  </span>
                ) : (
                  <span className="muted small">not triaged</span>
                )}
              </td>
              <td>{t.latest_triage ? t.latest_triage.should_escalate ? <Badge value="escalate" tone="danger" /> : <span className="muted small">no</span> : <span className="muted small">—</span>}</td>
              <td>
                <Badge value={t.status} />
              </td>
              <td className="muted small">{fmt(t.created_at)}</td>
            </tr>
          ))}
          {tickets && tickets.length === 0 ? (
            <tr>
              <td colSpan={9} className="muted">
                No tickets match this filter.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </section>
  )
}
