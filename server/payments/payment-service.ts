import type { ManagementStore } from '../management-store.ts'
import { formatMoney, gatewayUrl, normalizeMoneyForComparison, parsePaymentAmount, paymentConfig, paymentQrPayload, resolvePaymentType, verifyZpaySignature, zpaySign } from '../payment-contract.ts'
import { assertProviderRequestAllowed } from '../provider-safety.ts'
import { runtimeSecret } from '../runtime-secrets.ts'
import { newRequestId, validIdempotencyKey } from '../generation-contract.ts'

type PaymentAccounts = Pick<ManagementStore, 'paymentQrCache' | 'deletePaymentQrCache' | 'savePaymentQrCache' | 'paymentOrderForIdempotency' | 'createPaymentOrder' | 'attachPaymentGateway' | 'failPaymentOrder' | 'completePaymentOrder'>

const PAYMENT_QR_MAX_BYTES = 5 * 1024 * 1024
const PAYMENT_QR_FETCH_TIMEOUT_MS = 8_000

function plain(response, status, body) {
  const value = String(body)
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(value),
  })
  response.end(value)
}

function paymentClientIp(request) {
  const forwarded = String(request.headers['x-real-ip'] || request.headers['x-forwarded-for'] || '').split(',')[0].trim()
  return (forwarded || request.socket.remoteAddress || '').slice(0, 64)
}

export function paymentOrderPayload(order) {
  if (!order) return { ok: true, order }
  const {
    payurl: _payurl,
    payurl2: _payurl2,
    provider: _provider,
    upstreamTradeNo: _upstreamTradeNo,
    ...customerOrder
  } = order
  return {
    ok: true,
    order: {
      ...customerOrder,
      qrcode: order.status === 'created' ? order.qrcode : '',
      img: order.status === 'created' && order.img
        ? `/api/imagine/payment/orders/${encodeURIComponent(order.outTradeNo)}/qrcode`
        : '',
    },
  }
}

function paymentGatewayError(message, status = 503) {
  return Object.assign(new Error(message), { status })
}

function paymentDevice(request) {
  const userAgent = String(request.headers['user-agent'] || '').toLowerCase()
  return /android|iphone|ipad|ipod|mobile/.test(userAgent) ? 'mobile' : 'pc'
}

function isAllowedZpayImageUrl(value, env = process.env) {
  try {
    const url = new URL(String(value || ''))
    if (url.username || url.password) return false
    const hostname = url.hostname.toLowerCase()
    const zpayHost = hostname === 'zpayz.cn' || hostname.endsWith('.zpayz.cn')
    if (url.protocol === 'https:' && zpayHost) return true
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(hostname)
    return env.OIP_PAYMENT_QR_ALLOW_LOOPBACK === 'true' && url.protocol === 'http:' && loopback
  } catch { return false }
}

async function callZpay(order, request, env = process.env) {
  const config = paymentConfig(env)
  if (!config.enabled || !config.configured) throw paymentGatewayError('充值通道尚未配置', 503)
  const params: Record<string, any> = {
    pid: config.pid,
    type: order.paymentType || config.paymentTypes[0],
    out_trade_no: order.outTradeNo,
    notify_url: config.notifyUrl,
    name: order.packageName,
    money: formatMoney(order.amountCents),
    clientip: paymentClientIp(request),
    device: paymentDevice(request),
    sign_type: 'MD5',
    return_url: config.returnUrl,
    param: order.packageId,
  }
  if (config.cid) params.cid = config.cid
  const form = new FormData()
  Object.entries({ ...params, sign: zpaySign(params, config.key) }).forEach(([name, value]) => form.set(name, value))
  let response
  assertProviderRequestAllowed('zpay', config.apiBaseUrl, env)
  try {
    response = await fetch(`${config.apiBaseUrl}/mapi.php`, { method: 'POST', body: form, signal: AbortSignal.timeout(10000) })
  } catch {
    throw paymentGatewayError('支付通道暂时无法连接', 503)
  }
  const text = await response.text()
  let data
  try { data = text ? JSON.parse(text) : {} } catch { throw paymentGatewayError('支付通道返回格式无效', 502) }
  if (!response.ok || String(data.code) !== '1') {
    const reason = String(data.msg || data.message || data.error || `HTTP ${response.status}`).slice(0, 160)
    if (/尚未开通|尚未开启|未开通.*微信|未开启.*微信/.test(reason)) {
      throw paymentGatewayError('微信支付暂不可用', 502)
    }
    throw paymentGatewayError('暂时无法生成付款码，请稍后重试', 502)
  }
  const payurl = gatewayUrl(data.payurl)
  const payurl2 = gatewayUrl(data.payurl2)
  // Some ZPAY channels return only `payurl`. It is still a valid QR payload;
  // keep it as the in-page QR fallback instead of sending the customer to a
  // separate payment page to obtain a code. WeChat native codes are often
  // weixin:// or wxp://, which must stay as QR content rather than jump links.
  const qrcode = paymentQrPayload(data.qrcode) || payurl2 || payurl
  const gatewayImage = gatewayUrl(data.img, { image: true })
  const gateway = {
    payurl: payurl || payurl2 || qrcode,
    payurl2,
    qrcode,
    img: gatewayImage && isAllowedZpayImageUrl(gatewayImage, env) ? gatewayImage : '',
    gatewayOrderId: String(data.O_id || '').slice(0, 200),
    upstreamTradeNo: String(data.trade_no || '').slice(0, 200),
  }
  if (!gateway.payurl && !gateway.qrcode && !gateway.img) throw paymentGatewayError('支付通道没有返回付款入口', 502)
  return gateway
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character])
}

