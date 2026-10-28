import { createServer } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { lookup } from 'node:dns/promises'
import { BlockList } from 'node:net'
import { timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { pipeline } from 'node:stream'

const token = readFileSync(process.env.OIP_PROVIDER_RELAY_KEY_FILE || '/etc/miaoimg-provider-relay/key', 'utf8').trim()
if (token.length < 32) throw new Error('Provider relay key is missing')
const allowed = new Set(['ark.cn-beijing.volces.com', 'api.suihemedia.cloud', 'metaso.cn'])
const denied = new BlockList()
for (const [ip, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) denied.addSubnet(ip, prefix, 'ipv4')
const hop = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'set-cookie'])
const server = createServer(async (request, response) => {
  const reject = status => { if (!response.headersSent) { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'Relay request unavailable' })) } else response.destroy() }
  const supplied = Buffer.from(String(request.headers.authorization || ''))
  const expected = Buffer.from('Bearer ' + token)
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { reject(401); return }
  if (request.url === '/__miaoimg-provider/health' && request.method === 'GET') { response.setHeader('content-type', 'application/json'); response.end('{"ok":true}'); return }
  if (request.url !== '/__miaoimg-provider/request' || !['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'].includes(request.method || '')) { reject(404); return }
  try {
    const url = new URL(String(request.headers['x-miao-upstream-url'] || ''))
    if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' || !allowed.has(url.hostname)) { reject(403); return }
    const encoded = String(request.headers['x-miao-upstream-headers'] || '')
    if (encoded.length > 16000) { reject(431); return }
    const entries = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
    if (!Array.isArray(entries) || entries.some(x => !Array.isArray(x) || x.length !== 2 || x.some(v => typeof v !== 'string' || /[\r\n]/.test(v)))) { reject(400); return }
    const addresses = await lookup(url.hostname, { all: true, family: 4 })
    if (!addresses.length || addresses.some(x => denied.check(x.address, 'ipv4'))) { reject(403); return }
    const headers = Object.fromEntries(entries.filter(([key]) => !hop.has(key.toLowerCase())))
    // The resolved public address is pinned for this connection; supplier TLS
    // still verifies the original hostname. No redirects or automatic retries.
    const target = addresses[0]
    const upstream = httpsRequest(url, { method: request.method, headers, lookup: ((_host, options, callback) => options.all ? callback(null, [target]) : callback(null, target.address, 4)) as any, rejectUnauthorized: true }, incoming => {
      const headers: Record<string, any> = {}
      for (const [key, value] of Object.entries(incoming.headers)) if (!hop.has(key) && value !== undefined) headers[key] = value
      response.writeHead(incoming.statusCode || 502, headers)
      pipeline(incoming, response, () => {})
    })
    upstream.setTimeout(300000, () => upstream.destroy(new Error('relay timeout')))
    upstream.on('error', () => reject(502))
    request.on('aborted', () => upstream.destroy())
    response.on('close', () => { if (!response.writableFinished) upstream.destroy() })
    pipeline(request, upstream, error => { if (error) upstream.destroy(error) })
  } catch { reject(502) }
})
server.listen(Number(process.env.OIP_PROVIDER_RELAY_PORT || 17402), '127.0.0.1')
