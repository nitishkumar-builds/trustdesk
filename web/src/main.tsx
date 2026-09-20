import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.tsx'
import { ErrorProvider } from './components/ErrorBanner.tsx'
import { SessionProvider } from './lib/session.tsx'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <SessionProvider>
        <ErrorProvider>
          <App />
        </ErrorProvider>
      </SessionProvider>
    </BrowserRouter>
  </StrictMode>,
)
