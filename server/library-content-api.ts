import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { resolve, join, sep, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pipeline } from 'node:stream/promises'

const root = resolve(process.env.OIP_LIBRARY_CONTENT_ROOT || '/opt/miaoimg/library-content')
const cache = resolve(process.env.OIP_VIDEO_POSTER_CACHE || '/opt/miaoimg/catalog/video-posters')
const images = resolve(process.env.OIP_ARCHIVE_IMAGES_ROOT || '/opt/miaoimg/images')
const catalogPort = Number(process.env.OIP_API_PORT || 4176)
const run = promisify(execFile)
const lifetime = new AbortController()
const sources = new Map<string, { at: number; videos: any[] }>()
const inflight = new Map<string, Promise<string>>()
let active = 0
const queue: (() => void)[] = []
const busy = () => Object.assign(new Error('Busy'), { status: 503 })
const missing = () => Object.assign(new Error('Not found'), { status: 404 })
const exists = async (path: string) => { try { return (await stat(path)).isFile() } catch { return false } }

async function bytes(response: Response, limit: number, allowPrefix = false) {
  const reader = response.body?.getReader()
  if (!reader) throw missing()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (size + value.byteLength > limit) {
        if (!allowPrefix) throw new Error('Response too large')
        chunks.push(value.subarray(0, limit - size)); break
      }
      chunks.push(value); size += value.byteLength
      if (allowPrefix && size === limit) break
    }
    return Buffer.concat(chunks)
  } finally { await reader.cancel().catch(() => {}) }
}

async function videoSource(tweet: string, index: number, pathname: string) {
  let entry = sources.get(tweet)
  if (!entry || Date.now() - entry.at > 120_000) {
    const response = await fetch(`http://127.0.0.1:${catalogPort}/api/prompts?ids=${tweet}&limit=1`,
      { signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(6000)]), redirect: 'error' })
    if (!response.ok) { await response.body?.cancel(); throw missing() }
    const data = JSON.parse((await bytes(response, 2 * 1024 * 1024)).toString('utf8'))
    entry = { at: Date.now(), videos: data.items?.find(x => String(x.tweet_id) === tweet)?.videos || [] }
    if (sources.size >= 256) sources.delete(sources.keys().next().value!)
    sources.set(tweet, entry)
  }
  const video = entry.videos.find(v => v.index === index && '/' + String(v.poster || '').replace(/^\/+/, '').split('?')[0] === pathname)
  if (!video?.url) throw missing()
  const url = new URL(video.url)
  if (url.protocol !== 'https:' || url.hostname !== 'video.twimg.com' || url.port || url.username || url.password
    || !/^\/(amplify_video|ext_tw_video|tweet_video)\/[^\s]+\.mp4$/.test(url.pathname)) throw missing()
  return url.href
}

async function generate(source: string, target: string) {
  if (active >= 2) await new Promise<void>(done => queue.push(done))
  active++
  let temporary = ''
  try {
    lifetime.signal.throwIfAborted()
    if (await exists(target)) return target
    await mkdir(cache, { recursive: true })
    temporary = await mkdtemp(join(cache, '.poster-'))
    const limit = 8 * 1024 * 1024
    const response = await fetch(source, { redirect: 'error', signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(15_000)]),
      headers: { range: `bytes=0-${limit - 1}`, 'accept-encoding': 'identity' } })
    if (![200, 206].includes(response.status) || !response.headers.get('content-type')?.startsWith('video/')) {
      await response.body?.cancel(); throw new Error('Invalid video response')
    }
    const clip = join(temporary, 'clip.mp4'), poster = join(temporary, 'poster.jpg')
    await writeFile(clip, await bytes(response, limit, true), { flag: 'wx' })
    // ffmpeg receives a bounded local file and cannot open any network protocol.
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe',
      '-threads', '1', '-i', clip, '-ss', '0.1', '-map', '0:v:0', '-vf', 'scale=640:-2', '-frames:v', '1',
      '-q:v', '3', '-threads', '1', '-f', 'image2', poster], { timeout: 12_000, maxBuffer: 256 * 1024, signal: lifetime.signal })
    const image = await readFile(poster)
    if (image.length > 2 * 1024 * 1024 || !image.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) throw new Error('Invalid poster')
    await mkdir(dirname(target), { recursive: true })
    await rename(poster, target)
    return target
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true })
    active--; queue.shift()?.()
  }
}