export function paymentReturnPage(order) {
  const status = order?.status || 'created'
  const heading = status === 'paid' ? '支付已确认' : status === 'expired' ? '订单已过期' : status === 'failed' || status === 'closed' ? '支付未完成' : '支付结果确认中'
  const detail = status === 'paid' ? '积分已经到账，可以返回账号页继续使用。' : status === 'created' ? '平台正在处理通知，请回到账号页查看最新状态。' : '可以回到账号页重新输入充值金额。'
  const amount = order ? `¥${escapeHtml(order.amount)}` : '—'
  const number = order ? escapeHtml(order.outTradeNo) : '未找到订单'
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${heading} · 妙图</title><style>body{margin:0;background:#09090b;color:#e2a75b;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:grid;place-items:center;min-height:100vh}main{width:min(520px,calc(100% - 40px));padding:32px;border:1px solid rgb(244 243 238 / .1);border-radius:12px;background:rgb(244 243 238 / .04)}h1{margin:0 0 12px;color:#f4f3ee;font-size:24px}p{color:rgb(244 243 238 / .72)}dl{display:grid;grid-template-columns:96px 1fr;gap:8px;color:rgb(244 243 238 / .72)}dt{color:rgb(244 243 238 / .48)}a{display:inline-block;margin-top:24px;padding:10px 18px;border-radius:999px;background:#e2a75b;color:#09090b;text-decoration:none;font-weight:600}</style><main><h1>${heading}</h1><p>${detail}</p><dl><dt>订单号</dt><dd>${number}</dd><dt>金额</dt><dd>${amount}</dd></dl><a href="/">返回妙图账号页</a></main></html>`
}

function paymentQrMime(value) {
  const mime = String(value || '').split(';')[0].trim().toLowerCase()
  if (mime === 'image/jpg') return 'image/jpeg'
  return ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mime) ? mime : ''
}

function validPaymentQrCache(order, entry) {
  return Boolean(
    entry
    && entry.outTradeNo === order.outTradeNo
    && entry.expiresAt === order.expiresAt
    && Date.parse(entry.expiresAt) > Date.now()
    && paymentQrMime(entry.mime)
    && entry.bytes?.length > 0
    && entry.bytes.length <= PAYMENT_QR_MAX_BYTES,
  )
}

async function fetchZpayQrImage(imageUrl: string, env = process.env) {
  let current = imageUrl
  for (let hop = 0; hop < 2; hop++) {
    let upstream: Response
    try {
      upstream = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(PAYMENT_QR_FETCH_TIMEOUT_MS) })
    } catch {
      throw paymentGatewayError('付款二维码暂时无法读取', 502)
    }
    if (upstream.status >= 300 && upstream.status < 400) {
      await upstream.body?.cancel().catch(() => {})
      const location = String(upstream.headers.get('location') || '').trim()
      let next = ''
      try { next = new URL(location, current).toString() } catch { next = '' }
      if (!next || !isAllowedZpayImageUrl(next, env)) throw paymentGatewayError('付款二维码暂时无法读取', 502)
      assertProviderRequestAllowed('zpay-qr', next, env)
      current = next
      continue
    }
    return upstream
  }
  throw paymentGatewayError('付款二维码暂时无法读取', 502)
}

export async function readPaymentQrImage(imageUrl: string, env = process.env) {
  if (!isAllowedZpayImageUrl(imageUrl, env)) throw paymentGatewayError('付款二维码来源不受支持', 502)
  assertProviderRequestAllowed('zpay-qr', imageUrl, env)
  const upstream = await fetchZpayQrImage(imageUrl, env)
  try {
    if (!upstream.ok) throw paymentGatewayError('付款二维码暂时无法读取', 502)
    const mime = paymentQrMime(upstream.headers.get('content-type'))
    if (!mime) throw paymentGatewayError('上游没有返回受支持的二维码图片', 502)
    const length = Number(upstream.headers.get('content-length') || 0)
    if (length > PAYMENT_QR_MAX_BYTES) throw paymentGatewayError('付款二维码文件过大', 502)
    if (!upstream.body) throw paymentGatewayError('付款二维码暂时无法读取', 502)
    const chunks = []
    let total = 0
    try {
      for await (const chunk of upstream.body) {
        total += chunk.length
        if (total > PAYMENT_QR_MAX_BYTES) throw paymentGatewayError('付款二维码文件过大', 502)
        chunks.push(chunk)
      }
    } catch (error) {
      if (error?.status) throw error
      throw paymentGatewayError('付款二维码暂时无法读取', 502)
    }
    const bytes = Buffer.concat(chunks)
    if (!bytes.length || bytes.length > PAYMENT_QR_MAX_BYTES) throw paymentGatewayError('付款二维码文件过大', 502)
    return { bytes, mime }
  } finally {
    if (upstream.body && !upstream.body.locked) await upstream.body.cancel().catch(() => {})
  }
}

