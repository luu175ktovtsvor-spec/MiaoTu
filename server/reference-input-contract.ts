// Input limits are separate from output resolution and preview dimensions.
// Keep originals unchanged. Reject an unsupported input before reserving credits;
// do not crop, trim, resample, re-encode, or drop a reference to make it fit.
// Sources checked 2026-10-08:
// https://docs.volcengine.com/docs/ark/image-generation-api?lang=zh
// https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh
// https://metaso.cn/api/video-generation/models
import { isSeedance25 } from './seedance25.ts'
const MB = 1024 * 1024
const COMMON_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
const ARK_IMAGE_MIMES = [...COMMON_IMAGE_MIMES, 'image/bmp', 'image/tiff', 'image/heic', 'image/heif']

export function referenceInputPolicy(model, kind) {
  if (!model?.video && kind === 'image') {
    if (model?.provider === 'suihe') return { maxBytes: 30 * MB, mimes: COMMON_IMAGE_MIMES }
    if (model?.provider === 'ark') return {
      maxBytes: 30 * MB, exclusiveMaxBytes: true, mimes: ARK_IMAGE_MIMES,
      minEdge: 15, maxPixels: 36_000_000, minRatio: 1 / 16, maxRatio: 16,
    }
    // Existing Yunshu/Grok channel guard; not a claim about official model limits.
    // Do not expand an unverified channel merely because direct-provider docs differ.
    return { maxBytes: 30 * MB, mimes: COMMON_IMAGE_MIMES }
  }
  if (model?.provider === 'suihe' && model.video) {
    if (kind === 'image') return { maxBytes: 30 * MB, exclusiveMaxBytes: true, mimes: COMMON_IMAGE_MIMES, minEdge: 300, maxEdge: 6000, minRatio: 0.4, maxRatio: 2.5 }
    if (kind === 'video') return { maxBytes: 200 * MB, minDuration: 2, maxDuration: isSeedance25(model) ? 30 : 15, formats: ['mp4', 'mov'] }
    if (kind === 'audio') return { maxBytes: 15 * MB, minDuration: 2, maxDuration: isSeedance25(model) ? 30 : 15, formats: ['wav', 'mp3'] }
  }
  if (model?.provider === 'grok' && model.video) {
    if (kind === 'image') return { maxBytes: 30 * MB, mimes: COMMON_IMAGE_MIMES }
    if (kind === 'video') return { maxBytes: 200 * MB, maxDuration: 15, formats: ['mp4'], codecs: ['h264', 'hevc', 'av1'] }
  }
  if (model?.provider === 'ark' && model.video) {
    if (kind === 'image') return {
      maxBytes: 30 * MB, exclusiveMaxBytes: true, mimes: ARK_IMAGE_MIMES,
      minEdge: 300, maxEdge: 6000, minRatio: 0.4, maxRatio: 2.5,
    }
    if (kind === 'video') return {
      // Ark video files are allowed up to 200MB, matching the workspace file cap.
      // Do not apply Metaso's separate 50MB limit to the Ark channel.
      maxBytes: 200 * MB, minDuration: 2, maxDuration: isSeedance25(model) ? 30 : 15,
      minEdge: 300, maxEdge: 6000, minPixels: 407_696, maxPixels: 8_295_044,
      minRatio: 0.4, maxRatio: 2.5, minFps: 24, maxFps: 60,
      formats: ['mp4', 'mov'], codecs: ['h264', 'hevc'],
    }
    if (kind === 'audio') return {
      maxBytes: 15 * MB, minDuration: 2, maxDuration: isSeedance25(model) ? 30 : 15, formats: ['wav', 'mp3'],
    }
  }
  if (model?.provider === 'metaso') {
    // maxVideoBytes is supplied by Metaso's own public capability endpoint.
    // Do not copy Ark-only codec/dimension/byte restrictions to this gateway.
    if (kind === 'image' && model.id === 'MiniMax-H3') return {
      // Metaso returns 2013 for ratios outside this range. A 793x1983 image
      // (0.3999) is therefore rejected before an upstream task is created.
      maxBytes: 50 * MB, minEdge: 256, maxEdge: 5760, minRatio: 0.4, maxRatio: 2.5,
    }
    if (kind === 'video' && model.id === 'MiniMax-H3') return {
      maxBytes: 50 * MB, minDuration: 2, maxDuration: 15.5, minEdge: 256, maxEdge: 5760,
    }
    if (String(model.id || '').startsWith('seedance-2.0')) {
      if (kind === 'video') return { maxBytes: 50 * MB, minDuration: 2, maxDuration: 15 }
      if (kind === 'audio') return { minDuration: 2, maxDuration: 15 }
    }
  }
  return {}
}

function invalid(message) {
  throw Object.assign(new Error(message), { status: 422 })
}

export function assertReferenceInput(model, kind, metadata) {
  const limit = referenceInputPolicy(model, kind)
  const title = kind === 'image' ? '参考图片' : kind === 'video' ? '参考视频' : '参考音频'
  if (!metadata || !Number.isFinite(metadata.sizeBytes) || metadata.sizeBytes <= 0) invalid(title + '内容为空或无法读取')
  if (limit.maxBytes && (limit.exclusiveMaxBytes ? metadata.sizeBytes >= limit.maxBytes : metadata.sizeBytes > limit.maxBytes)) {
    invalid(title + (limit.exclusiveMaxBytes ? '需小于 ' : '不能超过 ') + limit.maxBytes / MB + 'MB；请处理后重新上传，原素材未被压缩')
  }
  const mime = String(metadata.mime || '').split(';')[0].trim().toLowerCase().replace('image/jpg', 'image/jpeg')
  if (limit.mimes && !limit.mimes.includes(mime)) invalid('当前模型不支持这个' + title + '格式，请转换后重新上传')
  if ((limit.minDuration && metadata.duration < limit.minDuration) || (limit.maxDuration && metadata.duration > limit.maxDuration)) {
    invalid(title + '时长需为 ' + limit.minDuration + '–' + limit.maxDuration + ' 秒；原素材未被截短')
  }
  const width = Number(metadata.width)
  const height = Number(metadata.height)
  if (limit.minEdge && (!(width >= limit.minEdge) || !(height >= limit.minEdge))
    || limit.maxEdge && (width > limit.maxEdge || height > limit.maxEdge)) {
    invalid(title + '宽高需各为 ' + limit.minEdge + (limit.maxEdge ? '–' + limit.maxEdge : ' 以上') + ' 像素；原素材未被缩放')
  }
  const pixels = width * height
  if ((limit.minPixels && pixels < limit.minPixels) || (limit.maxPixels && pixels > limit.maxPixels)) invalid(title + '总像素数超出当前模型范围；请调整后重新上传')
  const ratio = width / height
  if ((limit.minRatio && ratio < limit.minRatio) || (limit.maxRatio && ratio > limit.maxRatio)) invalid(title + '宽高比超出当前模型范围；原素材未被裁切')
  if (limit.formats && !String(metadata.format || '').split(',').some(value => limit.formats.includes(value))) invalid('当前模型不支持这个' + title + '容器格式，请转换后重新上传')
  if (limit.codecs && !limit.codecs.includes(metadata.codec)) invalid('当前模型不支持这个' + title + '编码，请转换后重新上传')
  if (limit.minFps && (!(metadata.fps >= limit.minFps) || metadata.fps > limit.maxFps)) invalid(title + '帧率需为 ' + limit.minFps + '–' + limit.maxFps + ' FPS；原素材未被改帧')
}
