import { McpClient, StreamableHttpTransport } from '@earendil-works/pi-mcp'
import { failure } from '../management-store.ts'
import { runtimeSecret } from '../runtime-secrets.ts'

const ENDPOINT = 'https://mcp.exa.ai/mcp?tools=web_search_advanced_exa'
const MAX_RESPONSE_BYTES = 2_000_000
const publicFailure = (message: string, status = 502) => Object.assign(failure(message, status), { webSearchFailure: true })

function searchTerms(query: string) {
  const terms: Array<{ text: string; start: number; end: number; unclosedQuote?: boolean }> = []
  let start = 0, quote = ''
  for (let index = 0; index < query.length; index++) {
    const character = query[index]
    if (quote) {
      if (character === '\\') index++
      else if (character === quote) quote = ''
    } else if (character === '"' || (character === "'" && (index === start || query[index - 1] === ':'))) {
      // Quotes may wrap a phrase or an operator value. An apostrophe inside
      // an ordinary word does not consume the following search operators.
      quote = character
    } else if (/\s/.test(character)) {
      if (index > start) terms.push({ text: query.slice(start, index), start, end: index })
      start = index + 1
    }
  }
  if (start < query.length) terms.push({ text: query.slice(start), start, end: query.length, unclosedQuote: Boolean(quote) })
  return terms
}

