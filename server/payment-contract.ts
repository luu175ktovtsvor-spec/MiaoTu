import { runtimeSecret } from './runtime-secrets.ts'
import { assertProviderRequestAllowed } from './provider-safety.ts'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export const PAYMENT_STATES = Object.freeze({
  CREATED: 'created',
  PAID: 'paid',
  CLOSED: 'closed',
  FAILED: 'failed',
  EXPIRED: 'expired',
})

export const PAYMENT_TYPE = 'alipay'
export const SUPPORTED_PAYMENT_TYPES = Object.freeze(['alipay', 'wxpay'])
export const PAYMENT_PROVIDER = 'zpay'
export const DEFAULT_ZPAY_BASE_URL = 'https://zpayz.cn'
export const DEFAULT_NOTIFY_URL = 'https://miaoimg.cn/api/imagine/payment/notify'
export const DEFAULT_RETURN_URL = 'https://miaoimg.cn/api/imagine/payment/return'

const terminalStates = new Set([
  PAYMENT_STATES.PAID,
  PAYMENT_STATES.CLOSED,
  PAYMENT_STATES.FAILED,
  PAYMENT_STATES.EXPIRED,
])

export function isPaymentTerminal(status) {
  return terminalStates.has(status)
}

export function newPaymentOrderNo(now = Date.now()) {
  const timestamp = now.toString(36).toUpperCase()
  const random = randomBytes(7).toString('hex').toUpperCase()
  return `MI${timestamp}${random}`.slice(0, 32)
}

export function parseMoneyToCents(value) {
  const text = String(value ?? '').trim()
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null
  const [yuan, fraction = ''] = text.split('.')
  const cents = Number(yuan) * 100 + Number(fraction.padEnd(2, '0'))
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null
}

