// 妙图画布的多语言词典。文案以中文原文为 key，中文系回落中文，其它语言优先回落英文。
// 语言列表由本模块维护，语言包由
// 词典随源码维护，scripts/check-canvas-locales.ts 校验键与覆盖率。
import { IntlMessageFormat } from 'intl-messageformat'
import en from './en.json'
import { escapeMessageText } from './messageText'
import { normalizeLocale } from './locales'
import { numericMessageValues } from '../../../../../../server/numeric-messages.ts'
import type { Locale, LocaleSetting } from './locales'

export { escapeMessageText } from './messageText'
export { detectLocale, isRtlLocale, normalizeLocale, supportedLocales } from './locales'
export type { Locale, LocaleSetting } from './locales'

export interface MessageDescriptor { id: string; values?: Record<string, unknown> }

// zh-CN 没有字典：中文原文就是 key，直接返回即可。en 静态进主包，
// 19 个非中英语言包（合计约 2.3MB）走动态 import，切到哪种语言才加载哪种。
const catalogs: Record<string, Record<string, string>> = { en }
const catalogLoaders: Partial<Record<Locale, () => Promise<{ default: Record<string, string> }>>> = {
  'zh-TW': () => import('./zhTw.json'),
  ja: () => import('./ja.json'),
  ru: () => import('./ru.json'),
  vi: () => import('./vi.json'),
  th: () => import('./th.json'),
  ko: () => import('./ko.json'),
  hi: () => import('./hi.json'),
  id: () => import('./id.json'),
  ms: () => import('./ms.json'),
  fil: () => import('./fil.json'),
  bn: () => import('./bn.json'),
  ur: () => import('./ur.json'),
  ta: () => import('./ta.json'),
  te: () => import('./te.json'),
  mr: () => import('./mr.json'),
  pa: () => import('./pa.json'),
  ar: () => import('./ar.json'),
  fa: () => import('./fa.json'),
  tr: () => import('./tr.json'),
}
const loading = new Map<Locale, Promise<void>>()

let activeLocale: Locale = 'zh-CN'
const listeners = new Set<(locale: Locale) => void>()
const catalogListeners = new Set<() => void>()
let catalogRevision = 0
export function getCatalogRevision() { return catalogRevision }

export function getLocale(): Locale { return activeLocale }

export function isCatalogLoaded(locale: Locale): boolean {
  return locale === 'zh-CN' || Object.hasOwn(catalogs, locale)
}

// 切换语言时先加载目标包，过渡期按 lookupMessage 的中英文回落规则渲染。
export function loadCatalog(locale: Locale): Promise<void> {
  if (isCatalogLoaded(locale)) return Promise.resolve()
  const load = catalogLoaders[locale]
  if (!load) return Promise.resolve()
  let task = loading.get(locale)
  if (!task) {
    // 拉包失败沿用中英文回落规则，保留重试机会。
    task = load().then(module => {
      catalogs[locale] = module.default
      catalogRevision += 1
      loading.delete(locale)
      if (locale === activeLocale) for (const listener of catalogListeners) listener()
    }, () => { loading.delete(locale) })
    loading.set(locale, task)
  }
  return task
}

export function setLocale(locale: LocaleSetting) {
  const next = normalizeLocale(locale) ?? 'zh-CN'
  void loadCatalog(next)
  if (next === activeLocale) return
  activeLocale = next
  for (const listener of listeners) listener(next)
}

