import { useCallback, useEffect, useState } from 'react'
import { DocumentDrawer, QUARANTINE_LABEL } from '../components/DocumentDrawer.tsx'
import { useErrors } from '../components/ErrorBanner.tsx'
import { Badge, Spinner } from '../components/ui.tsx'
import { api } from '../lib/api.ts'
import type { DocumentListItem } from '../lib/types.ts'

// Rule R4 made visible: quarantined documents are listed and readable, but flagged in red.
export default function DocumentsPage() {
  const { report } = useErrors()
  // null = loading, 'failed' = the load failed (the banner has the error), else the list
  const [docs, setDocs] = useState<DocumentListItem[] | 'failed' | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const close = useCallback(() => setOpenId(null), [])

  useEffect(() => {
    let cancelled = false
    api
      .listDocuments()
      .then((r) => {
        if (!cancelled) setDocs(r.items)
      })
      .catch((err) => {
        if (cancelled) return
        report(err, 'GET /api/documents')
        setDocs('failed')
      })
    return () => {
      cancelled = true
    }
  }, [report])
  const items = Array.isArray(docs) ? docs : null

  return (
    <section>
      <div className="row row-between">
        <h2>Knowledge base documents</h2>
        {docs === null ? <Spinner label="loading" /> : docs === 'failed' ? <span className="text-danger small">could not load documents (see the error banner)</span> : <span className="muted small">{docs.length} documents · click a row to read it</span>}
      </div>
      <table className="table clickable">
        <thead>
          <tr>
            <th>Doc id</th>
            <th>Title</th>
            <th>Version</th>
            <th>Audience</th>
            <th>Trust level</th>
            <th>Quarantine</th>
            <th>Chunks</th>
          </tr>
        </thead>
        <tbody>
          {items?.map((d) => (
            <tr key={d.doc_id} onClick={() => setOpenId(d.doc_id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setOpenId(d.doc_id)}>
              <td>
                <code>{d.doc_id}</code>
              </td>
              <td>{d.title}</td>
              <td>{d.version}</td>
              <td>{d.audience}</td>
              <td>
                <Badge value={d.trust_level} />
              </td>
              <td>{d.quarantined ? <Badge value={QUARANTINE_LABEL} tone="danger" /> : <span className="muted small">no</span>}</td>
              <td>{d.chunk_count}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <DocumentDrawer docId={openId} onClose={close} />
    </section>
  )
}
