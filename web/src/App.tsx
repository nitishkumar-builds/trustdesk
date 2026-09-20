import { NavLink, Route, Routes } from 'react-router-dom'
import { ErrorBanners } from './components/ErrorBanner.tsx'
import { TokenSelector } from './lib/session.tsx'
import DocumentsPage from './pages/DocumentsPage.tsx'
import EvalsPage from './pages/EvalsPage.tsx'
import TicketDetail from './pages/TicketDetail.tsx'
import TicketQueue from './pages/TicketQueue.tsx'

// Route list (Phase 9):
//   /                    TicketQueue
//   /tickets/:ticketId   TicketDetail
//   /evals               EvalsPage
//   /documents           DocumentsPage
export default function App() {
  return (
    <>
      <header className="topbar">
        <div className="row">
          <NavLink to="/" className="brand">
            TrustDesk
          </NavLink>
          <nav className="nav">
            <NavLink to="/" end>
              Tickets
            </NavLink>
            <NavLink to="/evals">Evals</NavLink>
            <NavLink to="/documents">Documents</NavLink>
          </nav>
        </div>
        <TokenSelector />
      </header>
      <ErrorBanners />
      <main className="page">
        <Routes>
          <Route path="/" element={<TicketQueue />} />
          <Route path="/tickets/:ticketId" element={<TicketDetail />} />
          <Route path="/evals" element={<EvalsPage />} />
          <Route path="/documents" element={<DocumentsPage />} />
          <Route path="*" element={<p className="muted">No such page.</p>} />
        </Routes>
      </main>
    </>
  )
}