export function subscribeLocale(listener: (locale: Locale) => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

// 语言包是异步到的：订阅它在到位时再渲染一次，否则界面会停在中文原文上。
export function subscribeCatalog(listener: () => void) {
  catalogListeners.add(listener)
  return () => { catalogListeners.delete(listener) }
}

// ACT: 模板字符串的静态部分按上游一样转义后再拼 id（见 messageText.ts）。
export function msg(strings: TemplateStringsArray, ...values: unknown[]): MessageDescriptor {
  if (!values.length) return { id: strings[0] }
  return {
    id: strings.map((part, index) => escapeMessageText(part) + (index < values.length ? `{${index}}` : '')).join(''),
    values: Object.fromEntries(values.map((value, index) => [index, value])),
  }
}

// ACT: ICU 语法（plural / select）交给上游同款的 intl-messageformat 解析，
// 同一处按「语言 + 原文」缓存的 formatter，同样的 ignoreTag（文案里可能有 HTML 标签）。
const formatters = new Map<string, IntlMessageFormat>()

function formatMessage(text: string, parameters: Record<string, unknown>, language: Locale): string {
  const cacheKey = `${language}\0${text}`
  let formatter = formatters.get(cacheKey)
  if (!formatter) {
    formatter = new IntlMessageFormat(text, language, undefined, { ignoreTag: true })
    // ACT: 字典与语言切换共享缓存，限制 2000 项；无需随用户输入增长。
    if (formatters.size >= 2000) formatters.delete(formatters.keys().next().value!)
    formatters.set(cacheKey, formatter)
  }
  const result = formatter.format(Object.fromEntries(Object.entries(parameters).map(([key, value]) => [key,
    typeof value === 'number' || value instanceof Date ? value : String(value),
  ])))
  return Array.isArray(result) ? result.join('') : String(result)
}

// ACT: 回落规则是有意偏离上游的。上游的回落口径是「回源语言」，那建立在「上游的包覆盖它自己
// 全部文案」的前提上；我们的词典是上游的超集（多出来的几百条是妙图自己的功能），照上游口径
// 会让非中文用户在 19 种语言下有 27% 的文案露中文——对日语/阿拉伯语用户来说英文比中文有用。
// 所以：中文系（zh-CN / zh-TW）查不到回落中文原文；其它语言先回落英文（en.json），
// 英文也没有才回落中文原文。繁体不走英文：繁体用户看不懂英文的概率比看不懂简体低得多。
function lookupMessage(language: Locale, id: string): string {
  const own = catalogs[language]
  if (own && Object.hasOwn(own, id) && typeof own[id] === 'string') return own[id]
  // ACT: 语言包是懒加载的，包没到位时这里也会落到英文——这是有意的：那一瞬间给什么都是过渡态，
  // 给英文至少可读，也符合「别让非中文用户看到中文」。包到了会靠 catalogRevision 重渲染成目标语言。
  if (language !== 'zh-CN' && language !== 'zh-TW') {
    const english = catalogs.en
    if (english && Object.hasOwn(english, id) && typeof english[id] === 'string') return english[id]
  }
  return id
}

// 只认应用词典译文及其受控数字参数，用于保留安全错误；任意英文诊断不在信任范围。
export function isKnownTranslation(text: string, language: Locale = activeLocale): boolean {
  return [catalogs[language], catalogs.en].some(catalog => catalog && Object.values(catalog).some(value => value === text || numericMessageValues(value, text)))
}

export function translate(message: string | MessageDescriptor, values?: Record<string, unknown>, language: Locale = activeLocale): string {
  const id = typeof message === 'string' ? message : message.id
  const parameters = values ?? (typeof message === 'string' ? undefined : message.values)
  const translated = lookupMessage(language, id)
  if (!parameters || !Object.keys(parameters).length) return translated
  try {
    return formatMessage(translated, parameters, language)
  } catch {
    // ACT: 妙图的文案以中文原文为 key、数量多且是纯文本，个别条目可能带上 ICU 不认的字符；
    // 格式化失败不能让界面崩，按上游的回落顺序退：先格式化原文，再退回 {0}/{name} 直接替换。
    try {
      return formatMessage(id, parameters, language)
    } catch {
      return id.replace(/\{(\w+)\}/g, (token, key) => Object.hasOwn(parameters, key) ? String(parameters[key] ?? '') : token)
    }
  }
}

export function t(strings: TemplateStringsArray, ...values: unknown[]): string {
  return translate(msg(strings, ...values))
}
