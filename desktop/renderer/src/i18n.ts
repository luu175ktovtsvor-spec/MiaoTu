import { createContext, useContext } from 'react'
import { shellMessage } from './shellCatalog'
import { supportedLocales } from './shellLanguage'
import type { ShellLang } from './shellLanguage'

export const STORAGE_KEY = 'miaoimg-lang'

// 语言选项就是画布的 21 种界面语言（同一份清单），名称用各自语言的原生写法。
export const LANG_OPTIONS = supportedLocales

// 词典在 locales/shell/<locale>.json（见 shellCatalog.ts）。这里只剩 React 上下文。
// 不走 hook 的地方（document.title、初始化脚本之类）按语言取词，规则与 LangProvider 的 t 一致。
export function dictText(lang: ShellLang, key: string, vars?: Record<string, unknown>) {
  return shellMessage(lang, key, vars)
}

export interface LangContextValue {
  lang: ShellLang
  setLang(next: ShellLang | 'zh'): void
  // key 可以是 id（'nav.label'）也可以是中文原文，见 shellCatalog.ts。
  t(key: string, vars?: Record<string, unknown>): string
  // 给 Intl / toLocaleString 用的 BCP 47 语言标签。
  locale: string
  dir: 'ltr' | 'rtl'
}

export const LangContext = createContext<LangContextValue | null>(null)

export function useLang() {
  const context = useContext(LangContext)
  if (!context) throw new Error('useLang must be used within LangProvider')
  return context
}
