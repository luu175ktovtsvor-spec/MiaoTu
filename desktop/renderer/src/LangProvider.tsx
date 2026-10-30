import { useCallback, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { dictText, LangContext } from './i18n'
import { loadShellCatalog, shellCatalogRevision, shellMessage, subscribeShellCatalog } from './shellCatalog'
import { CANVAS_SETTINGS_KEY, canvasOwnsDocumentLanguageNow, intlLocale, isRtlLocale, normalizeShellLang, readCanvasLanguage, shellLangForCanvas, subscribeCanvasLanguage, subscribeDocumentLanguageOwner, writeCanvasLanguage } from './shellLanguage'
import type { ShellLang } from './shellLanguage'
import { setShellLang } from './shellText'
import { getCatalogRevision, setLocale, subscribeCatalog } from './studio/canvas/i18n'

// 外壳语言的来源，按优先级：URL 上明确要求的语言 → 画布已经挑过的语言 → 简体中文。
// 外壳与画布同为 21 种语言，直接取画布语言（见 shellLanguage.ts）；老用户存的 'zh' 当 'zh-CN' 认。
function initialShellLang(): ShellLang {
  const bootstrapped = normalizeShellLang(globalThis.__OIP_INITIAL_LANG__)
  if (bootstrapped) return bootstrapped
  try {
    const requested = normalizeShellLang(new URLSearchParams(window.location.search).get('lang'))
    if (requested) return requested
  } catch {
    // URL unavailable during non-browser rendering — fall through to the canvas setting.
  }
  return shellLangForCanvas(readCanvasLanguage()) || 'zh-CN'
}

export function LangProvider({ children }) {
  const [lang, setLangState] = useState<ShellLang>(initialShellLang)

  const setLang = useCallback((requested: ShellLang | 'zh') => {
    const next = normalizeShellLang(requested) ?? 'en'
    // 顶栏的语言选择是用户明确的选择：写回画布语言，画布下一帧跟上，两套界面不会各说各话。
    writeCanvasLanguage(next)
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
    const onLanguageChange = () => { if (readCanvasLanguage() === 'system') follow('system') }
    window.addEventListener('storage', onStorage)
    window.addEventListener('languagechange', onLanguageChange)
    // Vue 设置可能在子组件挂载时已发过通知，订阅后回读避免漏掉首轮同步。
    const saved = readCanvasLanguage()
    if (saved && !normalizeShellLang(globalThis.__OIP_INITIAL_LANG__) && !normalizeShellLang(new URLSearchParams(window.location.search).get('lang'))) follow(saved)
    return () => { unsubscribe(); window.removeEventListener('storage', onStorage); window.removeEventListener('languagechange', onLanguageChange) }
  }, [])

  // 非中英语言包是按需加载的：切到哪种语言才拉哪种，包到位后 revision 变化触发重渲染。
  useEffect(() => { void loadShellCatalog(lang) }, [lang])
  const catalogRevision = useSyncExternalStore(subscribeShellCatalog, shellCatalogRevision, shellCatalogRevision)
  // 首页也会显示画布词典中的安全错误，不必等用户打开画布或设置。
  const errorCatalogRevision = useSyncExternalStore(subscribeCatalog, getCatalogRevision, getCatalogRevision)

  // 画布挂着的时候 <html lang/dir> 归画布语言所有（21 种语言 + RTL），外壳让位，别抢写。
  const [canvasOwnsDocumentLanguage, setCanvasOwnsDocumentLanguage] = useState(canvasOwnsDocumentLanguageNow)
  useEffect(() => {
    const unsubscribe = subscribeDocumentLanguageOwner(setCanvasOwnsDocumentLanguage)
    setCanvasOwnsDocumentLanguage(canvasOwnsDocumentLanguageNow())
    return unsubscribe
  }, [])

  const dir = isRtlLocale(lang) ? 'rtl' : 'ltr'
  useLayoutEffect(() => {
    setLocale(lang)
    if (!canvasOwnsDocumentLanguage) {
      document.documentElement.lang = lang
      document.documentElement.dir = dir
    }
    document.title = dictText(lang, new URLSearchParams(window.location.search).has('library') ? 'app.libraryTitle' : 'app.title')
  }, [canvasOwnsDocumentLanguage, lang, dir, catalogRevision])

  const value = useMemo(() => {
    const t = (key: string, vars?: Record<string, unknown>) => shellMessage(lang, key, vars)
    // 非 React 模块（lib/**）取词用：语言在这里注入一次，调用点不用各自判断。
    setShellLang(lang)
    // catalogRevision：语言包到位后 t 要换成新的函数，依赖它的组件才会重渲染。
    void catalogRevision
    void errorCatalogRevision
    return { lang, setLang, t, locale: intlLocale(lang), dir: dir as 'ltr' | 'rtl' }
  }, [lang, setLang, dir, catalogRevision, errorCatalogRevision])

  return <LangContext.Provider value={value}>{children}</LangContext.Provider>
}
