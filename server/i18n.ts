// 服务端本地化：对齐上游 apps/server/src/lib/i18n.ts 的结构——
// AsyncLocalStorage 存请求级语言 + 标签模板 t，在服务端就把用户可见文案翻好再发出去。
//
// 共享服务端词典位于 server/locales；网页画布归档不影响已支持的 API 语言。
// 键就是中文原文；缺少对应词条时沿用既有回落规则。
import { AsyncLocalStorage } from 'node:async_hooks'
import { IntlMessageFormat } from 'intl-messageformat'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CATALOG_DIR = fileURLToPath(new URL('./locales/', import.meta.url))
const requestLocale = new AsyncLocalStorage()
const catalogs = new Map()
let fallback = () => 'zh-CN'

// 文件名与前端一致：zh-TW 的词典文件是 zhTw.json。
function catalogFile(locale) { return locale === 'zh-TW' ? 'zhTw' : locale }
function catalog(locale) {
  if (catalogs.has(locale)) return catalogs.get(locale)
  const file = `${CATALOG_DIR}${catalogFile(locale)}.json`
  let value = null
  try { if (existsSync(file)) value = JSON.parse(readFileSync(file, 'utf8')) } catch { value = null }
  catalogs.set(locale, value)
  return value
}

// 与前端 normalizeLocale 同一套口径：zh* 归 zh-CN，其余按大小写规范后原样保留。
export function normalizeLocale(value) {
  const tag = String(value || '').trim().replace(/_/g, '-')
  if (!tag) return undefined
  const lower = tag.toLowerCase()
  if (lower === 'zh' || lower.startsWith('zh-')) {
    if (lower === 'zh-tw' || lower === 'zh-hk' || lower === 'zh-hant') return 'zh-TW'
    return 'zh-CN'
  }
  const parts = lower.split('-')
  return [parts[0], ...parts.slice(1).map(part => part.length === 2 ? part.toUpperCase() : part)].join('-')
}

// Accept-Language 解析（q 值排序），与上游 resolveRequestLocale 同一口径。
export function resolveRequestLocale(header) {
  const items = String(header || '').split(',').map((part, index) => {
    const match = /^([a-z]{1,8}(?:-[a-z\d]{1,8})*)(?:\s*;\s*q=(0(?:\.\d{0,3})?|1(?:\.0{0,3})?))?$/i.exec(part.trim())
    return { locale: match ? normalizeLocale(match[1]) : undefined, weight: Number(match?.[2] ?? 1), index }
  }).filter(item => item.locale && item.weight > 0)
    .sort((left, right) => right.weight - left.weight || left.index - right.index)
  for (const item of items) {
    // 有词典、或是中文（键即原文）才算命中；否则继续往下找。
    if (item.locale === 'zh-CN' || catalog(item.locale)) return item.locale
  }
  return fallback()
}

export function setLocaleFallback(resolve) { fallback = resolve }
export function getLocale() { return requestLocale.getStore() ?? fallback() }
export function runWithLocale(locale, operation) { return requestLocale.run(locale, operation) }

// 与前端的 lookupMessage 同一套回落规则（那边注明是有意偏离上游）：中文系只回落中文原文，
// 其它语言先回落英文、英文也没有才回落中文原文。
function lookupMessage(language, id) {
  const own = catalog(language)
  if (own && Object.hasOwn(own, id) && typeof own[id] === 'string') return own[id]
  if (language !== 'zh-CN' && language !== 'zh-TW') {
    const english = catalog('en')
    if (english && Object.hasOwn(english, id) && typeof english[id] === 'string') return english[id]
  }
  return id
}

// 与前端同一套格式化：同一个库（intl-messageformat）、同一份缓存口径、同样的回落链。
// 字典里确实有 ICU 复数（如「{0, plural, one {...}}」），纯文本替换会把它们翻错，
// 所以这里不另写一套简化实现——服务端和界面必须语义一致。
const formatters = new Map()
function formatMessage(text, parameters, language) {
  const cacheKey = `${language}\0${text}`
  let formatter = formatters.get(cacheKey)
  if (!formatter) {
    formatter = new IntlMessageFormat(text, language, undefined, { ignoreTag: true })
    if (formatters.size >= 2000) formatters.delete(formatters.keys().next().value)
    formatters.set(cacheKey, formatter)
  }
  const result = formatter.format(Object.fromEntries(Object.entries(parameters).map(([key, value]) => [key,
    typeof value === 'number' || value instanceof Date ? value : String(value)])))
  return Array.isArray(result) ? result.join('') : String(result)
}

export function translate(message, values?: Record<string, unknown>) {
  const id = typeof message === 'string' ? message : message?.id
  const parameters = values ?? (typeof message === 'string' ? undefined : message?.values)
  const language = getLocale()
  const translated = lookupMessage(language, id)
  if (!parameters || !Object.keys(parameters).length) return translated
  try {
    return formatMessage(translated, parameters, language)
  } catch {
    try {
      return formatMessage(id, parameters, language)
    } catch {
      return id.replace(/\{(\w+)\}/g, (token, key) => Object.hasOwn(parameters, key) ? String(parameters[key] ?? '') : token)
    }
  }
}

// 模板静态部分按 ICU 规则转义；与前端 messageText.ts 同一实现（照上游 packages/i18n/src/messageText.ts）。
function escapeMessageText(value) {
  return value.replaceAll("'", "''").replaceAll('{', "'{'").replaceAll('}', "'}'")
}

export function t(strings, ...values) {
  const id = values.length ? strings.map((part, index) => escapeMessageText(part) + (index < values.length ? `{${index}}` : '')).join('') : strings[0]
  return translate(id, values.length ? Object.fromEntries(values.map((value, index) => [index, value])) : undefined)
}
