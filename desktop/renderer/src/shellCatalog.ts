// 外壳词典：每种语言一份扁平 JSON（locales/shell/<locale>.json），两类 key 放在同一份里——
//   1. id 形式（'nav.label'），用 useLang().t(key)；
//   2. 中文原文（'保存昵称'），用 studioText / shellT / t(中文)，中文原文本身就是简体中文的译文。
// zh-CN 只存 id 形式（中文原文查不到就是它自己）；其它语言两类都存。
//
// 回落规则（有意不同于「回源语言」）：
//   zh-CN：查不到 → key 本身；
//   zh-TW：自己的包 → 简体中文包 → key（繁体用户读简体比读英文容易）；
//   其它 19 种：自己的包 → 英文包 → key。绝不回落简体中文，更不回落别的语言。
// en / zh-CN 同步打进主包；其它语言包按需动态加载，包到位之前先用英文渲染，到位后通知重渲染。
import { IntlMessageFormat } from 'intl-messageformat'
import zhCN from './locales/shell/zh-CN.json'
import en from './locales/shell/en.json'
import type { ShellLang } from './shellLanguage'

type Catalog = Record<string, string>

const catalogs: Partial<Record<ShellLang, Catalog>> = { 'zh-CN': zhCN, en }
const loaders = import.meta.glob<{ default: Catalog }>(['./locales/shell/*.json', '!./locales/shell/en.json', '!./locales/shell/zh-CN.json'])
const loading = new Map<ShellLang, Promise<void>>()
const listeners = new Set<() => void>()
let revision = 0

export function shellCatalogRevision() { return revision }

export function subscribeShellCatalog(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function isShellCatalogLoaded(lang: ShellLang) { return Object.hasOwn(catalogs, lang) }

export function loadShellCatalog(lang: ShellLang): Promise<void> {
  if (isShellCatalogLoaded(lang)) return Promise.resolve()
  const load = loaders[`./locales/shell/${lang}.json`]
  if (!load) return Promise.resolve()
  let task = loading.get(lang)
  if (!task) {
    // 拉包失败就静默用英文：界面仍然可用。
    task = load().then(module => {
      catalogs[lang] = module.default
      loading.delete(lang)
      revision += 1
      for (const listener of [...listeners]) listener()
    }, () => { loading.delete(lang) })
    loading.set(lang, task)
  }
  return task
}

function own(catalog: Catalog | undefined, key: string) {
  return catalog && Object.hasOwn(catalog, key) && typeof catalog[key] === 'string' ? catalog[key] : undefined
}

export function shellRaw(lang: ShellLang, key: string): string {
  if (lang === 'zh-CN') return own(zhCN, key) ?? key
  const hit = own(catalogs[lang], key)
  if (hit !== undefined) return hit
  if (lang === 'zh-TW') return own(zhCN, key) ?? key
  return own(en, key) ?? key
}

const ICU = /\{\s*\w+\s*,\s*(plural|select|selectordinal)\b/

// {name} 占位符；带 plural / select 的走 ICU（单复数在各语言词典里自己写，不在代码里分叉）。
export function shellFormat(lang: ShellLang, text: string, vars?: Record<string, unknown>): string {
  if (!vars) return text
  if (ICU.test(text)) {
    try {
      const values = Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, typeof v === 'number' ? v : String(v)]))
      const result = new IntlMessageFormat(text, lang, undefined, { ignoreTag: true }).format(values)
      return Array.isArray(result) ? result.join('') : String(result)
    } catch {
      // 译文写坏了也不能让界面崩：退回按占位符替换。
    }
  }
  return text.replace(/\{(\w+)\}/g, (token, name) => (Object.hasOwn(vars, name) ? String(vars[name]) : token))
}

export function shellMessage(lang: ShellLang, key: string, vars?: Record<string, unknown>): string {
  return shellFormat(lang, shellRaw(lang, key), vars)
}
