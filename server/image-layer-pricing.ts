// New layer requests freeze both pixel tiers. Legacy jobs without this version
// retain their original per-image price and settlement behavior.
export const IMAGE_LAYER_PRICING_VERSION = 'ark-image-layers-v1'
export const IMAGE_LAYER_UNCONFIRMED_BASIS = 'ark_image_layers_dimensions_unconfirmed'
export type ImageLayerPricing = {
  version: typeof IMAGE_LAYER_PRICING_VERSION; model: string; thresholdPixels: number; maxOutputs: number;
  small: { supplierRmb: number; customerCredits: number }; large: { supplierRmb: number; customerCredits: number };
  referenceRmb: number; referenceCredits: number;
}
const round = (value: number) => Math.round(value * 10000) / 10000
const amount = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0
export function isImageLayerPricing(value: any): value is ImageLayerPricing {
  return value?.version === IMAGE_LAYER_PRICING_VERSION && typeof value.model === 'string'
    && Number.isSafeInteger(value.thresholdPixels) && value.thresholdPixels > 0 && value.maxOutputs === 17
    && amount(value.small?.supplierRmb) && amount(value.small?.customerCredits)
    && amount(value.large?.supplierRmb) && amount(value.large?.customerCredits)
    && amount(value.referenceRmb) && amount(value.referenceCredits)
}
export function hasImageLayerPricing(value: any) { return value?.version === IMAGE_LAYER_PRICING_VERSION }
export function imageLayerReservation(snapshot: ImageLayerPricing, count: number) {
  const images = Math.min(snapshot.maxOutputs, Math.max(1, Math.floor(Number(count) || 1)))
  return round(images * Math.max(snapshot.small.customerCredits, snapshot.large.customerCredits) + snapshot.referenceCredits)
}
function dimensions(width: number, height: number) {
  const pixels = width * height
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0
    && width <= 100000 && height <= 100000 && Number.isSafeInteger(pixels) && pixels <= 100000000
    ? { width, height, pixels } : null
}
function pngHeaderCrc(bytes: Uint8Array) {
  let crc = 0xffffffff
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0) }
  return (crc ^ 0xffffffff) >>> 0
}
// Read the original image's encoded dimensions, never a preview or a provider-
// supplied label. PNG IHDR and JPEG SOF cover both official output formats.
export function imageLayerDimensions(bytes: Uint8Array) {
  try {
    const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (input.length >= 33 && input.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
      if (input.readUInt32BE(8) !== 13 || input.toString('ascii',12,16) !== 'IHDR') return null
      const depths = ({ 0: [1,2,4,8,16], 2: [8,16], 3: [1,2,4,8], 4: [8,16], 6: [8,16] })[input[25]]
      if (!depths?.includes(input[24]) || input[26] !== 0 || input[27] !== 0 || ![0,1].includes(input[28])) return null
      if (pngHeaderCrc(input.subarray(12, 29)) !== input.readUInt32BE(29)) return null
      let imageData = false, complete = false
      for (let offset = 8; offset + 12 <= input.length;) {
        const size = input.readUInt32BE(offset)
        if (offset + size + 12 > input.length) return null
        const type = input.toString('ascii', offset + 4, offset + 8)
        if (type === 'IDAT' && size > 0) imageData = true
        if (type === 'IEND') { complete = size === 0; break }
        offset += size + 12
      }
      return imageData && complete ? dimensions(input.readUInt32BE(16), input.readUInt32BE(20)) : null
    }
    if (input.length < 4 || input[0] !== 0xff || input[1] !== 0xd8) return null
    for (let offset = 2; offset + 3 < input.length;) {
      if (input[offset++] !== 0xff) return null
      while (offset < input.length && input[offset] === 0xff) offset += 1
      if (offset >= input.length) return null
      const marker = input[offset++]
      if (marker === 0xda || marker === 0xd9 || marker === 0x00) return null
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue
      if (offset + 2 > input.length) return null
      const length = input.readUInt16BE(offset)
      if (length < 2 || offset + length > input.length) return null
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
        if (length < 8 || ![8,12,16].includes(input[offset + 2]) || input[offset + 7] < 1 || input[offset + 7] > 4 || length !== 8 + input[offset + 7] * 3) return null
        if (input.indexOf(Buffer.from([0xff, 0xd9]), offset + length) < 0) return null
        return dimensions(input.readUInt16BE(offset + 5), input.readUInt16BE(offset + 3))
      }
      offset += length
    }
  } catch { /* malformed or truncated headers cannot establish a pixel tier */ }
  return null
}
export function hasPngAlphaChannel(bytes: Uint8Array) {
  try {
    const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return input.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      && Boolean(imageLayerDimensions(input)) && [4,6].includes(input[25])
  } catch { return false }
}
export function settleImageLayers(snapshot: ImageLayerPricing, artifacts: readonly { bytes: Uint8Array }[], reserved: number) {
  const base = { version: IMAGE_LAYER_PRICING_VERSION, model: snapshot?.model || '', count: artifacts.length }
  if (!isImageLayerPricing(snapshot)) return { ...base, status: 'unconfirmed', reason: 'invalid_snapshot', chargedCredits: 0, supplierRmb: null }
  const images = artifacts.map(artifact => imageLayerDimensions(artifact.bytes))
  if (images.some(image => !image)) return { ...base, status: 'unconfirmed', reason: 'dimensions_unavailable', chargedCredits: 0, supplierRmb: null }
  const layers = images.map(image => ({ ...image!, tier: image!.pixels > snapshot.thresholdPixels ? 'large' : 'small' }))
  const supplierRmb = round(layers.reduce((sum, layer) => sum + snapshot[layer.tier].supplierRmb, snapshot.referenceRmb))
  const uncappedCredits = round(layers.reduce((sum, layer) => sum + snapshot[layer.tier].customerCredits, snapshot.referenceCredits))
  return { ...base, status: 'confirmed', layers, supplierRmb, uncappedCredits,
    chargedCredits: round(Math.min(Math.max(0, Number(reserved) || 0), uncappedCredits)) }
}
