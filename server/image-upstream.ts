import { createMediaProviderFetch } from './provider-fetch.ts'
import { upstreamImageError } from './image-error.ts'
import { selectUpstreamImages } from './upstream-response.ts'
import type { ImageTransport } from './image-transport.ts'

function requestIdFromProviderText(value) {
  return /(?:request[ _-]*id|请求\s*id)\s*[:：=]\s*([A-Za-z0-9_-]+)/i.exec(String(value || ''))?.[1] || ''
}

async function readImageResponse(response: Response, generation) {
  const text = await response.text()
  let data: Record<string, any> = {}
  try { data = text ? JSON.parse(text) : {} } catch { data = { raw: text.slice(0, 1000) } }
  if (!data || typeof data !== 'object' || Array.isArray(data)) data = { raw: text.slice(0, 1000) }
  const rawProviderMessage = data?.error?.message || data?.message || data?.error || ''
  const metadata = {
    usage: data.usage || null,
    upstreamModel: data.model || data.upstream_model || data.upstreamModel || response.headers.get('x-upstream-model') || '',
    upstreamRequestId: data.id || data.request_id || data.requestId || data.upstream_request_id || data.upstreamRequestId || response.headers.get('x-request-id') || response.headers.get('request-id') || response.headers.get('x-upstream-request-id') || requestIdFromProviderText(rawProviderMessage),
    upstreamStatus: response.status,
  }
  if (!response.ok || data.error) {
    const safe = upstreamImageError(response.status, data)
    throw Object.assign(new Error(safe.message), { status: safe.status, code: safe.code, ...metadata })
  }
  let images: ReturnType<typeof selectUpstreamImages>
  try { images = selectUpstreamImages(data, generation) }
  catch (cause) { throw Object.assign(new Error('上游图片回执格式不完整，请先核对原任务'), { status: 502, submissionUncertain: true, ...metadata, cause }) }
  if (!images.length) throw Object.assign(new Error('上游没有返回可展示的图片'), { status: 502, submissionUncertain: true, ...metadata })
  return { images, ...metadata }
}

// Own only protocol bytes and the upstream receipt. Account admission, billing,
// reference signing and local/server persistence remain with their callers.
export async function requestImageUpstream(config: { baseUrl: string; apiKey: string }, transport: ImageTransport, generation,
  { env = process.env, fetchImpl = fetch, signal }: Record<string, any> = {}) {
  const headers: Record<string, string> = { authorization: `Bearer ${config.apiKey}` }
  let body: FormData | string
  if (transport.kind === 'multipart') {
    const form = new FormData()
    Object.entries(transport.fields).forEach(([key, value]) => form.set(key, String(value)))
    transport.files.forEach(file => form.append(file.field, new Blob([file.bytes], { type: file.mime }), file.name))
    body = form
  } else {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(transport.body)
  }
  const response = await createMediaProviderFetch({ env, fetchImpl })(config.baseUrl + transport.path, { method: 'POST', headers, body, signal })
  return readImageResponse(response, generation)
}
