import { useCallback, useEffect, useState } from 'react'
import { useErrors } from '../components/ErrorBanner.tsx'
import { ActionButton, Badge, Kv, Spinner, fmt, useAction } from '../components/ui.tsx'
import { api } from '../lib/api.ts'
import type { MetricsSummary } from '../lib/types.ts'

const ms = (v: number | null) => (v === null ? '—' : `${v} ms`)
const usd = (v: number) => `$${v.toFixed(4)}`

// Observability (Phase 11 item 1): what GET /api/metrics/summary reports over agent_run.
export default function MetricsPage() {
  const { report } = useErrors()
  const { busy, run } = useAction()
  const [summary, setSummary] = useState<MetricsSummary | 'failed' | null>(null)

  const load = useCallback(() => {
    let cancelled = false
    api
      .metricsSummary()
      .then((s) => {
        if (!cancelled) setSummary(s)
      })
      .catch((err) => {
        if (cancelled) return
        report(err, 'GET /api/metrics/summary')
        setSummary((prev) => (prev && prev !== 'failed' ? prev : 'failed'))
      })
    return () => {
      cancelled = true
    }
  }, [report])

  useEffect(() => load(), [load])

  const refresh = () => run('refresh', async () => setSummary(await api.metricsSummary()), 'GET /api/metrics/summary')

  return (
    <section className="stack">
      <div className="row row-between">
        <h2>Metrics</h2>
        <div className="row">
          {summary && summary !== 'failed' ? <span className="muted small">generated {fmt(summary.generated_at)}</span> : null}
          <ActionButton name="refresh" busy={busy} onClick={refresh}>
            Refresh
          </ActionButton>
        </div>
      </div>

      {summary === null ? <Spinner label="loading metrics" /> : null}
      {summary === 'failed' ? <p className="text-danger">Could not load the metrics summary (see the error banner).</p> : null}

      {summary && summary !== 'failed' ? (
        <>
          <div className="metrics">
            <div className="metric metric-ok">
              <div className="metric-value">{summary.runs_total}</div>
              <div className="metric-name">agent runs</div>
            </div>
            <div className="metric metric-ok">
              <div className="metric-value">{ms(summary.latency.p50_ms)}</div>
              <div className="metric-name">p50 latency</div>
            </div>
            <div className="metric metric-ok">
              <div className="metric-value">{ms(summary.latency.p95_ms)}</div>
              <div className="metric-name">p95 latency</div>
            </div>
            <div className="metric metric-ok">
              <div className="metric-value">{summary.tokens.total}</div>
              <div className="metric-name">tokens (prompt {summary.tokens.prompt} + completion {summary.tokens.completion})</div>
            </div>
            <div className="metric metric-ok">
              <div className="metric-value">{usd(summary.estimated_cost_usd.total)}</div>
              <div className="metric-name">estimated cost ({summary.estimated_cost_usd.runs_priced} priced, {summary.estimated_cost_usd.runs_unpriced} unpriced)</div>
            </div>
          </div>

          <div className="columns">
            <div className="card">
              <h3>Runs per type</h3>
              <table className="table">
                <thead>
                  <tr>
                    <th>Run type</th>
                    <th>Runs</th>
                    <th>p50</th>
                    <th>p95</th>
                    <th>max</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(summary.runs_by_type).map(([type, n]) => {
                    const l = summary.latency.by_type[type]
                    return (
                      <tr key={type}>
                        <td>
                          <Badge value={type} tone="info" />
                        </td>
                        <td>{n}</td>
                        <td>{ms(l?.p50_ms ?? null)}</td>
                        <td>{ms(l?.p95_ms ?? null)}</td>
                        <td>{ms(l?.max_ms ?? null)}</td>
                      </tr>
                    )
                  })}
                  {Object.keys(summary.runs_by_type).length === 0 ? (
                    <tr>
                      <td colSpan={5} className="muted">
                        No agent runs yet — triage a ticket or run an evaluation.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
              <h4>by status</h4>
              <div className="row">
                {Object.entries(summary.runs_by_status).map(([status, n]) => (
                  <span key={status} className="row">
                    <Badge value={status} /> {n}
                  </span>
                ))}
              </div>
            </div>

            <div className="card">
              <h3>Tokens and cost by model</h3>
              <table className="table">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Calls</th>
                    <th>Prompt</th>
                    <th>Completion</th>
                    <th>Est. cost</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(summary.tokens.by_model).map(([model, t]) => (
                    <tr key={model}>
                      <td>
                        <code>{model}</code>
                      </td>
                      <td>{t.runs}</td>
                      <td>{t.prompt}</td>
                      <td>{t.completion}</td>
                      <td>{model in summary.estimated_cost_usd.by_model ? usd(summary.estimated_cost_usd.by_model[model]!) : <span className="muted">not priced</span>}</td>
                    </tr>
                  ))}
                  {Object.keys(summary.tokens.by_model).length === 0 ? (
                    <tr>
                      <td colSpan={5} className="muted">
                        No model calls recorded yet.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>

            <div className="card">
              <h3>Pricing</h3>
              <Kv
                rows={[
                  ['source', summary.pricing.source === 'env' ? 'AI_PRICE_TABLE_JSON override + defaults' : 'defaults (server/src/ai/pricing.ts)'],
                  ['priced models', summary.pricing.models.join(', ')],
                ]}
              />
              <p className="muted small">{summary.pricing.note}</p>
            </div>
          </div>
        </>
      ) : null}
    </section>
  )
}
