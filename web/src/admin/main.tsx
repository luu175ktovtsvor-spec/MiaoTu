import { createRoot } from 'react-dom/client'
import { LangProvider } from '../LangProvider'
import AdminPage from './AdminPage'
import './shell.css'
createRoot(document.getElementById('root')!).render(<LangProvider><AdminPage /></LangProvider>)
