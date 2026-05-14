import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

const THEME_KEY = 'salon-theme'

function applyInitialTheme() {
  const root = document.documentElement
  let theme = 'light'
  try {
    const saved = localStorage.getItem(THEME_KEY)
    if (saved === 'light' || saved === 'dark') {
      theme = saved
    } else if (window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
      theme = 'dark'
    }
  } catch {
    // ignore storage errors
  }
  root.setAttribute('data-theme', theme)
}

applyInitialTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