export function formatMoney(cents) {
  const value = Number(cents)
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('金额无效')
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, '0')}`
}

export function normalizeMoneyForComparison(value) {
  const cents = parseMoneyToCents(value)
  return cents === null ? null : cents
}

export function zpaySign(params, key) {
  const entries = Object.entries(params || {})
    .filter(([name, value]) => name !== 'sign' && name !== 'sign_type' && value !== undefined && value !== null && String(value) !== '')
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  const source = `${entries.map(([name, value]) => `${name}=${String(value)}`).join('&')}${String(key || '')}`
  return createHash('md5').update(source, 'utf8').digest('hex')
}

export function verifyZpaySignature(params, key) {
  const received = String(params?.sign || '').toLowerCase()
  if (!/^[a-f0-9]{32}$/.test(received) || !key) return false
  const expected = zpaySign(params, key)
  return timingSafeEqual(Buffer.from(received, 'ascii'), Buffer.from(expected, 'ascii'))
}

export function normalizePaymentType(value) {
  const type = String(value || '').trim().toLowerCase()
  return SUPPORTED_PAYMENT_TYPES.includes(type) ? type : ''
}

function configuredPaymentTypes(env) {
  const raw = env.ZPAY_PAYMENT_TYPES || env.ZPAY_PAYMENT_TYPE || PAYMENT_TYPE
  const types = [...new Set(String(raw).split(',').map(normalizePaymentType).filter(Boolean))]
  if (!types.length) throw new Error('ZPAY_PAYMENT_TYPES 无效，需要 alipay 或 wxpay')
  return types
}

export function resolvePaymentType(value, config) {
  const paymentTypes = Array.isArray(config?.paymentTypes) && config.paymentTypes.length ? config.paymentTypes : [PAYMENT_TYPE]
  const requested = String(value || '').trim()
  if (!requested) return paymentTypes[0] || ''
  const normalized = normalizePaymentType(requested)
  return normalized && paymentTypes.includes(normalized) ? normalized : ''
}

function integer(value, name, { min = 0, max = 100000000 }: Record<string, any> = {}) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`${name}无效`)
  return number
}

function normalizeEndpoint(value, fallback, name) {
  const text = String(value || fallback).trim()
  let url
  try { url = new URL(text) } catch { throw new Error(`${name} 不是有效 URL`) }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.search || url.hash || url.username || url.password) throw new Error(`${name} 必须是不带参数的 HTTPS URL（本地测试可用 HTTP）`)
  return url.toString().replace(/\/$/, '')
}

export function paymentConfig(env = process.env) {
  const pid = runtimeSecret('ZPAY_PID', env)
  const key = runtimeSecret('ZPAY_KEY', env)
  const enabled = env.ZPAY_ENABLED === undefined ? Boolean(pid && key) : env.ZPAY_ENABLED === 'true'
  // 积分与人民币 1:1：1 积分 = ¥1.00，充值金额与到账积分完全对应。
  const pointPriceCents = integer(env.ZPAY_POINT_PRICE_CENTS || 100, 'ZPAY_POINT_PRICE_CENTS', { min: 1, max: 100000 })
  const minPoints = integer(env.ZPAY_MIN_POINTS || 10, 'ZPAY_MIN_POINTS', { min: 1, max: 1000000 })
  const maxPoints = integer(env.ZPAY_MAX_POINTS || 1000, 'ZPAY_MAX_POINTS', { min: minPoints, max: 1000000 })
  const orderTtlSeconds = integer(env.ZPAY_ORDER_TTL_SECONDS || 900, 'ZPAY_ORDER_TTL_SECONDS', { min: 60, max: 86400 })
  const paymentTypes = configuredPaymentTypes(env)
  const apiBaseUrl = normalizeEndpoint(env.ZPAY_BASE_URL, DEFAULT_ZPAY_BASE_URL, 'ZPAY_BASE_URL')
  assertProviderRequestAllowed('zpay', apiBaseUrl, env)
  return {
    enabled,
    configured: Boolean(pid && key),
    pid,
    key,
    apiBaseUrl,
    notifyUrl: normalizeEndpoint(env.ZPAY_NOTIFY_URL, DEFAULT_NOTIFY_URL, 'ZPAY_NOTIFY_URL'),
    returnUrl: normalizeEndpoint(env.ZPAY_RETURN_URL, DEFAULT_RETURN_URL, 'ZPAY_RETURN_URL'),
    orderTtlSeconds,
    pointPriceCents,
    minPoints,
    maxPoints,
    paymentTypes,
    minAmountCents: pointPriceCents * minPoints,
    maxAmountCents: pointPriceCents * maxPoints,
    cid: String(env.ZPAY_CID || '').trim(),
  }
}

export function publicPaymentConfig(config) {
  const configured = Array.isArray(config.paymentTypes) && config.paymentTypes.length ? config.paymentTypes : [PAYMENT_TYPE]
  const paymentTypes = configured.filter((type) => type !== 'wxpay')
  const advertised = paymentTypes.length ? paymentTypes : [PAYMENT_TYPE]
  return {
    enabled: Boolean(config.enabled && config.configured),
    method: advertised.length === 1 ? advertised[0] : PAYMENT_PROVIDER,
    paymentTypes: advertised,
    orderTtlSeconds: config.orderTtlSeconds,
    pointPriceCents: config.pointPriceCents,
    pointPrice: formatMoney(config.pointPriceCents),
    minPoints: config.minPoints,
    maxPoints: config.maxPoints,
    minAmountCents: config.minAmountCents,
    maxAmountCents: config.maxAmountCents,
    minAmount: formatMoney(config.minAmountCents),
    maxAmount: formatMoney(config.maxAmountCents),
  }
}

export function parsePaymentAmount(value, config) {
  const amountCents = parseMoneyToCents(value)
  if (amountCents === null) return { error: '充值金额必须是最多两位小数的正数' }
  if (amountCents < config.minAmountCents) return { error: `充值金额不能低于 ¥${formatMoney(config.minAmountCents)}` }
  if (amountCents > config.maxAmountCents) return { error: `充值金额不能高于 ¥${formatMoney(config.maxAmountCents)}` }
  if (amountCents % config.pointPriceCents !== 0) return { error: `充值金额必须是 ¥${formatMoney(config.pointPriceCents)} 的整数倍` }
  return { amountCents, points: amountCents / config.pointPriceCents }
}

const PAYMENT_QR_PROTOCOLS = Object.freeze(['alipays:', 'weixin:', 'wxp:', 'wxpay:'])

export function gatewayUrl(value, { image = false }: Record<string, any> = {}) {
  const text = String(value || '').trim()
  if (!text) return ''
  try {
    const url = new URL(text)
    if (url.username || url.password) return ''
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    const allowed = url.protocol === 'https:' || (local && url.protocol === 'http:') || (!image && PAYMENT_QR_PROTOCOLS.includes(url.protocol))
    return allowed ? url.toString() : ''
  } catch {
    return ''
  }
}

// ZPAY 的 qrcode 是「用来生成二维码的内容」，微信常返回 weixin:// 或 wxp://，
// 不是必须能打开的 https 页面。图片地址仍走 gatewayUrl({ image: true })。
export function paymentQrPayload(value) {
  const text = String(value || '').trim()
  if (!text || text.length > 2048 || /[\u0000-\u001F\u007F]/.test(text)) return ''
  return gatewayUrl(text) || (/^(?:weixin|wxp|wxpay):\/\//i.test(text) ? text : '')
}