// Keep the product's structured result contract and site: constraints. Pi owns
// MCP framing, initialization and cancellation; Exa owns search and extraction.
export function createWebSearch({ fetchImpl = fetch, apiKey = () => runtimeSecret('EXA_API_KEY'), beforeRequest }: Record<string, any> = {}) {
  return async function searchWeb(rawQuery, rawLimit, signal?: AbortSignal) {
    const query = String(rawQuery || '').trim()
    if (query.length < 2 || query.length > 300) throw failure('请输入 2 到 300 字的搜索关键词', 422)
    const limit = Math.min(10, Math.max(1, Math.floor(Number(rawLimit) || 5)))
    const operators = searchTerms(query).flatMap(term => {
      const match = /^(-?)site:(.*)$/is.exec(term.text)
      return match ? [{ ...term, value: match[2], excluded: Boolean(match[1]) }] : []
    })
    const scopes = operators.map(operator => {
      try {
        if (operator.unclosedQuote) throw new Error('invalid site')
        let value = operator.value
        if (value.startsWith('"') || value.startsWith("'")) {
          if (value.length < 2 || value.at(-1) !== value[0]) throw new Error('invalid site')
          value = value.slice(1, -1)
        }
        const url = new URL(/^[a-z][\w+.-]*:\/\//i.test(value) ? value : 'https://' + value)
        const subdomainsOnly = url.hostname.startsWith('*.')
        const hostname = subdomainsOnly ? url.hostname.slice(2) : url.hostname
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
          || !hostname || hostname.includes('*')) throw new Error('invalid site')
        return { url, hostname, subdomainsOnly, excluded: operator.excluded }
      } catch { throw failure('site: 后请填写有效域名或网页路径', 422) }
    })
    // Exa accepts domain/path restrictions as parameters. Do not also send
    // site operators as search terms, where the provider may interpret them differently.
    let searchQuery = query
    for (const operator of [...operators].reverse()) searchQuery = searchQuery.slice(0, operator.start) + searchQuery.slice(operator.end)
    searchQuery = searchQuery.trim()
    if (!searchQuery) throw failure('请在站点范围之外填写搜索关键词', 422)
    const includes = scopes.filter(scope => !scope.excluded), excludes = scopes.filter(scope => scope.excluded)
    const matches = (url, scope) => ((!scope.subdomainsOnly && url.hostname === scope.hostname) || url.hostname.endsWith('.' + scope.hostname))
      && url.pathname.startsWith(scope.url.pathname)
    const lifetime = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])])
    lifetime.throwIfAborted()
    beforeRequest?.(lifetime)
    const key = String(apiKey() || '').trim()
    let accessFailure: { error: unknown } | undefined
    const client = new McpClient({ name: 'miaoimg-web', version: '1.0.0', requestTimeoutMs: 30_000 })
    const transport = new StreamableHttpTransport({
      url: ENDPOINT, openGetStream: false, maxMessageBytes: MAX_RESPONSE_BYTES,
      headers: key ? { 'x-api-key': key } : {},
      // connect() has no signal option. Cover initialization, response bodies
      // and tools/call with the same lifetime, without sharing users' sessions.
      fetch: async (input, init = {}) => {
        lifetime.throwIfAborted()
        // Initialization and the later search are separate HTTP requests. The
        // account may lose eligibility while MCP initialization is awaiting I/O.
        try { beforeRequest?.(lifetime) }
        catch (error) { accessFailure = { error }; throw error }
        lifetime.throwIfAborted()
        const response = await fetchImpl(input, { ...init, redirect: 'error', signal: AbortSignal.any([lifetime, ...(init.signal ? [init.signal] : [])]) })
        if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
          await response.body?.cancel().catch(() => {})
          throw publicFailure('搜索响应过大，已中止')
        }
        if (!response.body) return response
        let bytes = 0
        const body = response.body.pipeThrough(new TransformStream({
          transform(chunk, controller) {
            bytes += chunk.byteLength
            if (bytes > MAX_RESPONSE_BYTES) throw publicFailure('搜索响应过大，已中止')
            controller.enqueue(chunk)
          },
        }))
        return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
      },
    })
    try {
      await client.connect(transport)
      const result = await client.callTool('web_search_advanced_exa', {
        query: searchQuery, numResults: limit, type: 'auto', textMaxCharacters: 1200, enableSummary: false,
        ...(includes.length ? { includeDomains: includes.map(scope => scope.url.host + scope.url.pathname) } : {}),
        ...(excludes.length ? { excludeDomains: excludes.map(scope => scope.url.host + scope.url.pathname) } : {}),
      }, { signal: lifetime })
      lifetime.throwIfAborted()
      if (result.isError) {
        const message = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
        const limited = /\b429\b|rate.?limit/i.test(message)
        throw publicFailure(limited ? '搜索服务额度或频率已达上限，请稍后重试' : '搜索服务暂时无法完成请求，请稍后重试', limited ? 429 : 502)
      }
      let data: any = result.structuredContent
      if (!Array.isArray(data?.results)) {
        for (const block of result.content) {
          if (block.type !== 'text') continue
          try {
            const parsed = JSON.parse(block.text)
            if (Array.isArray(parsed?.results)) { data = parsed; break }
          } catch { /* A human-readable error is not an empty search result. */ }
        }
      }
      if (!Array.isArray(data?.results)) throw publicFailure('搜索服务返回了无法识别的结果，请稍后重试')
      const results = [], seen = new Set()
      for (const item of data.results) {
        if (typeof item?.url !== 'string' || item.url.length > 4096) continue
        let url: URL
        try { url = new URL(item.url) } catch { continue }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
          || (includes.length && !includes.some(scope => matches(url, scope)))
          || excludes.some(scope => matches(url, scope)) || seen.has(url.href)) continue
        seen.add(url.href)
        results.push({
          title: typeof item.title === 'string' && item.title.trim() ? item.title.slice(0, 400) : url.hostname,
          url: url.href,
          snippet: typeof item.text === 'string' ? item.text.slice(0, 1200) : '',
          ...(typeof item.publishedDate === 'string' ? { publishedDate: item.publishedDate.slice(0, 40) } : {}),
        })
        if (results.length >= limit) break
      }
      if (data.results.length && !results.length) throw publicFailure('搜索未返回符合网址范围的有效来源，不能据此判断没有相关资料')
      return { query, provider: 'Exa', results }
    } catch (error) {
      signal?.throwIfAborted()
      // The SDK may wrap transport errors. Preserve a local eligibility
      // rejection instead of presenting it as an upstream credential failure.
      if (accessFailure) throw accessFailure.error
      if (lifetime.aborted || error?.name === 'McpTimeoutError') throw failure('搜索服务响应超时，请稍后重试', 504)
      if (error?.webSearchFailure) throw error
      if (error?.status === 429) throw failure('搜索服务额度或频率已达上限，请稍后重试', 429)
      if (error?.status === 401 || error?.status === 403) throw failure('搜索服务暂不可用，请联系妙图团队检查服务配置', 503)
      // Do not forward provider response bodies or credentials into conversations.
      throw failure('搜索服务暂时无法完成请求，请稍后重试；也可直接读取已知网址', 502)
    } finally {
      await client.close().catch(() => {})
    }
  }
}
