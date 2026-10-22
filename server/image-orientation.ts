import { spawn } from 'node:child_process'
import { open, readFile } from 'node:fs/promises'
import { localMediaInputOptions } from './media-input.ts'

// 手机照片常把方向写在 EXIF 里而不旋转像素。浏览器按 EXIF 显示，ffmpeg 和多数模型
// 接口却各有各的处理：ffmpeg 6 只转 JPEG、不转 PNG/WebP。凡是要和画布显示一致的地方，
// 都按这里读出的方向自己转，并关掉 ffmpeg 的自动旋转，避免转两次。

const HEAD_BYTES = 1024 * 1024
const ORIENTED_MIME = /^image\/(jpeg|png|webp)$/i

function tiffOrientation(view: DataView, start: number) {
  if (start + 8 > view.byteLength) return 1
  const order = view.getUint16(start)
  const little = order === 0x4949
  if (!little && order !== 0x4d4d) return 1
  if (view.getUint16(start + 2, little) !== 42) return 1
  const ifd = start + view.getUint32(start + 4, little)
  if (ifd + 2 > view.byteLength) return 1
  const count = view.getUint16(ifd, little)
  for (let index = 0; index < count; index++) {
    const entry = ifd + 2 + index * 12
    if (entry + 12 > view.byteLength) return 1
    if (view.getUint16(entry, little) === 0x0112) {
      const value = view.getUint16(entry + 8, little)
      return value >= 1 && value <= 8 ? value : 1
    }
  }
  return 1
}

const isExifHeader = (bytes: Uint8Array, at: number) => bytes[at] === 0x45 && bytes[at + 1] === 0x78 && bytes[at + 2] === 0x69 && bytes[at + 3] === 0x66 && bytes[at + 4] === 0 && bytes[at + 5] === 0

/** 读取 JPEG / PNG / WebP 头部的 EXIF 方向（1–8），没有或读不出时为 1。 */
export function readImageOrientation(head: Uint8Array) {
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength)
  const text = (at: number, length: number) => String.fromCharCode(...head.subarray(at, at + length))
  if (head[0] === 0xff && head[1] === 0xd8) {
    let at = 2
    while (at + 4 <= head.length && head[at] === 0xff) {
      const marker = head[at + 1]
      if (marker === 0xda || marker === 0xd9) break
      const length = view.getUint16(at + 2)
      if (marker === 0xe1 && isExifHeader(head, at + 4)) return tiffOrientation(view, at + 10)
      at += 2 + length
    }
    return 1
  }
  if (head[0] === 0x89 && text(1, 3) === 'PNG') {
    let at = 8
    while (at + 8 <= head.length) {
      const length = view.getUint32(at)
      const type = text(at + 4, 4)
      if (type === 'eXIf') return tiffOrientation(view, at + 8 + (isExifHeader(head, at + 8) ? 6 : 0))
      if (type === 'IDAT' || type === 'IEND') break
      at += 12 + length
    }
    return 1
  }
  if (text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP') {
    let at = 12
    while (at + 8 <= head.length) {
      const type = text(at, 4)
      const length = view.getUint32(at + 4, true)
      if (type === 'EXIF') return tiffOrientation(view, at + 8 + (isExifHeader(head, at + 8) ? 6 : 0))
      at += 8 + length + (length % 2)
    }
  }
  return 1
}

/** 把 EXIF 方向换成 ffmpeg 滤镜；方向为 1 时返回空数组。 */
export function orientationFilters(orientation: number) {
  return ({
    2: ['hflip'],
    3: ['hflip', 'vflip'],
    4: ['vflip'],
    5: ['transpose=0'],
    6: ['transpose=1'],
    7: ['transpose=3'],
    8: ['transpose=2'],
  } as Record<number, string[]>)[orientation] || []
}

/** 读取文件或内存图片的方向；非 JPEG/PNG/WebP 一律当作 1。 */
export async function imageOrientation(source: string | Uint8Array, mime = '') {
  if (mime && !ORIENTED_MIME.test(mime)) return 1
  if (typeof source !== 'string') return readImageOrientation(source.subarray(0, HEAD_BYTES))
  const handle = await open(source, 'r')
  try {
    const buffer = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0)
    return readImageOrientation(buffer.subarray(0, bytesRead))
  } finally { await handle.close() }
}

/**
 * 按 EXIF 方向把像素转正，并去掉方向标记。只处理 JPEG 和 PNG，输出保持原格式，
 * 调用方声明的 MIME 不用跟着改。方向为 1 或其他格式时返回 null，继续用原文件。
 */
export async function applyImageOrientation(source: string | Uint8Array, mime: string, { ffmpeg = process.env.OIP_FFMPEG_PATH || 'ffmpeg', signal }: { ffmpeg?: string; signal?: AbortSignal } = {}) {
  if (!/^image\/(jpeg|png)$/i.test(mime)) return null
  const orientation = await imageOrientation(source, mime)
  const filters = orientationFilters(orientation)
  if (!filters.length) return null
  const jpeg = /jpeg/i.test(mime)
  // 和缩略图一样从管道读，避免 image2 把文件名当成序列模板。
  const input = typeof source === 'string' ? await readFile(source, { signal }) : source
  const args = ['-v', 'error', '-threads', '1', ...localMediaInputOptions({ images: true }), '-noautorotate', '-i', 'pipe:0',
    '-vf', filters.join(','), '-frames:v', '1', '-map_metadata', '-1', '-f', 'image2pipe',
    ...(jpeg ? ['-c:v', 'mjpeg', '-q:v', '2'] : ['-c:v', 'png']), 'pipe:1']
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(ffmpeg, args, { signal, killSignal: 'SIGKILL', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const output: Buffer[] = []
    let errors = ''
    child.stdout.on('data', chunk => output.push(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { if (errors.length < 2048) errors += chunk })
    child.on('error', reject)
    child.on('close', code => code === 0 && output.length ? resolve(Buffer.concat(output)) : reject(new Error(errors.trim().slice(0, 240) || '图片方向校正失败')))
    child.stdin.on('error', () => {})
    child.stdin.end(Buffer.from(input))
  })
  return { bytes, mime: jpeg ? 'image/jpeg' : 'image/png', orientation }
}
