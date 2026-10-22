function record(value: unknown, message: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message)
  return value as Record<string, any>
}

function mergeRecord(current: unknown, patch: unknown, message: string) {
  const update = record(patch, message)
  // An explicitly empty object retains the existing reset contract. An omitted
  // field is handled by the caller and leaves the current setting untouched.
  if (!Object.keys(update).length) return {}
  const base = current && typeof current === 'object' && !Array.isArray(current) ? current : {}
  return { ...structuredClone(base), ...structuredClone(update) }
}

function mergeVideoTiers(current: unknown, patch: unknown) {
  const merged = mergeRecord(current, patch, '视频计费无效')
  const updates = new Map<string, unknown>()
  for (const [key, value] of Object.entries(record(patch, '视频计费无效'))) {
    const canonical = key.toLowerCase()
    if (updates.has(canonical) && JSON.stringify(updates.get(canonical)) !== JSON.stringify(value)) throw new Error('视频计费无效')
    updates.set(canonical, structuredClone(value))
  }
  // Video tier lookup and validation are case-insensitive. An incoming alias
  // must replace the existing tier rather than leave two competing spellings.
  const entries = Object.entries(merged).filter(([key]) => !updates.has(key.toLowerCase()))
  return Object.fromEntries([...entries, ...updates])
}

// Admin forms submit only changed leaves. Merge against the value read inside
// the write transaction; normalization and model/tier validation follow this.
export function mergeOperatingSettings(current: Record<string, any>, patch: Record<string, any>) {
  const next = { ...structuredClone(current), ...structuredClone(patch) }
  const owns = (key: string) => Object.prototype.hasOwnProperty.call(patch, key)
  if (owns('models')) next.models = mergeRecord(current.models, patch.models, '模型设置无效')
  if (owns('videoPricing')) next.videoPricing = mergeRecord(current.videoPricing, patch.videoPricing, '视频定价设置无效')
  if (owns('textPrices') && patch.textPrices !== null) {
    next.textPrices = mergeRecord(current.textPrices, patch.textPrices, '文本模型计费设置无效')
    for (const [id, update] of Object.entries(patch.textPrices)) {
      next.textPrices[id] = mergeRecord(current.textPrices?.[id], update, '文本模型计费设置无效')
    }
  }
  if (owns('prices')) {
    next.prices = mergeRecord(current.prices, patch.prices, '计费设置无效')
    for (const [id, raw] of Object.entries(patch.prices)) {
      const update = record(raw, '计费设置无效')
      next.prices[id] = mergeRecord(current.prices?.[id], update, '计费设置无效')
      for (const kind of ['image', 'video']) {
        if (!Object.prototype.hasOwnProperty.call(update, kind)) continue
        const value = update[kind]
        // A scalar still sets every image size. Moving to a nonempty tier
        // table retains that rate for sizes not included in the patch.
        if (kind === 'image' && typeof value === 'number') continue
        const previous = current.prices?.[id]?.[kind]
        const table = kind === 'video' ? mergeVideoTiers(previous, value)
          : mergeRecord(previous, value, '图片计费无效')
        next.prices[id][kind] = kind === 'image' && typeof previous === 'number' && Object.keys(table).length
          ? { default: previous, ...table } : table
      }
    }
  }
  return next
}
