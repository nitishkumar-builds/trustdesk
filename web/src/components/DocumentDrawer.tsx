// Side drawer showing one knowledge document (used by the citations row, the trace panel and the documents page).
import { useEffect, useState } from 'react'
import { api } from '../lib/api.ts'
import type { DocumentDetail } from '../lib/types.ts'
import { useErrors } from './ErrorBanner.tsx'
import { Badge, Drawer, Kv, Spinner, fmt } from './ui.tsx'

export const QUARANTINE_LABEL = 'quarantined — never used for grounding'

export function DocumentDrawer({ docId, onClose }: { docId: string | null; onClose: () => void }) {
  const { report } = useErrors()
  // Tagged with the id it was loaded for, so switching documents shows the spinner without a reset.
  const [loaded, setLoaded] = useState<{ docId: string; doc: DocumentDetail } | null>(null)
  const doc = loaded?.docId === docId ? loaded.doc : null

  useEffect(() => {
    if (!docId) return
    let cancelled = false
    api
      .getDocument(docId)
      .then((d) => {
        if (!cancelled) setLoaded({ docId, doc: d })
      })
      .catch((err) => {
        if (!cancelled) {
          report(err, `GET /api/documents/${docId}`)
          onClose()
        }
      })
    return () => {
      cancelled = true
    }
  }, [docId, report, onClose])

  return (
    <Drawer open={docId !== null} title={doc ? `${doc.doc_id} — ${doc.title}` : (docId ?? '')} onClose={onClose}>
      {doc ? (
        <>
          <div className="row">
            <Badge value={doc.trust_level} />
            {doc.quarantined ? <Badge value={QUARANTINE_LABEL} tone="danger" /> : <Badge value="usable for grounding" tone="ok" />}
          </div>
          <Kv
            rows={[
              ['version', doc.version],
              ['audience', doc.audience],
              ['source', doc.source_path],
              ['updated', fmt(doc.updated_at)],
              ['chunks', String(doc.chunk_count)],
            ]}
          />
          <pre className="doc-content">{doc.content}</pre>
        </>
      ) : (
        <Spinner label="loading document" />
      )}
    </Drawer>
  )
}
