import './lib/workspaceRemote'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { IconContext } from '@phosphor-icons/react'
import './index.css'
import './library.css'
import App from './App'
import { LangProvider } from './LangProvider'
import DesktopBar from './desktop/DesktopBar'
import { initializeClientAppearance } from './clientAppearance'

initializeClientAppearance(true)

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <IconContext.Provider value={{ weight: 'regular', mirrored: false }}>
      <LangProvider>
        <DesktopBar><App /></DesktopBar>
      </LangProvider>
    </IconContext.Provider>
  </StrictMode>,
)
