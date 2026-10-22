// History display metadata is captured from the submitting canvas, never from
// a later canvas state or another account. It is not forwarded to providers.
export function normalizeReferenceHistory(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  return value.slice(0, 100).flatMap(item => {
    const index = Number(item?.index)
    if (!Number.isSafeInteger(index) || index < 1 || index > 100 || seen.has(index)) return []
    seen.add(index)
    const name = typeof item.name === 'string' ? item.name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200) : ''
    const kind = ['IMAGE', 'VIDEO', 'AUDIO', 'STRING'].includes(item.kind) ? item.kind : ''
    return [{ index, name, kind }]
  })
}

export function historyPrompt(value, referenceHistory) {
  const names = new Map(normalizeReferenceHistory(referenceHistory).map(item => [item.index, item.name]))
  // Old records lack an ordered name snapshot: use a readable index, not a
  // guessed filename/type. Keep raw prompts in generations and provider audit.
  return String(value || '').replace(/\{\{\s*ref\s+([1-9]\d*)\s*\}\}/gi,
    (_, index) => names.get(Number(index)) || `参考素材 ${index}`)
}