async function posterFor(tweet: string, index: number, pathname: string) {
  // Keep already delivered public posters usable even if the original host
  // expires or the catalog is briefly restarting. Never overwrite originals.
  const original = join(images, tweet, `video_${index}.jpg`)
  try {
    const file = await open(original, 'r')
    try {
      const info = await file.stat(), prefix = Buffer.alloc(3)
      await file.read(prefix, 0, 3, 0)
      if (info.isFile() && info.size <= 10 * 1024 * 1024 && prefix.equals(Buffer.from([255, 216, 255]))) return original
    } finally { await file.close() }
  } catch { /* Generate only the missing or invalid poster. */ }
  const source = await videoSource(tweet, index, pathname)
  const key = createHash('sha256').update(source).digest('hex')
  const target = join(cache, key.slice(0, 2), key + '.jpg')
  if (await exists(target)) return target
  let pending = inflight.get(key)
  if (!pending) {
    if (inflight.size >= 32) throw busy()
    pending = generate(source, target)
    inflight.set(key, pending)
    void pending.finally(() => { if (inflight.get(key) === pending) inflight.delete(key) }).catch(() => {})
  }
  return pending
}

async function handle(request: IncomingMessage, response: ServerResponse) {
  const empty = (status: number) => {
    if (response.headersSent || response.destroyed) { response.destroy(); return }
    response.writeHead(status, { 'content-length': '0', 'cache-control': 'no-store', ...(status === 503 ? { 'retry-after': '2' } : {}) }).end()
  }
  if (!['GET', 'HEAD'].includes(request.method || '')) { empty(405); return }
  try {
    const pathname = new URL(request.url || '/', 'http://localhost').pathname
    if (pathname === '/health') {
      const value = '{"ok":true,"service":"library-content"}'
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(value) })
      response.end(request.method === 'HEAD' ? undefined : value); return
    }
    let path: string, mime: string, policy: string
    const poster = /^\/images\/(\d{10,24})\/video_(\d{1,2})\.jpg$/.exec(pathname)
    if (poster) {
      if (Number(poster[2]) < 1 || Number(poster[2]) > 20) throw missing()
      path = await posterFor(poster[1], Number(poster[2]), pathname)
      mime = 'image/jpeg'; policy = 'public, max-age=86400'
    } else if (pathname === '/library-content/archive/translations.json' || /^\/library-content\/showcase\/(current\.json|releases\/[a-f0-9]{64}\/(manifest\.json|search\.json|films\/[A-Za-z0-9_-]{1,120}\.json))$/.test(pathname)) {
      path = resolve(root, pathname.replace(/^\/library-content\//, ''))
      if (!path.startsWith(root + sep)) throw missing()
      mime = 'application/json; charset=utf-8'
      policy = pathname.endsWith('/current.json') || pathname === '/library-content/archive/translations.json' ? 'no-cache' : 'public, max-age=31536000, immutable'
    } else throw missing()
    const info = await stat(path)
    if (!info.isFile()) throw missing()
    response.writeHead(200, { 'content-type': mime, 'content-length': info.size, 'cache-control': policy, 'x-content-type-options': 'nosniff' })
    if (request.method === 'HEAD') response.end()
    else await pipeline(createReadStream(path), response)
  } catch (error) {
    if (request.destroyed || response.destroyed) return
    empty(error.code === 'ENOENT' ? 404 : error.status || 502)
  }
}

const server = createServer((request, response) => { void handle(request, response) })
server.listen(Number(process.env.OIP_LIBRARY_CONTENT_PORT || 4177), '127.0.0.1', () => console.log('Library content service listening on loopback'))
server.requestTimeout = 45_000
const stop = () => {
  lifetime.abort()
  server.close()
  server.closeAllConnections()
  void Promise.allSettled([...inflight.values()]).then(() => process.exit(0))
}
process.once('SIGTERM', stop); process.once('SIGINT', stop)
