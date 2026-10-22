// 妙图画布的多语言词典。文案以中文原文为 key，其它语言查对应语言包，查不到就回落中文原文。
// 语言列表由本模块维护，语言包由
// 词典随源码维护，scripts/check-canvas-locales.ts 校验键与覆盖率。
import { IntlMessageFormat } from 'intl-messageformat'
import en from './en.json'
import { escapeMessageText } from './messageText'

export { escapeMessageText } from './messageText'

export type Locale =
  | 'zh-CN' | 'zh-TW' | 'en' | 'ja' | 'ru' | 'vi' | 'th' | 'ko' | 'hi'
  | 'id' | 'ms' | 'fil' | 'bn' | 'ur' | 'ta' | 'te' | 'mr' | 'pa' | 'ar' | 'fa' | 'tr'

// ACT: 只有中英双语时本地存的是 'zh'，读设置时必须继续认这个旧值，
// 否则老用户的语言设置会被判为无效而掉回默认。
export type LocaleSetting = Locale | 'zh'

export interface MessageDescriptor { id: string; values?: Record<string, unknown> }

// 名称用各自语言的原生写法，语言选择器直接显示。
export const supportedLocales: { code: Locale; name: string }[] = [
  { code: 'zh-CN', name: '简体中文' },
  { code: 'zh-TW', name: '繁體中文' },
  { code: 'en', name: 'English' },
  { code: 'ja', name: '日本語' },
  { code: 'ru', name: 'Русский' },
  { code: 'vi', name: 'Tiếng Việt' },
  { code: 'th', name: 'ไทย' },
  { code: 'ko', name: '한국어' },
  { code: 'hi', name: 'हिन्दी' },
  { code: 'id', name: 'Bahasa Indonesia' },
  { code: 'ms', name: 'Bahasa Melayu' },
  { code: 'fil', name: 'Filipino' },
  { code: 'bn', name: 'বাংলা' },
  { code: 'ur', name: 'اردو' },
  { code: 'ta', name: 'தமிழ்' },
  { code: 'te', name: 'తెలుగు' },
  { code: 'mr', name: 'मराठी' },
  { code: 'pa', name: 'ਪੰਜਾਬੀ' },
  { code: 'ar', name: 'العربية' },
  { code: 'fa', name: 'فارسی' },
  { code: 'tr', name: 'Türkçe' },
]

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

function maximizeScript(tag: string): string | undefined {
  try { return new Intl.Locale(tag).maximize().script } catch { return undefined }
}

export function normalizeLocale(value: unknown): Locale | undefined {
  if (typeof value !== 'string') return undefined
  const tag = value.trim().replaceAll('_', '-')
  if (!tag) return undefined
  const lower = tag.toLowerCase()
  const base = lower.split('-')[0]!
  if (base === 'zh') {
    // 简繁之分看文字体系；老环境没有 Intl.Locale 时按地区码兜底。
    const script = maximizeScript(tag) ?? (/hant|-(tw|hk|mo)($|-)/.test(lower) ? 'Hant' : 'Hans')
    return script === 'Hant' ? 'zh-TW' : 'zh-CN'
  }
  // 上游的别名：tl → fil、in → id。
  const code = base === 'tl' ? 'fil' : base === 'in' ? 'id' : base
  const supported = supportedLocales.find(item => item.code === code)
  if (!supported) return undefined
  // ACT: 每种语言只提供一种文字体系；pa-Arab（旁遮普语阿拉伯字母）等不能误用 Gurmukhi 译文。
  const script = maximizeScript(tag)
  const own = maximizeScript(supported.code)
  return script && own && script !== own ? undefined : supported.code
}

export function detectLocale(languages: readonly string[] = []): Locale {
  for (const language of languages) {
    const locale = normalizeLocale(language)
    if (locale) return locale
  }
  return 'zh-CN'
}

// ACT: 这三种语言的界面要从右往左排；其它语言都是从左到右。
export function isRtlLocale(locale: LocaleSetting = activeLocale): boolean {
  return locale === 'ar' || locale === 'fa' || locale === 'ur'
}

export function getLocale(): Locale { return activeLocale }

export function isCatalogLoaded(locale: Locale): boolean {
  return locale === 'zh-CN' || Object.hasOwn(catalogs, locale)
}

// 切换语言时调用：先把包拉起来，界面先用中文原文渲染，包到了再通知重渲染。
export function loadCatalog(locale: Locale): Promise<void> {
  if (isCatalogLoaded(locale)) return Promise.resolve()
  const load = catalogLoaders[locale]
  if (!load) return Promise.resolve()
  let task = loading.get(locale)
  if (!task) {
    // 拉包失败就静默回落中文原文：界面仍然可用，不需要把错误抛到用户面前。
    task = load().then(module => {
      catalogs[locale] = module.default
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
