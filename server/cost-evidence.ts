// Price calculations and balance observations never prove a per-request invoice.
export function finiteCost(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null
}
export function costEvidence(cost) {
  if (finiteCost(cost?.rmb) === null) return { level:'unknown', label:'成本未知', invoiceVerified:false }
  const source=cost?.detail?.source
  const usage=source==='upstream_usage' || /(?:reported_tokens|token_list_price)/.test(cost?.basis || '')
  const forecast=source==='parameter_estimate' || /(?:forecast)/.test(cost?.basis || '')
  return { level:usage?'usage_estimate':forecast?'parameter_estimate':'price_reference',
    label:usage?'上游用量推算':forecast?'参数预估':'价目参考推算', invoiceVerified:false }
}
