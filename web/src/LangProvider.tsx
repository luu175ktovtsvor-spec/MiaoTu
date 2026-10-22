import { useCallback, useEffect, useMemo, useState } from 'react'
import { dict, dictText, LangContext } from './i18n'
import { CANVAS_SETTINGS_KEY, normalizeShellLang, readCanvasLanguage, shellLangForCanvas, subscribeCanvasLanguage, subscribeDocumentLanguageOwner, writeCanvasLanguage } from './shellLanguage'
import { setShellLang } from './shellText'
import { isAdminHost, isCanvasHost } from './siteOrigins'

// 外壳语言的来源，按优先级：URL 上明确要求的中/EN → 画布已经挑过的语言 → 中文。
// 画布语言是 21 种，外壳只有中英两套：中文系走中文，其它语言一律英文（见 shellLanguage.ts）。
function initialShellLang() {
  const bootstrapped = globalThis.__OIP_INITIAL_LANG__
  if (normalizeShellLang(bootstrapped)) return bootstrapped
  try {
    const requested = normalizeShellLang(new URLSearchParams(window.location.search).get('lang'))
    if (requested) return requested
  } catch {
    // URL unavailable during non-browser rendering — fall through to the canvas setting.
  }
  return shellLangForCanvas(readCanvasLanguage()) || 'zh'
}

export function LangProvider({ children }) {
  const [lang, setLangState] = useState(initialShellLang)

  const setLang = useCallback((next) => {
    // 顶栏的中/EN 是用户明确的选择：写回画布语言，画布下一帧跟上，两套界面不会各说各话。
    writeCanvasLanguage(next === 'en' ? 'en' : 'zh')
    setLangState(next)
    document.documentElement.dataset.landingLang = next
  }, [])

  // 用户没点顶栏、而是在画布设置里换了语言时，外壳跟着画布走。
  useEffect(() => {
    function follow(value: string) {
      const next = shellLangForCanvas(value)
      if (next) setLangState(next)
    }
    const unsubscribe = subscribeCanvasLanguage(follow)
    function onStorage(event) {
      if (event.key === CANVAS_SETTINGS_KEY) follow(readCanvasLanguage())
    }
    window.addEventListener('storage', onStorage)
    return () => { unsubscribe(); window.removeEventListener('storage', onStorage) }
  }, [])

  // 画布挂着的时候 <html lang/dir> 归画布语言所有（21 种语言 + RTL），外壳让位，别抢写。
  const [canvasOwnsDocumentLanguage, setCanvasOwnsDocumentLanguage] = useState(false)
  useEffect(() => subscribeDocumentLanguageOwner(setCanvasOwnsDocumentLanguage), [])

  useEffect(() => {
    if (!canvasOwnsDocumentLanguage) {
      document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
      document.documentElement.dir = 'ltr'
      document.documentElement.dataset.landingLang = lang
    }
    const params = new URLSearchParams(window.location.search)
    const archive = params.has('library') || params.has('session') || params.has('focus') || params.has('q') || ['prompt', 'reference'].includes(params.get('pick'))
    const admin = isAdminHost() || window.location.pathname.startsWith('/manage')
    const studio = isCanvasHost() || params.get('studio') === '1' || params.has('play')
    const landing = !studio && !archive && !admin
    document.title = dictText(lang, studio || landing ? 'app.title' : 'app.libraryTitle')
  }, [canvasOwnsDocumentLanguage, lang])

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
    // 灵感库选择等非 React 模块读取当前外壳语言。
    setShellLang(lang)
    return { lang, setLang, t, locale: lang === 'zh' ? 'zh-CN' : 'en-US' }
  }, [lang, setLang])

  return <LangContext.Provider value={value}>{children}</LangContext.Provider>
}
