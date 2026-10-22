import { failure } from './management-store.ts'
import { assertProviderRequestAllowed } from './provider-safety.ts'
import { imageMime, supportedImageMime } from './result-cache.ts'
import type { requestImageUpstream } from './image-upstream.ts'

type ImageReceipt = Awaited<ReturnType<typeof requestImageUpstream>>
export type ImageResultMetadata = Pick<ImageReceipt, 'usage' | 'upstreamModel' | 'upstreamRequestId' | 'upstreamStatus'>

// The model already returned usable result handles. Failures while receiving
// or committing those bytes cannot prove that the model request was rejected.
export class ImageResultError extends Error {
  upstreamAccepted = true
  submissionUncertain = true
  status: number
  code: string
  usage: ImageReceipt['usage']
  upstreamModel: string
  upstreamRequestId: string
  upstreamStatus: number
  imageResultPending = false
  constructor(error: any, result: ImageResultMetadata) {
    super(error instanceof Error ? error.message : '图片结果保存失败', { cause: error })
    this.status = Number.isInteger(error?.status) ? error.status : 502
    this.code = String(error?.code || error?.cause?.code || '')
    this.usage = result.usage
    this.upstreamModel = result.upstreamModel
    this.upstreamRequestId = result.upstreamRequestId
    this.upstreamStatus = result.upstreamStatus
  }
}

export async function readImageArtifact(image: { url: string }, { signal, allowUrl, maxBytes, env = process.env, fetchImpl = fetch }: {
  signal?: AbortSignal; allowUrl: (url: string) => boolean; maxBytes: number; env?: Record<string, any>; fetchImpl?: typeof fetch;
}) {
  signal?.throwIfAborted()
  if (image.url.startsWith('data:')) {
    const match = /^data:(image\/[^;]+);base64,(.*)$/s.exec(image.url)
    if (!match) throw failure('图片格式无效', 502)
    const declaredMime = supportedImageMime(match[1])
    if (!declaredMime) throw failure('图片格式不受支持', 502)
    const bytes = Buffer.from(match[2], 'base64')
    if (!bytes.length) throw failure('生成图片内容为空', 502)
    if (bytes.length > maxBytes) throw failure('生成图片过大', 502)
    return { bytes, mime: imageMime(bytes, declaredMime) }
  }
  if (!allowUrl(image.url)) throw failure('图片来源不受支持', 502)
  assertProviderRequestAllowed('image-result', image.url, env)
  const response = await fetchImpl(image.url, { signal, redirect: 'error' })
  try {
    const declaredMime = supportedImageMime(response.headers.get('content-type'))
    if (!response.ok || !declaredMime) throw failure('上游图片读取失败', 502)
    const encoded = response.headers.get('content-encoding')
    const length = Number(response.headers.get('content-length'))
    if (!encoded && length > maxBytes) throw failure('生成图片过大', 502)
    if (!response.body) throw failure('上游图片内容为空', 502)
    const chunks: Uint8Array[] = []
    let size = 0
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > maxBytes) throw failure('生成图片过大', 502)
      chunks.push(chunk)
    }
    signal?.throwIfAborted()
    if (!size) throw failure('上游图片内容为空', 502)
    if (!encoded && length > 0 && size !== length) throw failure('上游图片尚未完整下载', 502)
    const bytes = Buffer.concat(chunks)
    return { bytes, mime: imageMime(bytes, declaredMime) }
  } finally {
    // MIME/status/length can reject before a reader owns the response body.
    if (response.body && !response.body.locked) await response.body.cancel().catch(() => {})
  }
}

export async function collectImageArtifacts<Source, T>(images: readonly Source[], read: (image: Source, signal: AbortSignal) => Promise<T>, parent?: AbortSignal): Promise<T[]> {
  const controller = new AbortController()
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal
  signal.throwIfAborted()
  let failed: { error: unknown } | undefined
  const settled = await Promise.allSettled(images.map(async image => {
    try { return await read(image, signal) }
    catch (error) {
      if (!failed) { failed = { error }; controller.abort(error) }
      throw error
    }
  }))
  // Unwind every transfer before releasing the task/lease or publishing error.
  if (failed) throw failed.error
  signal.throwIfAborted()
  return settled.map(result => { if (result.status === 'rejected') throw result.reason; return result.value })
}
