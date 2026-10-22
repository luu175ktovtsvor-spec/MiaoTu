import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

let active = 0
const MAX_BYTES = 512 * 1024 * 1024

// Only a video already listed in the public archive can use this relay. The
// browser never supplies a remote URL, and upstream redirects are not followed.
export async function serveArchivedVideo(request, response, relativePath) {
  const match = /^(\d{8,30})\/video_\d{1,3}\.(mp4|m4v|mov|webm)$/.exec(relativePath)
  if (!match || !['GET', 'HEAD'].includes(request.method)) return false
  if (active >= 16) {
    response.writeHead(503, { 'Retry-After': '3' }); response.end(); return true
  }
  active++
  const controller = new AbortController()
  const close = () => { if (!response.writableEnded) controller.abort() }
  response.on('close', close)
  let timer = setTimeout(() => controller.abort(), 30000)
  const signal = controller.signal
  try {
    const port = Number(process.env.OIP_API_PORT || 8787)
    const catalog = await fetch(`http://127.0.0.1:${port}/api/prompts?ids=${match[1]}`, { signal })
    if (!catalog.ok) return false
    const data = await catalog.json()
    const entry = data.items?.[0]?.videos?.find(video => video.local === `images/${relativePath}`)
    if (!entry?.url) return false
    const target = new URL(entry.url)
    if (target.protocol !== 'https:' || target.hostname !== 'video.twimg.com' || target.port || target.username || target.password || !/^\/(amplify_video|ext_tw_video|tweet_video)\//.test(target.pathname)) return false
    const range = request.headers.range
    if (range && !/^bytes=\d*-\d*$/.test(range)) {
      response.writeHead(416); response.end(); return true
    }
    const remote = await fetch(target, { method: request.method, redirect: 'error', signal,
      headers: { ...(range ? { range } : {}), 'accept-encoding': 'identity' } })
    if (![200, 206, 416].includes(remote.status)) { await remote.body?.cancel(); return false }
    const type = remote.headers.get('content-type') || ''
    const length = Number(remote.headers.get('content-length') || 0)
    if (remote.status !== 416 && (!type.startsWith('video/') || length > MAX_BYTES)) { await remote.body?.cancel(); return false }
    const headers = Object.fromEntries(['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'].flatMap(name => remote.headers.has(name) ? [[name, remote.headers.get(name)]] : []))
    clearTimeout(timer)
    timer = setTimeout(() => controller.abort(), 60000)
    response.writeHead(remote.status, { ...headers, 'accept-ranges': 'bytes', 'cache-control': 'public, max-age=3600', 'x-content-type-options': 'nosniff' })
    if (request.method === 'HEAD' || !remote.body) { await remote.body?.cancel(); response.end(); return true }
    let received = 0
    const limit = new Transform({ transform(chunk, _encoding, callback) {
      clearTimeout(timer)
      timer = setTimeout(() => controller.abort(), 60000)
      received += chunk.length
      callback(received > MAX_BYTES ? new Error('Archive video exceeds size limit') : null, chunk)
    } })
    await pipeline(Readable.fromWeb(remote.body), limit, response, { signal })
    return true
  } catch {
    if (response.headersSent) { response.destroy(); return true }
    return response.destroyed
  } finally {
    clearTimeout(timer); controller.abort(); response.off('close', close); active--
  }
}
