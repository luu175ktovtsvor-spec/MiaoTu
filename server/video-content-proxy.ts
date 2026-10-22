import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileContentHeaders } from './file-content-policy.ts'
import { fetchVideoContent, videoRangeLength, videoResponseEncoding } from './video-content-fetch.ts'

export async function proxyVideoContent(request: IncomingMessage, response: ServerResponse, {
  target, provider, providerConfig, mime = 'video/mp4', fetchImpl = fetch,
}: {
  target: string
  provider: string
  providerConfig: { baseUrl?: string; apiKey?: string }
  mime?: string
  fetchImpl?: typeof fetch
}) {
  const controller = new AbortController()
  const abort = () => { if (!response.writableEnded) controller.abort() }
  request.on('aborted', abort)
  response.on('close', abort)
  let upstream: Response | undefined
  try {
    if (request.aborted || response.destroyed) controller.abort()
    controller.signal.throwIfAborted()
    upstream = await fetchVideoContent(target, { provider, providerConfig, range: request.headers.range,
      ifRange: typeof request.headers['if-range'] === 'string' ? request.headers['if-range'] : undefined,
      signal: controller.signal, headersTimeoutMs: 30_000, fetchImpl })
    if (!upstream.ok || !upstream.body || upstream.headers.get('content-length') === '0') {
      const status = upstream.status >= 400 && upstream.status < 500 && ![401, 403].includes(upstream.status) ? upstream.status : 502
      throw Object.assign(new Error('视频内容读取失败'), { status })
    }
    const { identity } = videoResponseEncoding(upstream)
    const type = upstream.headers.get('content-type') || mime
    response.writeHead(upstream.status === 206 ? 206 : 200, {
      'content-type': type,
      ...fileContentHeaders(type),
      ...(identity && upstream.headers.get('etag') ? { etag: upstream.headers.get('etag')! } : {}),
      ...(identity && upstream.headers.get('last-modified') ? { 'last-modified': upstream.headers.get('last-modified')! } : {}),
      ...(identity && upstream.headers.get('content-length') ? { 'content-length': upstream.headers.get('content-length')! } : {}),
      ...(upstream.status === 206 && upstream.headers.get('content-range') ? { 'content-range': upstream.headers.get('content-range')! } : {}),
      'accept-ranges': identity ? upstream.headers.get('accept-ranges') || 'bytes' : 'none',
      'cache-control': 'private, max-age=300',
    })
    const source = Readable.fromWeb(upstream.body as any)
    if (upstream.status === 206) {
      const expected = videoRangeLength(upstream)
      let received = 0n
      const measured = new Transform({
        transform(chunk, _encoding, done) {
          received += BigInt(chunk.length)
          done(received > expected ? new Error('Video range exceeds declared length') : null, chunk)
        },
        flush(done) { done(received === expected ? null : new Error('Video range is incomplete')) },
      })
      await pipeline(source, measured, response, { signal: controller.signal })
    } else await pipeline(source, response, { signal: controller.signal })
  } catch (error) {
    const timeout = controller.signal.reason?.name === 'TimeoutError'
    controller.abort()
    if (upstream?.body && !upstream.body.locked) await upstream.body.cancel().catch(() => {})
    if (response.headersSent) { response.destroy(); return }
    if (request.aborted || response.destroyed) return
    throw Object.assign(new Error('视频内容读取失败'), { status: Number((error as any)?.status) || (timeout ? 504 : 502) })
  } finally {
    request.removeListener('aborted', abort)
    response.removeListener('close', abort)
  }
}
