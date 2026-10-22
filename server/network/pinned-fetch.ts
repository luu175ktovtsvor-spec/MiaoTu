import { request as httpRequest, type RequestOptions } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { TcpNetConnectOpts } from 'node:net'
import { Readable, pipeline, type Transform } from 'node:stream'
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib'
import { failure } from '../management-store.ts'

const decoders = new Map<string, () => Transform>([
  ['gzip', createGunzip], ['x-gzip', createGunzip], ['deflate', createInflate], ['br', createBrotliDecompress],
])

// Callers validate every DNS address and each redirect. Node may try any of
// those pinned addresses; it owns connection fallback and stream teardown.
export async function fetchPinnedResponse(address: URL, resolved, { signal, headers = {}, method = 'GET', body, allowPartial = false, fetchImpl = fetch }: Record<string, any> = {}) {
  signal?.throwIfAborted()
  const selected = resolved.find(item => item.family === 4) || resolved[0]
  const response = fetchImpl !== fetch
    ? await fetchImpl(address, { redirect: 'manual', signal, headers, method, ...(body ? { body, duplex: 'half' } : {}) })
    : await new Promise<Response>((resolve, reject) => {
      const options: RequestOptions & Pick<TcpNetConnectOpts, 'autoSelectFamily'> = {
        // A global pool can hand an aborted request's connecting socket to a
        // later request with different pinned addresses for the same hostname.
        agent: false,
        headers: { accept: '*/*', 'accept-encoding': 'identity', ...headers }, method, signal, autoSelectFamily: true,
        lookup: (_hostname, options, callback) => options.all
          ? callback(null, resolved) : callback(null, selected.address, selected.family),
      }
      const request = (address.protocol === 'https:' ? httpsRequest : httpRequest)(address, options, incoming => {
        try {
          const status = incoming.statusCode || 502
          if (status < 200 || status > 599) throw failure('下载服务器返回了无效的 HTTP 状态', 502)
          const responseHeaders = new Headers()
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : value)
          }
          if ([204, 205, 304].includes(status)) {
            incoming.destroy()
            resolve(new Response(null, { status, headers: responseHeaders }))
            return
          }
          // Redirect bodies are discarded by both callers; their content coding
          // must not prevent following and validating the Location address.
          const encodings = [301, 302, 303, 307, 308].includes(status) ? []
            : String(incoming.headers['content-encoding'] || '').toLowerCase().split(',').map(value => value.trim()).filter(value => value && value !== 'identity')
          // Encoded byte positions cannot describe the decoded representation.
          if (status === 206 && encodings.length) throw failure('分段内容采用了压缩编码，已中止读取', 502)
          if (encodings.some(encoding => !decoders.has(encoding))) throw failure('下载响应采用了不支持的压缩格式', 502)
          // Content-Encoding lists the order of compression, so undo it in reverse.
          const transforms = encodings.reverse().map(encoding => decoders.get(encoding)!())
          if (transforms.length) {
            responseHeaders.delete('content-encoding')
            responseHeaders.delete('content-length')
            responseHeaders.delete('etag')
            responseHeaders.set('accept-ranges', 'none')
          }
          const stream = transforms.at(-1) || incoming
          const response = new Response(Readable.toWeb(stream) as BodyInit, { status, headers: responseHeaders })
          // Pipeline propagates source/decoder errors and reader cancellation
          // across the whole chain. The response reader observes those errors.
          if (transforms.length) pipeline([incoming, ...transforms], () => {})
          resolve(response)
        } catch (error) {
          incoming.destroy()
          reject(error)
        }
      })
      request.once('error', reject)
      // Provider SDKs pass JSON as a Request body. Keep its backpressure and
      // cancellation instead of copying a multimodal payload into a new buffer.
      if (body) pipeline(Readable.fromWeb(body), request, error => { if (error) reject(error) })
      else request.end()
    })
  // Full document/plugin/model readers retain their complete-resource policy.
  // Only an explicit range reader may accept a successful partial response.
  if (response.status === 206 && !allowPartial) {
    await response.body?.cancel().catch(() => {})
    throw failure('服务器只返回了部分内容，已中止读取', 502)
  }
  return response
}
