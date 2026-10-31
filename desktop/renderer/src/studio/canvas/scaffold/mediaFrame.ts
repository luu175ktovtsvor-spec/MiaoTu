import { watch, type Ref } from "vue"

/** 画布节点里媒体框的显示高度：图片 360，视频按短边约 240。占位框必须用同一套算法，加载前后形状才一致。 */
export const IMAGE_MEDIA_HEIGHT = 360
export const VIDEO_MEDIA_MIN = 240
export const VIDEO_MEDIA_MAX = 640

export type MediaPixels = { width: number; height: number }

type FrameData = { mediaPixels?: MediaPixels; ratio?: string; mediaExportSize?: { width?: number; height?: number } }

function frameData(data: object | undefined): FrameData {
  return (data || {}) as FrameData
}

export function parseAspect(ratio: string): MediaPixels | undefined {
  const match = /^(\d+(?:\.\d+)?)\s*[:/x×]\s*(\d+(?:\.\d+)?)$/i.exec(String(ratio || "").trim())
  if (!match) return
  const width = Number(match[1]), height = Number(match[2])
  if (!(width > 0 && height > 0)) return
  return { width, height }
}

/** 只认已经量过的原片像素。比例和外框只给占位，不能当成清晰度。 */
export function pixelsFromNodeData(data: object | undefined): MediaPixels | undefined {
  const pixels = frameData(data).mediaPixels
  if (pixels && Number(pixels.width) > 0 && Number(pixels.height) > 0) return { width: Number(pixels.width), height: Number(pixels.height) }
  return
}

/** 占位用的长宽比：原片像素、比例文案，或节点外框自身的宽高。不写回 mediaPixels。 */
export function layoutAspect(data: object | undefined): MediaPixels | undefined {
  const real = pixelsFromNodeData(data)
  if (real) return real
  const source = frameData(data)
  const ratio = parseAspect(String(source.ratio || ""))
  if (ratio) return ratio
  const box = source.mediaExportSize
  if (box && Number(box.width) > 2 && Number(box.height) > 2) return { width: Number(box.width), height: Number(box.height) }
  return
}

export function rememberMediaPixels(data: { mediaPixels?: MediaPixels }, width: number, height: number) {
  if (!(width > 0 && height > 0)) return
  const prev = data.mediaPixels
  if (prev?.width === width && prev?.height === height) return
  data.mediaPixels = { width, height }
}

export function imageMediaWidth(width: number, height: number) {
  if (!(width > 0 && height > 0)) return 0
  return IMAGE_MEDIA_HEIGHT * width / height
}

export function videoMediaWidth(width: number, height: number) {
  if (!(width > 0 && height > 0)) return 0
  return Math.min(VIDEO_MEDIA_MAX, Math.max(VIDEO_MEDIA_MIN, VIDEO_MEDIA_MIN * width / height))
}

export function videoMediaHeight(width: number, height: number) {
  const mediaWidth = videoMediaWidth(width, height)
  return mediaWidth ? mediaWidth * height / width : 0
}

function near(a: number, b: number) {
  return Math.abs(a - b) < 0.5
}

function clearMediaPixels(data: { mediaPixels?: MediaPixels }) {
  if (data.mediaPixels) delete data.mediaPixels
}

/** 不等进视口：文件一有就量原片尺寸。比例和外框只先占位，量完再记下真实像素。 */
export function watchImageFrame(
  outputUrl: () => string | undefined,
  imageWidth: Ref<number>,
  data: { mediaPixels?: MediaPixels },
  readSize: (path: string, signal: AbortSignal) => Promise<{ width: number; height: number } | undefined>,
) {
  watch(outputUrl, async (path, previous, onCleanup) => {
    if (previous && path !== previous) {
      clearMediaPixels(data)
      imageWidth.value = 0
    }
    if (!path) {
      imageWidth.value = 0
      return
    }
    const real = pixelsFromNodeData(data)
    if (!imageWidth.value) {
      const aspect = real || layoutAspect(data)
      if (aspect) imageWidth.value = imageMediaWidth(aspect.width, aspect.height)
    }
    if (real) return
    const controller = new AbortController()
    onCleanup(() => controller.abort())
    try {
      const size = await readSize(path, controller.signal)
      if (controller.signal.aborted || !size || outputUrl() !== path) return
      rememberMediaPixels(data, size.width, size.height)
      imageWidth.value = imageMediaWidth(size.width, size.height)
    } catch { /* 占位框保持到原件加载 */ }
  }, { immediate: true })
}

export function commitImageFrame(imageWidth: Ref<number>, data: { mediaPixels?: MediaPixels }, width: number, height: number) {
  if (!(width > 0 && height > 0)) return false
  rememberMediaPixels(data, width, height)
  const next = imageMediaWidth(width, height)
  if (near(imageWidth.value, next)) return false
  imageWidth.value = next
  return true
}

export function watchVideoFrame(
  outputFile: () => { url?: string; mimeType?: string } | undefined,
  videoWidth: Ref<number>,
  videoDimensions: Ref<MediaPixels | undefined>,
  layout: Ref<MediaPixels | undefined>,
  data: { mediaPixels?: MediaPixels },
  acquirePreview: (path: string, mimeType: string) => { url: Promise<string>; release(): void } | undefined,
) {
  watch(outputFile, async (file, previous, onCleanup) => {
    const path = file?.url
    const previousPath = previous?.url
    if (previousPath && path !== previousPath) {
      clearMediaPixels(data)
      videoWidth.value = 0
      videoDimensions.value = undefined
      layout.value = undefined
    }
    if (!path) {
      videoWidth.value = 0
      videoDimensions.value = undefined
      layout.value = undefined
      return
    }
    const real = pixelsFromNodeData(data)
    if (real) {
      layout.value = real
      videoDimensions.value = real
      const next = videoMediaWidth(real.width, real.height)
      if (!near(videoWidth.value, next)) videoWidth.value = next
      return
    }
    const aspect = layoutAspect(data)
    if (aspect && !layout.value) {
      layout.value = aspect
      videoWidth.value = videoMediaWidth(aspect.width, aspect.height)
    }
    const controller = new AbortController()
    const shared = acquirePreview(path, file.mimeType || "video/mp4")
    onCleanup(() => { controller.abort(); shared?.release() })
    if (!shared) return
    try {
      const url = await shared.url
      if (controller.signal.aborted || outputFile()?.url !== path || pixelsFromNodeData(data)) return
      const image = new Image()
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve()
        image.onerror = () => reject(new Error("preview"))
        image.src = url
      })
      if (controller.signal.aborted || outputFile()?.url !== path || pixelsFromNodeData(data) || !image.naturalWidth || !image.naturalHeight) return
      layout.value = { width: image.naturalWidth, height: image.naturalHeight }
      const next = videoMediaWidth(image.naturalWidth, image.naturalHeight)
      if (!near(videoWidth.value, next)) videoWidth.value = next
    } catch { /* 占位框保持到原片元数据到达 */ }
  }, { immediate: true })
}

export function commitVideoFrame(
  videoWidth: Ref<number>,
  videoDimensions: Ref<MediaPixels | undefined>,
  data: { mediaPixels?: MediaPixels },
  width: number,
  height: number,
) {
  if (!(width > 0 && height > 0)) return false
  rememberMediaPixels(data, width, height)
  videoDimensions.value = { width, height }
  const next = videoMediaWidth(width, height)
  if (near(videoWidth.value, next)) return false
  videoWidth.value = next
  return true
}
