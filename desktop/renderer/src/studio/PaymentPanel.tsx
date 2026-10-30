// @ts-nocheck
import FeedbackNotice from '../components/FeedbackNotice'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { ArrowLeft, Check, CheckCircle, Clock, QrCode, WarningCircle } from '@phosphor-icons/react'
import { useLang } from '../i18n'
import { studioPoint, studioText } from './studioText'
// 支付宝官方标识（Simple Icons，CC0）。
import alipayLogo from './assets/alipay.svg?raw'

// 充值面板：只展示金额与积分，不出现任何模型价格或供应商信息。
// 换算标准由服务端配置提供，在余额区展示；这里核对本次金额与到账积分。

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

export default function PaymentPanel({ payment, csrf, onPaid, onComplete }) {
  const { lang } = useLang()
  const paymentTypes = useMemo(() => {
    const values = Array.isArray(payment?.paymentTypes)
      ? payment.paymentTypes
      : payment?.method && payment.method !== 'zpay' ? [payment.method] : ['alipay']
    const visible = [...new Set(values.filter((value) => PAYMENT_METHOD_LABEL[value]))]
    return visible
  }, [payment])
  const presets = useMemo(() => {
    if (!payment?.minAmountCents || !payment?.maxAmountCents) return []
    return PRESET_AMOUNTS.filter((amount) => amount * 100 >= payment.minAmountCents && amount * 100 <= payment.maxAmountCents && amount * 100 % payment.pointPriceCents === 0)
  }, [payment])
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
    QRCode.toDataURL(order.qrcode, { width: 280, margin: 1, errorCorrectionLevel: 'M', color: { dark: '#141414', light: '#ffffff' } })
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

  const checkout = Boolean(order)
  const payLabel = amountState.points === null ? studioText('生成支付二维码', lang) : studioText('支付 ¥{amount}', lang, { amount: formatMoneyCents(amountState.amountCents).replace(/\.00$/, '') })
  if (!payment?.enabled || !payment?.pointPriceCents || !paymentTypes.length) return <section className="pay pay--unavailable" aria-labelledby="payment-heading"><QrCode size={28} aria-hidden="true" /><h2 id="payment-heading">{studioText('充值积分', lang)}</h2><p>{studioText('充值通道正在配置中，稍后再来。', lang)}</p></section>
  return <section className={`pay${checkout ? ' is-checkout' : ''}`} aria-labelledby="payment-heading">
    <div className="pay__head"><h2 id="payment-heading" className="pay__title">{studioText(checkout ? '扫码支付' : '充值金额', lang)}</h2>
      {order && <span className={`pay__status pay__status--${status}`}>{studioText(STATUS_LABEL[status] || status, lang)}</span>}
    </div>
    {!order ? <div className="pay__setup">
      <div className="pay__selection">
        <div className="pay__amounts" role="group" aria-label={studioText('充值金额', lang)}>{presets.map(value => {
          const selected = amountState.amountCents === value * 100
          return <button key={value} type="button" className={`pay__amount${selected ? ' is-selected' : ''}`} aria-pressed={selected} onClick={() => setAmount(String(value))}>
            <span>¥{value}</span><small>{studioPoint(value * 100 / payment.pointPriceCents, lang)}</small>{selected && <Check className="pay__amount-check" size={14} aria-hidden="true" />}
          </button>
        })}</div>
        <div className="pay__custom"><label htmlFor="payment-amount">{studioText('自定义金额', lang)}</label><div className="pay__field"><span>¥</span><input id="payment-amount" type="number" inputMode="decimal" min={payment.minAmount} max={payment.maxAmount} step={payment.pointPrice} value={amount} onChange={event => setAmount(event.target.value)} aria-describedby="payment-amount-help" /></div>
          <p id="payment-amount-help" className={amountState.message ? 'pay__warn' : 'pay__range'}>{amountState.message || studioText('可充 ¥{min}–¥{max}，按 ¥{step} 的整数倍输入。', lang, {min:yuanLabel(payment.minAmount), max:yuanLabel(payment.maxAmount), step:yuanLabel(payment.pointPrice)})}</p>
        </div>
        <div className="pay__method-section"><h3>{studioText('支付方式', lang)}</h3><div className="pay__methods" role="radiogroup" aria-label={studioText('支付方式', lang)}>{paymentTypes.map(type => <button key={type} type="button" role="radio" aria-checked={paymentType === type} className={`pay__method pay__method--${type}`} onClick={() => setPaymentType(type)}>{type === 'alipay' && <span className="pay__method-logo" aria-hidden="true" dangerouslySetInnerHTML={{__html:alipayLogo}} />}<span>{methodLabel(type)}</span><Check size={14} className="pay__method-check" aria-hidden="true" /></button>)}</div></div>
      </div>
      <aside className="pay__receipt" aria-label={studioText('充值明细', lang)}>
        <div className="pay__receive"><span>{studioText('到账积分', lang)}</span><strong>{amountState.points === null ? '—' : studioPoint(amountState.points, lang)}</strong></div>
        <dl><div><dt>{studioText('充值金额', lang)}</dt><dd>{amountState.amountCents === null ? '—' : '¥' + formatMoneyCents(amountState.amountCents)}</dd></div><div><dt>{studioText('支付方式', lang)}</dt><dd>{methodLabel()}</dd></div></dl>
        <button type="button" className="pay__go" onClick={startOrder} disabled={busy || amountState.points === null}>{busy ? studioText('正在生成支付二维码…', lang) : payLabel}</button>
        <p className="pay__hint">{studioText('支付成功后积分自动到账；如未到账，在支付页点「刷新状态」。', lang)}</p>
      </aside>
    </div> : status === 'created' ? <div className="pay__cashier">
      <div className="pay__scan"><div className="pay__scan-label"><QrCode size={16} aria-hidden="true" />{studioText('请用{method}扫码', lang, {method:methodLabel(order.paymentType)})}</div>
        <div className="pay__qr-frame">{qrSource ? <img className="pay__qr" src={qrSource} alt={studioText('付款二维码', lang)} referrerPolicy="no-referrer" onError={() => setImageFailed(true)} /> : <div className="pay__qr pay__qr--empty"><span>{qrError || studioText('付款码暂时不可用', lang)}</span></div>}</div>
        <p className="pay__timer"><Clock size={13} aria-hidden="true" />{countdownText(order.expiresAt, now, lang)}</p>
      </div>
      <aside className="pay__receipt"><div className="pay__receive"><span>{studioText('应付金额', lang)}</span><strong>¥{money(order)}</strong></div><dl><div><dt>{studioText('到账积分', lang)}</dt><dd>{studioPoint(order.points, lang)}</dd></div><div><dt>{studioText('支付方式', lang)}</dt><dd>{methodLabel(order.paymentType)}</dd></div><div className="pay__order-number"><dt>{studioText('订单号', lang)}</dt><dd title={order.outTradeNo}>{order.outTradeNo}</dd></div></dl>
        <button type="button" className="pay__go" onClick={refreshOrder}>{studioText('我已完成支付 · 刷新状态', lang)}</button><button type="button" className="pay__back" onClick={resetOrder}><ArrowLeft size={13} aria-hidden="true" />{studioText('修改金额', lang)}</button>
      </aside>
    </div> : <div className={`pay__result${status === 'paid' ? ' pay__result--ok' : ''}`} role="status">
      {status === 'paid' ? <><CheckCircle size={44} weight="light" aria-hidden="true" /><h3>{studioText('支付成功，{points} 已到账', lang, {points:studioPoint(order.points, lang)})}</h3><div className="pay__result-actions"><button type="button" className="pay__go" onClick={onComplete || resetOrder}>{studioText('去画布', lang)}</button><button type="button" className="pay__back" onClick={resetOrder}>{studioText('再充一笔', lang)}</button></div></> : <><WarningCircle size={40} weight="light" aria-hidden="true" /><h3>{studioText(STATUS_LABEL[status] || '订单未完成', lang)}</h3><p>{order.failureReason ? publicPaymentError(order.failureReason, lang) : studioText('请重新输入金额。', lang)}</p><button type="button" className="pay__go" onClick={resetOrder}>{studioText('返回充值', lang)}</button></>}
    </div>}
    {error && <FeedbackNotice message={error} action={studioText('重试', lang)} onAction={() => {setError(''); if(order) void refreshOrder();else void startOrder()}} onClose={() => setError('')} />}
  </section>
}
