// 界面统一按“比例 · 清晰度”描述媒体尺寸（例如 9:16 · 4K），不直接把像素宽高展示给用户。
// 保存和提交的值仍是模型目录里的原始 size；这里只负责把它翻译成可读的档位。

const COMMON_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '1:2', '2:1', '9:21', '21:9']
const TIERS = [1, 1.5, 2, 3, 4, 6, 8, 12, 16]

function pixels(value: string) {
  const match = /^(\d+)\s*[x×*]\s*(\d+)$/i.exec(String(value || '').trim())
  return match ? { width: Number(match[1]), height: Number(match[2]) } : null
}

/** 像素尺寸对应的画面比例；5% 以内贴近常用比例时取常用写法（2848×1600 → 16:9），算不出简单比例时返回空串。 */
export function sizeRatio(value: string): string {
  const size = pixels(value)
  if (!size || !size.width || !size.height) return ''
  const actual = size.width / size.height
  const near = COMMON_RATIOS.find((ratio) => {
    const [w, h] = ratio.split(':').map(Number)
    return Math.abs(w / h - actual) / actual < 0.05
  })
  if (near) return near
  const gcd = (left: number, right: number): number => right ? gcd(right, left % right) : left
  const divisor = gcd(size.width, size.height)
  const [w, h] = [size.width / divisor, size.height / divisor]
  return w <= 21 && h <= 21 ? `${w}:${h}` : ''
}

/** 目录清晰度优先；像素值折算为显示档位，小图标记 <1K，大原图保留较高档位；auto 返回空串。 */
export function sizeTier(value: string, catalogLabel = ''): string {
  const text = String(value || '').trim()
  if (!text || text.toLowerCase() === 'auto') return ''
  if (/^\d+(\.\d+)?k$/i.test(text) || /^\d+p$/i.test(text)) return text.toUpperCase()
  const size = pixels(text)
  if (!size) return text
  // 已登记的清晰度优先于像素估算；长边达到 4K 不代表超宽图也有 4K 档的总像素。
  const declared = /(?:^|\s)(\d+(?:\.\d+)?K)(?=\s|$)/i.exec(catalogLabel)
  if (declared) return declared[1].toUpperCase()
  if (Math.max(size.width, size.height) === 3840 && Math.min(size.width, size.height) === 2160) return '4K'
  const k = Math.sqrt(size.width * size.height) / 1024
  if (k < 0.75) return '<1K'
  const tier = TIERS.reduce((best, item) => Math.abs(item - k) < Math.abs(best - k) ? item : best, TIERS[0])
  return `${tier}K`
}

/** “比例 · 清晰度”，例如 9:16 · 4K；ratio 传入时优先使用目录里登记的比例。 */
export function mediaSizeLabel(value: string, ratio = '', autoText = '自动'): string {
  const text = String(value || '').trim()
  if (!text) return ''
  if (text.toLowerCase() === 'auto') return autoText
  const knownRatio = ratio && ratio !== 'auto' ? ratio : sizeRatio(text)
  return [knownRatio, sizeTier(text)].filter(Boolean).join(' · ')
}

/** 视频按短边给出通行叫法：720P、1080P，1440 记 2K、2160 记 4K。 */
export function videoSizeLabel(width: number, height: number): string {
  if (!(width > 0 && height > 0)) return ''
  const short = Math.min(width, height)
  const tier = [360, 480, 540, 720, 1080, 1440, 2160].reduce((best, item) => Math.abs(item - short) < Math.abs(best - short) ? item : best)
  const name = tier === 2160 ? '4K' : tier === 1440 ? '2K' : `${tier}P`
  return [sizeRatio(`${width}x${height}`), name].filter(Boolean).join(' · ')
}
