// Parse only the creation on the assistant message already matched to this
// task. A conversation may contain several assistant replies and old videos.
// This function is also serialized into the sandboxed platform page.
export function replyVideoId(data: any, replyId: string, conversationId: string): string | undefined {
  if (!/^\d{8,40}$/.test(replyId) || !/^\d{8,40}$/.test(conversationId)) return
  if (data?.status_code !== undefined && data.status_code !== 0 || data?.cmd !== undefined && data.cmd !== 3100) return
  const chain = data?.downlink_body?.pull_singe_chain_downlink_body
  if (!Array.isArray(chain?.messages) || chain.messages.length > 100) return
  const matches = chain.messages.filter((message: any) => message?.message_id === replyId)
  if (matches.length !== 1) return
  const message = matches[0]
  if (message.conversation_id !== undefined && message.conversation_id !== conversationId) return
  let blocks = message.content
  try {
    if (typeof blocks === 'string') {
      if (blocks.length > 2 * 1024 * 1024) return
      blocks = JSON.parse(blocks)
    }
  } catch { return }
  if (!Array.isArray(blocks) || blocks.length > 100) return
  const videos = new Set<string>()
  for (const block of blocks) {
    const creations = block?.content?.creation_block?.creations
    if (!Array.isArray(creations) || creations.length > 100) continue
    for (const creation of creations) {
      if (creation?.type !== 2) continue
      const vid = creation.video?.vid
      if (typeof vid !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(vid)) return
      videos.add(vid)
    }
  }
  return videos.size === 1 ? [...videos][0] : undefined
}

// Only read existing messages and official download information. There is no
// completion request, preference mutation, confirmation or URL rewriting here.
// Both APIs run in the current account's sandbox; credentials stay in Chromium.
export async function platformVideoDownload(payload: { platform: string; conversationUrl: string; replyId: string }, readVideo: typeof replyVideoId): Promise<{ url: string } | undefined> {
  const origin = payload.platform === 'dola' ? 'https://www.dola.com' : payload.platform === 'doubao' ? 'https://www.doubao.com' : ''
  const target = new URL(payload.conversationUrl)
  if (!origin || target.origin !== origin || !/^\/chat\/(?:\d{8,40})?\/?$/.test(target.pathname) || !/^\d{8,40}$/.test(payload.replyId)) return
  const current = () => location.origin === origin && location.pathname.replace(/\/$/, '') === target.pathname.replace(/\/$/, '')
  if (!current()) return
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 12_000)
  const abort = () => controller.abort()
  addEventListener('pagehide', abort, { once: true })
  try {
    // Reuse public request parameters from this document's own chain read.
    // Never copy signatures, auth headers, Cookies or arbitrary query fields.
    const params = new URLSearchParams()
    const keys = ['version_code', 'language', 'device_platform', 'doubao_device_platform', 'aid', 'real_aid', 'pkg_type', 'device_id', 'pc_version', 'doubao_pc_version', 'region', 'sys_region', 'samantha_web', 'web_platform', 'use-olympus-account', 'web_tab_id']
    const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[]
    const chainRequest = entries.map(entry => { try { return new URL(entry.name) } catch { return undefined } }).reverse().find(url => url?.origin === origin && url.pathname === '/im/chain/single')
    if (!chainRequest) return
    for (const key of keys) {
      const value = chainRequest.searchParams.get(key)
      if (value !== null && value.length <= 256) params.set(key, value)
    }
    const post = async (path: string, body: unknown, query = '') => {
      if (!current()) return
      const response = await fetch(path + query, { method: 'POST', credentials: 'include', redirect: 'error',
        headers: { 'content-type': 'application/json', 'agw-js-conv': 'str' }, body: JSON.stringify(body), signal: controller.signal })
      if (!current() || response.status !== 200) { await response.body?.cancel(); return }
      // A malformed or unusually large history is not a reason to scan other
      // replies or retain the account's history in the desktop process.
      const reader = response.body?.getReader()
      if (!reader) return
      try {
        const decoder = new TextDecoder(); let size = 0, text = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > 4 * 1024 * 1024) { await reader.cancel(); return }
          text += decoder.decode(value, { stream: true })
        }
        text += decoder.decode()
        return current() ? JSON.parse(text) : undefined
      } finally { reader.releaseLock() }
    }
    const conversationId = target.pathname.split('/').filter(Boolean).at(-1)
    // The blank /chat/ route has no conversation ID, so its optional
    // no-watermark endpoint cannot be addressed. The caller will retain the
    // already-rendered player URL and mark it as unconfirmed.
    if (!conversationId) return
    const chain = await post('/im/chain/single', { cmd: 3100, uplink_body: { pull_singe_chain_uplink_body: {
      conversation_id: conversationId, anchor_index: Number.MAX_SAFE_INTEGER, conversation_type: 3, direction: 1, limit: 20, ext: {},
      filter: { index_list: [] }, evaluate_ab_params: '', evaluate_common_params: '',
    } }, sequence_id: crypto.randomUUID(), channel: 2, version: '1' }, '?' + params)
    const vid = readVideo(chain, payload.replyId, conversationId)
    if (!vid || !current()) return
    const response = await post('/creativity/resource/get_without_watermark', { vid: [vid] })
    if (!current() || response?.code !== 0 || response?.data?.without_watermark !== true) return
    const url = response.data.download_video?.[vid]?.download_url
    if (typeof url === 'string' && url.length <= 32_768) return { url }
  } catch { /* An optional download variant must not lose the original result. */ }
  finally { clearTimeout(timeout); removeEventListener('pagehide', abort) }
}

