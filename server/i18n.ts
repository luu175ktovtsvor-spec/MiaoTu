// 服务端本地化：对齐上游 apps/server/src/lib/i18n.ts 的结构——
// AsyncLocalStorage 存请求级语言 + 标签模板 t，在服务端就把用户可见文案翻好再发出去。
//
// 共享服务端词典位于 server/locales；网页画布归档不影响已支持的 API 语言。
// 键就是中文原文；缺少对应词条时沿用既有回落规则。
import { AsyncLocalStorage } from 'node:async_hooks'
import { IntlMessageFormat } from 'intl-messageformat'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { numericMessageValues } from './numeric-messages.ts'
import { normalizeUserErrorCopy } from './user-errors.ts'

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

// 地区与文字体系跟客户端一致：ja-JP → ja，zh-Hant-* → zh-TW。
// pa-Arab 等不能套用另一种文字体系的词典。
export function normalizeLocale(value) {
  const tag = String(value || '').trim().replace(/_/g, '-')
  if (!tag || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(tag)) return undefined
  const lower = tag.toLowerCase()
  const base = lower.split('-')[0]
  let script: string | undefined
  try { script = new Intl.Locale(tag).maximize().script } catch { return undefined }
  if (base === 'zh') return script === 'Hant' ? 'zh-TW' : 'zh-CN'
  const code = base === 'tl' ? 'fil' : base === 'in' ? 'id' : base
  let ownScript: string | undefined
  try { ownScript = new Intl.Locale(code).maximize().script } catch { return undefined }
  return script && ownScript && script !== ownScript ? undefined : code
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
  return String(header || '').trim() ? 'en' : fallback()
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

// 参数校验先生成安全中文错误，响应时再按词典模板还原纯数字参数。
// 只允许数字/分辨率/比例及它们的列表；不把用户文本、路径或诊断当占位符翻译。
let publicNumericTemplates: string[] | undefined
function numericPublicMessage(text: string) {
  publicNumericTemplates ??= Object.keys(catalog('en') || {}).filter(id => /[㐀-鿿]/.test(id) && /\{\w+\}/.test(id))
  for (const id of publicNumericTemplates) {
    const values = numericMessageValues(id, text)
    if (values) return translate(id, values)
  }
  return undefined
}

function publicMessage(text: string, language: string) {
  text = normalizeUserErrorCopy(text, key => catalog(language)?.[key])
  text = normalizeUserErrorCopy(text, key => catalog('en')?.[key])
  if (!text) return text
  const translated = translate(text)
  if (translated !== text || language === 'zh-CN') return translated
  const format = /^当前模型不支持这个(参考图片|参考视频|参考音频)(格式|容器格式|编码)(?:（[^（）\r\n]{0,200}）)?，请转换后重新上传$/.exec(text)
  if (format) return translate('当前模型不支持这个' + format[1] + format[2] + '，请转换后重新上传')
  if (/^当前模型不支持(?:生成模式 |“[^”\r\n]{1,80}”生成模式$)/.test(text)) return translate('当前模型不支持这个生成模式')
  if (/^“(?:标准|节省模式)”生成模式不支持 /.test(text)) return translate('当前模式不支持这个分辨率')
  const numeric = numericPublicMessage(text)
  if (numeric !== undefined) return numeric
  // 已由云端翻译过的词典文案可穿过桌面响应；未知诊断只给安全通用提示。
  if ([catalog(language), catalog('en')].some(entries => entries && Object.values(entries).some((value: string) => value === text || numericMessageValues(value, text)))) return text
  return language === 'zh-TW' ? text : translate('操作失败，请重试')
}

// 只本地化已面向用户公开的错误字段，不递归改写任务、画布、用户文本或落盘记录。
// 调用方先完成错误脱敏，再在响应边界取本次请求语言；不修改原始对象。
export function localizeErrorResponse(value: any, status: number, header: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const locale = resolveRequestLocale(header)
  return runWithLocale(locale, () => {
    const result = { ...value }
    if (status >= 400 || value.ok === false) {
      for (const key of ['error', 'message']) if (typeof value[key] === 'string') result[key] = publicMessage(value[key], locale)
    }
    const explanation = value.errorExplanation
    if (explanation && typeof explanation === 'object' && !Array.isArray(explanation)) {
      result.errorExplanation = { ...explanation }
      for (const key of ['summary', 'reason', 'action', 'billing']) {
        // AI 说明已通过安全校验并按目标语言生成；它是创作结果，不拿词典覆盖正文。
        if (explanation.source === 'ai' && (key === 'reason' || key === 'action')) continue
        if (typeof explanation[key] === 'string') result.errorExplanation[key] = publicMessage(explanation[key], locale)
      }
    }
    return result
  })
}
