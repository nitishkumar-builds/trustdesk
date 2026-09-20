// Tiny session context: the bearer token (persisted in localStorage) and the role label derived
// from it. The header's token selector writes the demo tokens; the override field takes any string,
// which is how the 403-on-approval demo is shown (agent token + Approve).
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { TOKEN_KEY, readToken, writeToken } from './api.ts'

export type Role = 'support_agent' | 'support_manager' | 'admin'

export const DEMO_TOKENS: Record<Role, string> = {
  support_agent: import.meta.env.VITE_DEMO_AGENT_TOKEN ?? 'agent-token-123',
  support_manager: import.meta.env.VITE_DEMO_MANAGER_TOKEN ?? 'manager-token-123',
  admin: import.meta.env.VITE_DEMO_ADMIN_TOKEN ?? 'admin-token-123',
}

export const ROLE_LABELS: Record<Role, string> = {
  support_agent: 'Agent',
  support_manager: 'Manager',
  admin: 'Admin',
}

export interface Session {
  token: string
  /** Role implied by the token; null when the token is a free-text override that matches no demo token. */
  role: Role | null
  roleLabel: string
  /** False only when the token is KNOWN to be the agent token; an unknown token gets the buttons and the server decides. */
  canApprove: boolean
  isAdmin: boolean
  selectRole: (role: Role) => void
  setToken: (token: string) => void
}

const SessionContext = createContext<Session | null>(null)

export function roleForToken(token: string): Role | null {
  for (const role of Object.keys(DEMO_TOKENS) as Role[]) if (DEMO_TOKENS[role] === token) return role
  return null
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [token, setTokenState] = useState<string>(() => {
    // First visit: persist the default so the API wrapper and the header agree.
    const stored = readToken()
    if (!stored) writeToken(DEMO_TOKENS.support_agent)
    return stored || DEMO_TOKENS.support_agent
  })

  const setToken = useCallback((next: string) => {
    const trimmed = next.trim()
    writeToken(trimmed)
    setTokenState(trimmed)
  }, [])
  const selectRole = useCallback((role: Role) => setToken(DEMO_TOKENS[role]), [setToken])

  // Another tab changed the token: follow it, so the header label and the requests stay in step.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === TOKEN_KEY && e.newValue !== null && e.newValue !== readToken()) setToken(e.newValue)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [setToken])

  const value = useMemo<Session>(() => {
    const role = roleForToken(token)
    return {
      token,
      role,
      roleLabel: role ? `${ROLE_LABELS[role]} (${role})` : token ? 'custom token' : 'no token',
      canApprove: role !== 'support_agent',
      isAdmin: role === 'admin',
      selectRole,
      setToken,
    }
  }, [token, selectRole, setToken])

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession(): Session {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error('useSession must be used inside SessionProvider')
  return ctx
}

/** Header token selector: three demo-role buttons plus a free-text override. */
export function TokenSelector() {
  const session = useSession()
  const [override, setOverride] = useState('')
  return (
    <div className="token-selector">
      <span className="muted">Token:</span>
      {(Object.keys(DEMO_TOKENS) as Role[]).map((role) => (
        <button
          key={role}
          type="button"
          className={`btn btn-sm${session.role === role ? ' btn-active' : ''}`}
          onClick={() => session.selectRole(role)}
          title={DEMO_TOKENS[role]}
        >
          {ROLE_LABELS[role]}
        </button>
      ))}
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault()
          if (override.trim()) session.setToken(override)
          setOverride('')
        }}
      >
        <input
          className="input input-sm"
          placeholder="override token…"
          value={override}
          onChange={(e) => setOverride(e.target.value)}
          aria-label="Override token"
        />
        <button type="submit" className="btn btn-sm">
          Use
        </button>
      </form>
      <span className="badge badge-neutral" title={session.token}>
        {session.roleLabel}
      </span>
    </div>
  )
}
