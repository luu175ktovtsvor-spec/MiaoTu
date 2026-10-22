import type { IncomingMessage, ServerResponse } from 'node:http'
import { supportedImageMime } from './result-cache.ts'
import { fileContentHeaders } from './file-content-policy.ts'
import { assertProviderRequestAllowed } from './provider-safety.ts'
import { withRequestSignal } from './request-lifetime.ts'
import { incomingRequestSignal } from './http-request-lifetime.ts'

export const IMAGE_PROXY_MAX_BYTES = 30 * 1024 * 1024
const IMAGE_PROXY_FETCH_TIMEOUT_MS = 8_000

export function isAllowedImageProxyUrl(value) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') return false
    return url.hostname === 'imgen.x.ai' || ['zzyppz.cn', 'volces.com', 'volcengine.com', 'blob.core.windows.net', 'openai.com'].some((suffix) => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`))
  } catch { return false }
}

// Read-only image delivery follows its reader's lifetime. Cancelling this
// proxy never cancels generation or changes the original result/settlement.
export async function proxyImage(request: IncomingMessage, response: ServerResponse, value: string, {
  json, fetchImpl = fetch, env = process.env,
}: {
  json: (response: ServerResponse, status: number, value: Record<string, unknown>) => void
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
}) {
  try {
    await withRequestSignal(request, response, incomingRequestSignal(request), async signal => {
      if (!isAllowedImageProxyUrl(value)) { json(response, 422, { ok: false, error: '图片来源地址不受支持' }); return }
      let upstream: Response | undefined
      try {
        assertProviderRequestAllowed('image-proxy', value, env)
        upstream = await fetchImpl(value, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(IMAGE_PROXY_FETCH_TIMEOUT_MS)]) })
        signal.throwIfAborted()
        if (!upstream.ok) { json(response, 502, { ok: false, error: `图片读取失败（${upstream.status}）` }); return }
        const type = supportedImageMime(upstream.headers.get('content-type'))
        if (!type) { json(response, 502, { ok: false, error: '上游没有返回受支持的图片格式' }); return }
        const contentLength = Number(upstream.headers.get('content-length') || 0)
        if (contentLength > IMAGE_PROXY_MAX_BYTES) { json(response, 413, { ok: false, error: '图片文件过大' }); return }
        if (!upstream.body) { json(response, 502, { ok: false, error: '图片读取失败' }); return }
        const chunks = []
        let length = 0
        for await (const chunk of upstream.body) {
          signal.throwIfAborted()
          length += chunk.length
          if (length > IMAGE_PROXY_MAX_BYTES) throw Object.assign(new Error('图片文件过大'), { status: 413 })
          chunks.push(chunk)
        }
        signal.throwIfAborted()
        const bytes = Buffer.concat(chunks)
        if (!bytes.length) { json(response, 502, { ok: false, error: '图片内容为空' }); return }
        response.writeHead(200, { 'content-type': type, 'cache-control': 'private, max-age=300', 'content-length': bytes.length, ...fileContentHeaders(type) })
        response.end(bytes)
      } catch (error) {
        if (!signal.aborted && !response.destroyed && !response.writableEnded) json(response, error?.status || 502, { ok: false, error: error?.message || '图片读取失败' })
      } finally {
        if (upstream?.body && !upstream.body.locked) await upstream.body.cancel().catch(() => {})
      }
    })
  } catch (error) {
    if (!request.aborted && !response.destroyed && !response.writableEnded) throw error
  }
}
