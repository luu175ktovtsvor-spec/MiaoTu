import { useCallback, useEffect, useMemo, useState } from 'react'
import { dict, dictText, LangContext } from './i18n'
import { SHELL_SETTINGS_KEY, normalizeShellLang, readStoredLanguage, shellLangForStored, writeStoredLanguage } from './shellLanguage'

// 语言来源，按优先级：URL 上明确要求的中/EN → 之前保存的选择 → 中文。
function initialShellLang() {
  const bootstrapped = globalThis.__OIP_INITIAL_LANG__
  if (normalizeShellLang(bootstrapped)) return bootstrapped
  try {
    const requested = normalizeShellLang(new URLSearchParams(window.location.search).get('lang'))
    if (requested) return requested
  } catch {
    // URL unavailable during non-browser rendering — fall through to the stored setting.
  }
  return shellLangForStored(readStoredLanguage()) || 'zh'
}

export function LangProvider({ children }) {
  const [lang, setLangState] = useState(initialShellLang)

  const setLang = useCallback((next) => {
    writeStoredLanguage(next === 'en' ? 'en' : 'zh')
    setLangState(next)
    document.documentElement.dataset.landingLang = next
  }, [])

  // 其它标签页换了语言时跟着走。
  useEffect(() => {
    function onStorage(event) {
      if (event.key !== SHELL_SETTINGS_KEY) return
      const next = shellLangForStored(readStoredLanguage())
      if (next) setLangState(next)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
    document.documentElement.dir = 'ltr'
    document.documentElement.dataset.landingLang = lang
    document.title = dictText(lang, 'app.title')
  }, [lang])

  const value = useMemo(() => {
    const table = dict[lang] || dict.en
    const t = (key, vars) => {
      let str = table[key] ?? dict.en[key] ?? key
      if (vars) {
        Object.entries(vars).forEach(([name, val]) => {
          str = str.replaceAll(`{${name}}`, String(val))
        })
      }
      return str
    }
    return { lang, setLang, t, locale: lang === 'zh' ? 'zh-CN' : 'en-US' }
  }, [lang, setLang])

  return <LangContext.Provider value={value}>{children}</LangContext.Provider>
}