// Read a small file prefix before choosing the local original's extension.
// CDN headers can be generic, and DOM MIME hints are not file-type evidence.
// Preserve every byte; this does not transcode or edit the generated material.
export async function localMediaResponse(response: Response, allowedMimeTypes: readonly string[]): Promise<Response> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('平台原件响应缺失')
  const chunks: Uint8Array[] = [], prefix = new Uint8Array(512)
  let size = 0, ended = false
  try {
    while (size < prefix.length && !ended) {
      const { value, done } = await reader.read()
      ended = done
      if (value?.length) {
        chunks.push(value)
        const length = Math.min(value.length, prefix.length - size)
        prefix.set(value.subarray(0, length), size); size += length
      }
    }
    const bytes = prefix.subarray(0, size)
    const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end))
    const signature = (...values: number[]) => values.every((value, index) => bytes[index] === value)
    let mime = ''
    if (signature(137, 80, 78, 71, 13, 10, 26, 10)) mime = 'image/png'
    else if (signature(255, 216, 255)) mime = 'image/jpeg'
    else if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') mime = 'image/webp'
    else if (ascii(4, 8) === 'ftyp' && ['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'dash', 'msdh', 'msix', 'M4V ', 'F4V ', 'MSNV'].includes(ascii(8, 12))) mime = 'video/mp4'
    else if (signature(26, 69, 223, 163) && ascii(4, size).includes('\x42\x82\x84webm')) mime = 'video/webm'
    const declared = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
    if (!mime || !allowedMimeTypes.includes(mime) || declared && !['application/octet-stream', 'binary/octet-stream', mime].includes(declared)) throw new Error('平台原件内容与支持的文件格式不一致，已保留原任务等待取回')
    const headers = new Headers(response.headers); headers.set('content-type', mime)
    let released = false
    const release = () => { if (!released) { released = true; reader.releaseLock() } }
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        if (ended) { release(); controller.close() }
      },
      async pull(controller) {
        try {
          const { value, done } = await reader.read()
          if (done) { release(); controller.close() }
          else controller.enqueue(value)
        } catch (error) { release(); controller.error(error) }
      },
      async cancel(reason) { try { await reader.cancel(reason) } finally { release() } },
    })
    return new Response(body, { status: response.status, statusText: response.statusText, headers })
  } catch (error) {
    try { await reader.cancel(error) } finally { reader.releaseLock() }
    throw error
  }
}