// Payment orchestration reuses the host's account ledger; importing this module
// opens no database or network listener. QR reads share one in-flight request per order.
export function createPaymentService({ management }: { management: PaymentAccounts }) {
  const paymentQrFetches = new Map()

  async function fetchPaymentQrImage(order, env = process.env) {
    const cached = (await management.paymentQrCache(order.outTradeNo))
    if (validPaymentQrCache(order, cached)) return { bytes: cached.bytes, mime: paymentQrMime(cached.mime) }
    if (cached) await management.deletePaymentQrCache(order.outTradeNo)
    const { bytes, mime } = await readPaymentQrImage(order.img, env)
    await management.savePaymentQrCache({ outTradeNo: order.outTradeNo, mime, bytes, expiresAt: order.expiresAt })
    return { bytes, mime }
  }

  async function paymentQrImage(order, env = process.env) {
    const current = paymentQrFetches.get(order.outTradeNo)
    if (current) return current
    const pending = fetchPaymentQrImage(order, env)
    paymentQrFetches.set(order.outTradeNo, pending)
    try { return await pending } finally { paymentQrFetches.delete(order.outTradeNo) }
  }

  async function createPaymentOrder(payload, session, request, env = process.env) {
    if (session?.role !== 'user') throw paymentGatewayError('请先登录再充值', 401)
    const idempotencyKey = String(payload?.idempotencyKey || '').trim() || newRequestId()
    if (!validIdempotencyKey(idempotencyKey)) throw paymentGatewayError('请求标识无效', 422)
    const config = paymentConfig(env)
    const requestedPaymentType = String(payload?.paymentType || payload?.type || '').trim()
    const paymentType = resolvePaymentType(requestedPaymentType, config)
    if (String(requestedPaymentType).trim().toLowerCase() === 'wxpay' || paymentType === 'wxpay') throw paymentGatewayError('微信支付暂不可用', 422)
    if (!paymentType) throw paymentGatewayError('所选支付方式暂不可用', 422)
    const existing = (await management.paymentOrderForIdempotency(session.userId, idempotencyKey))
    if (existing) {
      const requestedAmount = normalizeMoneyForComparison(payload?.amount)
      if (requestedAmount === null || requestedAmount !== existing.amountCents) throw paymentGatewayError('同一请求标识不能更换充值金额', 409)
      if (requestedPaymentType && existing.paymentType !== paymentType) throw paymentGatewayError('同一请求标识不能更换充值方式', 409)
      return existing
    }
    if (!config.enabled || !config.configured) throw paymentGatewayError('充值通道尚未配置', 503)
    const amount = parsePaymentAmount(payload?.amount, config)
    if (amount.error) throw paymentGatewayError(amount.error, 422)
    const expiresAt = new Date(Date.now() + config.orderTtlSeconds * 1000).toISOString()
    const packageId = `amount-${amount.amountCents}`
    const order = (await management.createPaymentOrder({
      userId: session.userId,
      packageId,
      packageName: `${amount.points} 积分`,
      points: amount.points,
      amountCents: amount.amountCents,
      paymentType,
      expiresAt,
      merchantPid: config.pid,
      idempotencyKey,
    }))
    if (order.duplicate) return order
    try {
      const gateway = await callZpay(order, request, env)
      return (await management.attachPaymentGateway(order.outTradeNo, gateway))
    } catch (error) {
      await management.failPaymentOrder(order.outTradeNo, error.message)
      throw error
    }
  }

  async function handlePaymentNotify(url, response, env = process.env) {
    const params = Object.fromEntries(url.searchParams.entries())
    const merchantPid = runtimeSecret('ZPAY_PID', env)
    const merchantKey = runtimeSecret('ZPAY_KEY', env)
    if (!merchantPid || !merchantKey || params.pid !== merchantPid || params.sign_type !== 'MD5' || !params.out_trade_no || !params.trade_status) {
      plain(response, 400, 'fail')
      return
    }
    if (!verifyZpaySignature(params, merchantKey)) {
      plain(response, 400, 'fail')
      return
    }
    const amountCents = normalizeMoneyForComparison(params.money)
    if (amountCents === null) {
      plain(response, 400, 'fail')
      return
    }
    const result = (await management.completePaymentOrder({
      outTradeNo: params.out_trade_no,
      amountCents,
      tradeNo: params.trade_no,
      tradeStatus: params.trade_status,
      type: params.type,
      merchantPid: params.pid,
    }))
    if (result.kind === 'paid' || result.kind === 'duplicate' || result.kind === 'non_success' || result.kind === 'ignored') {
      plain(response, 200, 'success')
      return
    }
    plain(response, 400, 'fail')
  }

  return { createPaymentOrder, handlePaymentNotify, paymentQrImage }
}
