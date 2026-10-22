// @ts-nocheck
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { useLang } from '../i18n'
import { studioPoint, studioPointParts, studioText } from './studioText'

// 充值面板：只展示金额与积分，不出现任何模型价格或供应商信息。
// 换算口径全前端只有一处措辞（「1 积分 = 1 元」），写在余额卡里；
// 这里也不再估算"能生成多少张/多少秒"——用户明确不要那行换算。

const STATUS_LABEL = {
  created: '待支付',
  paid: '已支付',
  closed: '已关闭',
  failed: '支付失败',
  expired: '已过期',
}

// 中文原文是 studioText 的词典键，英文在词典里。
const PAYMENT_METHOD_LABEL: Record<string, { label: string }> = {
  alipay: { label: '支付宝' },
}

const TERMINAL = new Set(['paid', 'closed', 'failed', 'expired'])
const PRESET_AMOUNTS = [10, 30, 50, 100, 300, 500]

function money(order) {
  return order?.amount || (Number.isFinite(order?.amountCents) ? (order.amountCents / 100).toFixed(2) : '—')
}

function parseMoneyCents(value) {
  const text = String(value ?? '').trim()
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null
  const [yuan, fraction = ''] = text.split('.')
  const cents = Number(yuan) * 100 + Number(fraction.padEnd(2, '0'))
  return Number.isSafeInteger(cents) ? cents : null
}

function formatMoneyCents(cents) {
  const value = Number(cents || 0)
  return (value / 100).toFixed(2)
}

function yuanLabel(value) {
  const text = String(value ?? '')
  return text.endsWith('.00') ? text.slice(0, -3) : text
}

function publicPaymentError(message, lang) {
  const text = String(message || '').trim()
  if (/ZPAY|商户后台|开户|尚未开通|未开通|未开启|渠道失败|微信|wxpay|weixin/i.test(text)) {
    return studioText('所选支付方式暂不可用', lang)
  }
  return studioText(text || '充值订单创建失败', lang)
}

function countdownText(expiresAt, now, lang) {
  const end = new Date(expiresAt || 0).getTime()
  if (!Number.isFinite(end) || end <= 0) return ''
  const left = Math.max(0, Math.floor((end - now) / 1000))
  const minutes = String(Math.floor(left / 60)).padStart(2, '0')
  const seconds = String(left % 60).padStart(2, '0')
  if (left <= 0) return studioText('已过期', lang)
  return studioText('剩余 {time}', lang, { time: `${minutes}:${seconds}` })
}

