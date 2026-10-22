import { randomUUID } from 'node:crypto'

const SAFE_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

export function supportedImageMime(value) {
  const mime = String(value || '').split(';')[0].trim().toLowerCase()
  const normalized = mime === 'image/jpg' ? 'image/jpeg' : mime
  return SAFE_IMAGE_MIMES.has(normalized) ? normalized : ''
}

export function byteRange(header, length) {
  if (!header) return null
  const match = /^bytes=(\d+)-(\d*)$/.exec(header)
  if (!match) return false
  const start = Number(match[1])
  const end = Math.min(match[2] ? Number(match[2]) : length - 1, length - 1)
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= end && start < length ? { start, end } : false
}

export function imageMime(bytes, fallback = 'image/png') {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (bytes[0] === 255 && bytes[1] === 216) return 'image/jpeg'
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  return supportedImageMime(fallback) || 'image/png'
}

export function createResultCache({ ttl = 30 * 60 * 1000, maxBytes = 96 * 1024 * 1024, maxEntries = 64, now = Date.now }: Record<string, any> = {}) {
  const entries = new Map()
  let total = 0
  function remove(id) { const value = entries.get(id); if (value) total -= value.bytes?.length || 0; entries.delete(id) }
  function prune() { for (const [id, entry] of entries) if (now() - entry.createdAt >= ttl) remove(id) }
  return {
    put(image) {
      prune()
      const entry: Record<string, any> = { createdAt: now(), remoteUrl: image.url }
      if (image.url.startsWith('data:')) {
        const match = /^data:(image\/[^;]+);base64,(.*)$/s.exec(image.url)
        if (!match) throw new Error('生成图片格式无效')
        const declaredMime = supportedImageMime(match[1])
        if (!declaredMime) throw new Error('生成图片格式不受支持')
        entry.bytes = Buffer.from(match[2], 'base64')
        if (!entry.bytes.length) throw new Error('生成图片内容为空')
        if (entry.bytes.length > maxBytes) throw new Error('生成图片过大')
        entry.mime = imageMime(entry.bytes, declaredMime)
        delete entry.remoteUrl
      }
      if (entry.remoteUrl) return { ...image, url: entry.remoteUrl }
      const id = randomUUID()
      while (entries.size >= maxEntries || total + (entry.bytes?.length || 0) > maxBytes) remove(entries.keys().next().value)
      entries.set(id, entry); total += entry.bytes?.length || 0
      return { ...image, url: `/api/imagine/result/${id}`, format: entry.mime?.split('/')[1] }
    },
    get(id) { prune(); return entries.get(id) || null },
  }
}
