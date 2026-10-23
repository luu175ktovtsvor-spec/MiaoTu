import { useEffect, useState } from 'react'
import { useLang } from '../i18n'
import { adminText } from './i18n'

const THEME_KEY = 'miao-admin-theme'

function readThemeChoice() {
  try {
    const saved = localStorage.getItem(THEME_KEY)
    if (saved === 'light' || saved === 'dark' || saved === 'system') return saved
  } catch { /* storage unavailable */ }
  return 'light'
}

function systemTheme() {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

export function useAdminTheme() {
  const [choice, setChoice] = useState(readThemeChoice)
  const [system, setSystem] = useState(systemTheme)
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: light)')
    const onChange = () => setSystem(media.matches ? 'light' : 'dark')
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])
  useEffect(() => {
    const theme = choice === 'system' ? system : choice
    document.documentElement.dataset.adminTheme = theme
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    const previous = meta?.content
    if (meta) meta.content = theme === 'light' ? '#f2f1ed' : '#0f1010'
    return () => {
      delete document.documentElement.dataset.adminTheme
      if (meta && previous) meta.content = previous
    }
  }, [choice, system])
  function choose(next) {
    setChoice(next)
    try {
      localStorage.setItem(THEME_KEY, next)
    } catch { /* storage unavailable */ }
  }
  return { choice, theme: choice === 'system' ? system : choice, choose }
}

export function ThemeControl({ choice, onChange }) {
  const { lang } = useLang()
  return (
    <div className="admin-theme">
      <span id="admin-theme-label">{adminText('外观', lang)}</span>
      <div role="radiogroup" aria-labelledby="admin-theme-label">
        {[['dark', adminText('深色', lang)], ['light', adminText('浅色', lang)], ['system', adminText('系统', lang)]].map(([value, label]) => (
          <button key={value} type="button" role="radio" aria-checked={choice === value} onClick={() => onChange(value)}>{label}</button>
        ))}
      </div>
    </div>
  )
}
