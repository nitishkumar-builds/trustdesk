// Every API error ends up here: a dismissable banner with the code, message, request id and
// details. Pages call report(err); nothing is swallowed.
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { ApiError } from '../lib/api.ts'

export interface BannerError {
  id: number
  code: string
  message: string
  status: number | null
  requestId: string | null
  details: unknown
  context: string | null
}

interface ErrorContextValue {
  errors: BannerError[]
  report: (err: unknown, context?: string) => void
  dismiss: (id: number) => void
  clear: () => void
}

const ErrorContext = createContext<ErrorContextValue | null>(null)
let nextId = 1

export function ErrorProvider({ children }: { children: ReactNode }) {
  const [errors, setErrors] = useState<BannerError[]>([])

  const report = useCallback((err: unknown, context?: string) => {
    const entry: BannerError =
      err instanceof ApiError
        ? { id: nextId++, code: err.code, message: err.message, status: err.status, requestId: err.requestId, details: err.details, context: context ?? null }
        : {
            id: nextId++,
            code: 'CLIENT_ERROR',
            message: err instanceof Error ? err.message : String(err),
            status: null,
            requestId: null,
            details: null,
            context: context ?? null,
          }
    setErrors((prev) => [...prev, entry])
  }, [])
  const dismiss = useCallback((id: number) => setErrors((prev) => prev.filter((e) => e.id !== id)), [])
  const clear = useCallback(() => setErrors([]), [])

  const value = useMemo(() => ({ errors, report, dismiss, clear }), [errors, report, dismiss, clear])
  return <ErrorContext.Provider value={value}>{children}</ErrorContext.Provider>
}

export function useErrors(): ErrorContextValue {
  const ctx = useContext(ErrorContext)
  if (!ctx) throw new Error('useErrors must be used inside ErrorProvider')
  return ctx
}

export function ErrorBanners() {
  const { errors, dismiss } = useErrors()
  if (errors.length === 0) return null
  return (
    <div className="banners">
      {errors.map((e) => (
        <div key={e.id} className="banner" role="alert">
          <div>
            <strong>
              {e.code}
              {e.status ? ` (HTTP ${e.status})` : ''}
            </strong>
            {e.context ? <span className="muted"> — {e.context}</span> : null}
            <div>{e.message}</div>
            {e.details != null ? <pre className="banner-details">{JSON.stringify(e.details, null, 2)}</pre> : null}
            {e.requestId ? <div className="muted small">request_id {e.requestId}</div> : null}
          </div>
          <button type="button" className="btn btn-sm" onClick={() => dismiss(e.id)} aria-label="Dismiss error">
            Dismiss
          </button>
        </div>
      ))}
    </div>
  )
}