export default function PaymentPanel({ payment, csrf, onPaid, points }) {
  const { lang } = useLang()
  const paymentTypes = useMemo(() => {
    const values = Array.isArray(payment?.paymentTypes) && payment.paymentTypes.length
      ? payment.paymentTypes
      : payment?.method && payment.method !== 'zpay' ? [payment.method] : ['alipay']
    const visible = [...new Set(values.filter((value) => PAYMENT_METHOD_LABEL[value]))]
    return visible.length ? visible : ['alipay']
  }, [payment])
  const presets = useMemo(() => {
    if (!payment?.minAmountCents || !payment?.maxAmountCents) return []
    return PRESET_AMOUNTS.filter((amount) => amount * 100 >= payment.minAmountCents && amount * 100 <= payment.maxAmountCents)
  }, [payment])
  // 「推荐」档：没有配置项，取套餐列表的中间那一档（当前 6 档 → ¥50）。
  // 档位数量变了它会跟着变，不是写死的金额；以后要按运营配置改，从这里换数据源即可。
  const recommended = presets[Math.floor((presets.length - 1) / 2)] ?? null
  const [amount, setAmount] = useState(() => presets[0] ? String(presets[0]) : String(payment?.minAmount || ''))
  const [paymentType, setPaymentType] = useState(paymentTypes[0] || 'alipay')
  const [order, setOrder] = useState(null)
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [imageFailed, setImageFailed] = useState(false)
  const [qrError, setQrError] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const orderAttemptRef = useRef({ amount: '', paymentType: '', key: '' })

  const amountState = useMemo(() => {
    if (!payment?.pointPriceCents) return { amountCents: null, points: null, message: '' }
    const amountCents = parseMoneyCents(amount)
    if (amountCents === null) return { amountCents: null, points: null, message: studioText('请输入金额', lang) }
    if (amountCents < payment.minAmountCents) return { amountCents, points: null, message: studioText('最低充值 ¥{amount}', lang, { amount: payment.minAmount }) }
    if (amountCents > payment.maxAmountCents) return { amountCents, points: null, message: studioText('最高充值 ¥{amount}', lang, { amount: payment.maxAmount }) }
    if (amountCents % payment.pointPriceCents !== 0) return { amountCents, points: null, message: studioText('金额需为 ¥{amount} 的整数倍', lang, { amount: payment.pointPrice }) }
    return { amountCents, points: amountCents / payment.pointPriceCents, message: '' }
  }, [amount, lang, payment])

  const status = order?.status || ''
  const qrImagePath = order?.img && order?.outTradeNo
    ? `./api/imagine/payment/orders/${encodeURIComponent(order.outTradeNo)}/qrcode`
    : ''
  const qrSource = qrDataUrl || (qrImagePath && !imageFailed ? qrImagePath : '')

  useEffect(() => {
    if (!amount && payment?.minAmount) setAmount(String(presets[0] || payment.minAmount))
  }, [amount, payment?.minAmount, presets])

  useEffect(() => {
    if (paymentTypes.length && !paymentTypes.includes(paymentType)) setPaymentType(paymentTypes[0])
  }, [paymentType, paymentTypes])

  useEffect(() => {
    setQrDataUrl('')
    setQrError('')
    setImageFailed(false)
  }, [order?.outTradeNo])

  useEffect(() => {
    if (!order || TERMINAL.has(order.status)) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [order])

  useEffect(() => {
    if (!order?.qrcode) return undefined
    let active = true
    QRCode.toDataURL(order.qrcode, { width: 280, margin: 1, errorCorrectionLevel: 'M', color: { dark: '#09090b', light: '#f4f3ee' } })
      .then((url) => { if (active) { setQrDataUrl(url); setQrError('') } })
      .catch(() => { if (active) setQrError(studioText('付款二维码暂时不可用，请稍后重试', lang)) })
    return () => { active = false }
  }, [lang, order?.qrcode])

  const refreshOrder = useCallback(async () => {
    if (!order?.outTradeNo) return null
    try {
      const response = await fetch(`./api/imagine/payment/orders/${encodeURIComponent(order.outTradeNo)}`)
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || studioText('订单状态读取失败', lang))
      setOrder(data.order)
      if (data.order.status === 'paid') await onPaid?.()
      return data.order
    } catch (pollError) {
      setError(pollError.message)
      return null
    }
  }, [lang, onPaid, order?.outTradeNo])

  useEffect(() => {
    if (!order?.outTradeNo || TERMINAL.has(order.status)) return undefined
    let active = true
    let timer
    const poll = async () => {
      if (!active) return
      const next = await refreshOrder()
      if (!active) return
      if (!next || !TERMINAL.has(next.status)) timer = window.setTimeout(poll, 3000)
    }
    timer = window.setTimeout(poll, 2500)
    return () => { active = false; window.clearTimeout(timer) }
  }, [order?.outTradeNo, order?.status, refreshOrder])

  async function startOrder() {
    if (amountState.amountCents === null || amountState.points === null || busy) return
    setBusy(true)
    setError('')
    const amountText = formatMoneyCents(amountState.amountCents)
    if (orderAttemptRef.current.amount !== amountText || orderAttemptRef.current.paymentType !== paymentType || !orderAttemptRef.current.key) {
      orderAttemptRef.current = { amount: amountText, paymentType, key: crypto.randomUUID() }
    }
    try {
      const response = await fetch('./api/imagine/payment/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf || '' },
        body: JSON.stringify({ amount: amountText, paymentType, idempotencyKey: orderAttemptRef.current.key }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(publicPaymentError(data.error, lang))
      setNow(Date.now())
      setOrder(data.order)
    } catch (createError) {
      setError(createError.message)
    } finally {
      setBusy(false)
    }
  }

  function resetOrder() {
    setOrder(null)
    setError('')
    orderAttemptRef.current = { amount: '', paymentType: '', key: '' }
  }

  function methodLabel(type = paymentType) {
    return studioText(PAYMENT_METHOD_LABEL[type]?.label || '支付', lang)
  }

  const balance = (
    <header className="pay__balance">
      <div>
        <p className="pay__kicker">{studioText('当前余额', lang)}</p>
        <p className="pay__figure">
          <strong>{Number.isFinite(points) ? studioPointParts(points, lang).value : '—'}</strong>
          <span>{Number.isFinite(points) ? studioPointParts(points, lang).unit : studioText('积分', lang)}</span>
        </p>
      </div>
      <p className="pay__rate">{studioText('1 积分 = 1 元', lang)}</p>
    </header>
  )

  if (!payment?.enabled || !payment?.pointPriceCents) {
    return (
      <section className="pay" aria-labelledby="payment-heading">
        <h2 id="payment-heading" className="pay__title">{studioText('充值积分', lang)}</h2>
        {balance}
        <p className="pay__hint">{studioText('充值通道正在配置中，稍后再来。', lang)}</p>
      </section>
    )
  }

  const payLabel = amountState.points === null
    ? studioText('生成支付二维码', lang)
    : studioText('支付 ¥{amount}', lang, { amount: formatMoneyCents(amountState.amountCents).replace(/\.00$/, '') })

  return (
    <section className="pay" aria-labelledby="payment-heading">
      <div className="pay__head">
        <h2 id="payment-heading" className="pay__title">{studioText('充值积分', lang)}</h2>
        {order && <span className={`pay__status pay__status--${status}`}>{studioText(STATUS_LABEL[status] || status, lang)}</span>}
      </div>
      {balance}
      <p className="pay__hint">{studioText('积分用于画布上的图片和视频生成：按次扣费，生成失败自动退回。', lang)}</p>

      {!order && (
        <>
          <div className="pay__amounts" role="group" aria-label={studioText('充值金额', lang)}>
            {presets.map((value) => {
              const selected = Number(amount) === value
              return (
                <button key={value} type="button" className={`pay__amount${selected ? ' is-selected' : ''}`} aria-pressed={selected} onClick={() => setAmount(String(value))}>
                  <span>¥{value}</span>
                  {value === recommended && !selected ? <small>{studioText('推荐', lang)}</small> : null}
                </button>
              )
            })}
          </div>
          <div className="pay__custom">
            <label htmlFor="payment-amount">{studioText('自定义金额', lang)}</label>
            <div className="pay__field">
              <span>¥</span>
              <input id="payment-amount" type="number" inputMode="decimal" min={payment.minAmount} max={payment.maxAmount} step={payment.pointPrice} value={amount} onChange={(event) => setAmount(event.target.value)} aria-describedby="payment-amount-help" />
            </div>
            <p id="payment-amount-help" className={amountState.message ? 'pay__warn' : 'pay__arrive'}>
              {amountState.message || studioText('到账 {points}', lang, { points: studioPoint(amountState.points, lang) })}
            </p>
          </div>
          <p className="pay__range">{studioText('可充 ¥{min}–¥{max}，按 ¥{step} 的整数倍输入。', lang, { min: yuanLabel(payment.minAmount), max: yuanLabel(payment.maxAmount), step: yuanLabel(payment.pointPrice) })}</p>
          {paymentTypes.length > 0 && (
            <div className="pay__methods" role="radiogroup" aria-label={studioText('支付方式', lang)}>
              {paymentTypes.map((type) => (
                <button key={type} type="button" role="radio" aria-checked={paymentType === type} className={`pay__method pay__method--${type}`} onClick={() => setPaymentType(type)}>
                  {type === 'alipay' ? <i aria-hidden="true" /> : null}
                  <span>{methodLabel(type)}</span>
                </button>
              ))}
            </div>
          )}
          <button type="button" className="pay__go" onClick={startOrder} disabled={busy || amountState.points === null}>
            {busy ? studioText('正在生成支付二维码…', lang) : payLabel}
          </button>
          <p className="pay__hint">{studioText('支付成功后积分自动到账；如未到账，在支付页点「刷新状态」。', lang)}</p>
        </>
      )}

      {order && status === 'created' && (
        <div className="pay__checkout">
          <p className="pay__due">¥{money(order)}</p>
          <p className="pay__due-note">{studioText('请用{method}扫码', lang, { method: methodLabel(order.paymentType) })} · {studioText('到账 {points}', lang, { points: studioPoint(order.points, lang) })}</p>
          {qrSource
            ? <img className="pay__qr" src={qrSource} alt={studioText('付款二维码', lang)} referrerPolicy="no-referrer" onError={() => setImageFailed(true)} />
            : <div className="pay__qr pay__qr--empty"><span>{qrError || studioText('付款码暂时不可用', lang)}</span></div>}
          <p className="pay__meta"><span>{countdownText(order.expiresAt, now, lang)}</span><span>{order.outTradeNo}</span></p>
          <button type="button" className="pay__go" onClick={refreshOrder}>{studioText('我已完成支付 · 刷新状态', lang)}</button>
          <button type="button" className="pay__back" onClick={resetOrder}>{studioText('修改金额', lang)}</button>
        </div>
      )}

      {order && status !== 'created' && (
        <div className="pay__checkout">
          {status === 'paid' && <div className="pay__result pay__result--ok"><strong>{studioText('支付成功，{points} 已到账', lang, { points: studioPoint(order.points, lang) })}</strong><span>{studioText('余额已刷新，可以继续使用妙图。', lang)}</span></div>}
          {TERMINAL.has(status) && status !== 'paid' && <div className="pay__result"><strong>{studioText(STATUS_LABEL[status] || '订单未完成', lang)}</strong><span>{order.failureReason ? publicPaymentError(order.failureReason, lang) : studioText('请重新输入金额。', lang)}</span></div>}
          <button type="button" className="pay__go" onClick={resetOrder}>{studioText('再充一笔', lang)}</button>
        </div>
      )}

      {error && <div className="studio-banner studio-banner--error pay__error" role="alert"><span>{error}</span><button type="button" className="pay__retry" onClick={() => { setError(''); if (order) void refreshOrder(); }}>{studioText('重试', lang)}</button></div>}
    </section>
  )
}
