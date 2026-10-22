import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileContentHeaders } from './file-content-policy.ts'

type FileRequest = Pick<IncomingMessage, 'method' | 'headers'>
type FileContent = { mime: string; diskPath?: string | null; bytes?: Uint8Array | null; size?: number }

// An opaque ETag may contain commas. Parse complete quoted tags rather than
// splitting the field inside a tag; empty HTTP list members can be skipped.
function entityTags(value: string): string[] | '*' | null {
  if (value.trim() === '*') return '*'
  const tags: string[] = []
  const tag = /(?:W\/)?"[\x21\x23-\x7e\x80-\xff]*"/y
  let offset = 0
  while (offset < value.length) {
    while (/[\t ,]/.test(value[offset] || '\n')) offset++
    if (offset === value.length) break
    tag.lastIndex = offset
    const match = tag.exec(value)
    if (!match) return null
    tags.push(match[0])
    offset = tag.lastIndex
    while (value[offset] === ' ' || value[offset] === '\t') offset++
    if (offset < value.length && value[offset] !== ',') return null
  }
  return tags.length ? tags : null
}

// Call only after selecting an existing, authorized representation. Accelerated
// Nginx responses share these preconditions, but keep Nginx's own Range support.
export function filePreconditionStatus(request: FileRequest, etag = ''): 304 | 412 | null {
  const ifMatch = request.headers['if-match']
  if (typeof ifMatch === 'string') {
    const tags = entityTags(ifMatch)
    if (tags !== '*' && (!tags || !etag || etag.startsWith('W/') || !tags.includes(etag))) return 412
  }
  const ifNoneMatch = request.headers['if-none-match']
  if (typeof ifNoneMatch === 'string') {
    const tags = entityTags(ifNoneMatch)
    if (tags === '*' || tags && etag && tags.some(tag => tag.replace(/^W\//, '') === etag.replace(/^W\//, ''))) {
      return request.method === 'GET' || request.method === 'HEAD' ? 304 : 412
    }
  }
  return null
}

function fileRange(request: FileRequest, size: number, etag: string) {
  const full = { status: 200, start: 0, end: size - 1, length: size }
  // RFC 9110: Range applies only to GET. We do not advertise Last-Modified,
  // so only a matching strong ETag can validate If-Range here.
  if (request.method !== 'GET' || typeof request.headers.range !== 'string') return full
  const ifRange = request.headers['if-range']
  if (ifRange !== undefined && (typeof ifRange !== 'string' || !etag || etag.startsWith('W/') || ifRange.trim() !== etag)) return full
  const match = /^bytes=(\d*)-(\d*)$/i.exec(request.headers.range.trim())
  // Unsupported multipart, unknown units and malformed ranges may be ignored.
  if (!match || !match[1] && !match[2]) return full
  const total = BigInt(size)
  const first = match[1] ? BigInt(match[1]) : null
  const last = match[2] ? BigInt(match[2]) : null
  if (first !== null && last !== null && last < first) return full
  if (!size || first !== null && first >= total || first === null && last === 0n) {
    return { status: 416, start: 0, end: -1, length: 0 }
  }
  // Clamp before Number conversion: HTTP decimal positions have no fixed width.
  const start = first !== null ? Number(first) : last! >= total ? 0 : size - Number(last)
  const end = first === null || last === null || last >= total ? size - 1 : Number(last)
  return { status: 206, start, end, length: end - start + 1 }
}

// Authorization and path containment stay with the caller. Open, stat and stream
// one descriptor so atomic replacement cannot switch the bytes mid-response.
export async function serveFileContent(request: IncomingMessage, response: ServerResponse, content: FileContent,
  { headers = {}, etag = '' }: { headers?: OutgoingHttpHeaders; etag?: string } = {}) {
  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    let size: number
    if (content.diskPath) {
      // Do not block forever if an external process replaces a file with a FIFO.
      const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NONBLOCK)
      try { file = await open(content.diskPath, flags) }
      catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') error.status = 404; throw error }
      const info = await file.stat()
      if (!info.isFile()) return false
      size = info.size
      if (content.size !== undefined && content.size !== size) throw Object.assign(new Error('文件已更新，请刷新后重试'), { status: 409 })
    } else if (content.bytes) size = content.bytes.byteLength
    else throw Object.assign(new Error('文件不存在'), { status: 404 })
    if (!Number.isSafeInteger(size) || size < 0) throw Object.assign(new Error('无法读取文件大小'), { status: 409 })
    if (response.destroyed || response.writableEnded) return true
    const common = { ...headers, 'content-type': content.mime, ...fileContentHeaders(content.mime), 'accept-ranges': 'bytes', ...(etag ? { etag } : {}) }
    const condition = filePreconditionStatus(request, etag)
    if (condition) {
      response.writeHead(condition, { ...common, ...(condition === 412 ? { 'content-length': 0 } : {}) })
      response.end()
      return true
    }
    const { status, start, end, length } = fileRange(request, size, etag)
    response.writeHead(status, { ...common, 'content-length': length,
      ...(status === 416 ? { 'content-range': `bytes */${size}` } : status === 206 ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}) })
    if (request.method === 'HEAD' || !length) response.end()
    else if (file) {
      let sent = 0
      const measured = new Transform({
        transform(chunk, _encoding, done) { sent += chunk.length; done(null, chunk) },
        flush(done) { done(sent === length ? null : new Error('File changed while reading')) },
      })
      await pipeline(file.createReadStream({ start, end }), measured, response)
    } else response.end(content.bytes!.subarray(start, end + 1))
    return true
  } finally {
    // Streams auto-close too; this also closes HEAD/304/errors before streaming.
    await file?.close().catch(() => {})
  }
}
