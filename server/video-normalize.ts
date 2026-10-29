// 视频落盘前的无损转封装。
//
// 为什么需要：上传的视频如果是「moov（索引）在文件末尾、音视频轨道分开存」的 QuickTime 排版
// ——Safari/QuickTime 录屏、部分手机导出、某些 AI 生成器都这样——浏览器必须把整个文件拉完
// 才能开始播，用户看到的就是「传上去了，但播放不了 / 转圈半天」。2026-10-06 线上实测：一个
// 41MB 的上传素材，Safari 先只拿到 2 字节，然后卡了两分钟才去要最后 32MB 才拿到索引，最后
// 放弃；同一时间用 Chrome 打开，浏览器为了拿到索引把 41MB 的文件拉了两遍（78.8MB）。
//
// 做法：落盘前跑一次 `ffmpeg -c copy -movflags +faststart`，只重写容器（索引搬到文件开头、
// 把轨道交错起来），画面和声音一个字节都不重新编码。实测 41MB / 22 秒的素材耗时 1.3 秒。
//
// 显式映射全部轨道、元信息及章节；容器不能保留时转封装失败，保持原文件，不能丢轨道后保存。
// 失败一律放行（返回原字节，只记一行日志）：本机开发环境没装 ffmpeg、素材本身特殊、
// 或者超过体积上限，都不该让「上传」这件事失败。
import { execFile } from 'node:child_process'
import { mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.m4v', '.qt']
// 超过这个体积不做（转封装是 IO 密集的，请求会一直挂着；先保住上传本身的可用性）。
const MAX_BYTES = 512 * 1024 * 1024
const TIMEOUT_MS = 120_000

export function looksLikeVideo(path, mime = '') {
  if (/^video\//i.test(String(mime || ''))) return true
  const lower = String(path || '').toLowerCase()
  return VIDEO_EXTENSIONS.some((extension) => lower.endsWith(extension))
}

// moov 出现在 mdat 之前 = 已经是 faststart，不用动。只看前 1MB 的顶层 atom 顺序就够了。
export function needsFaststart(bytes) {
  let offset = 0
  const limit = Math.min(bytes.length, 1024 * 1024)
  while (offset + 8 <= limit) {
    let size = bytes.readUInt32BE(offset)
    const type = bytes.toString('latin1', offset + 4, offset + 8)
    if (size === 1) {
      if (offset + 16 > limit) break
      size = Number(bytes.readBigUInt64BE(offset + 8))
    }
    if (type === 'moov') return false
    if (type === 'mdat') return true
    if (!Number.isFinite(size) || size < 8) break
    offset += size
  }
  // 解析不出来（不是 MP4 系、或者结构古怪）就不动它。
  return false
}

function run(command, args, signal?: AbortSignal) {
  return new Promise<any>((resolve, reject) => {
    execFile(command, args, { timeout: TIMEOUT_MS, windowsHide: true, signal }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).trim().slice(0, 200) || 'ffmpeg 执行失败'))
      else resolve(stdout)
    })
  })
}

function remux(ffmpeg, input, output, signal?: AbortSignal) {
  return run(ffmpeg, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-i', input, '-map', '0', '-map_metadata', '0', '-map_chapters', '0', '-c', 'copy', '-movflags', '+faststart', '-y', output], signal)
}

// The receiver already owns a closed file. Keep it on disk through remux and
// publication; callers must consume the chosen path before this callback ends.
export async function withNormalizedVideoFile<T>(input: { path: string; size: number; sha256?: string },
  { path, mime, ffmpeg = 'ffmpeg', signal }: Record<string, any>,
  consume: (file: { path: string; size: number; sha256?: string }) => T | Promise<T>,
) {
  signal?.throwIfAborted()
  if (!looksLikeVideo(path, mime) || input.size < 1024 || input.size > MAX_BYTES) return (await consume(input))
  const handle = await open(input.path, 'r')
  let faststart
  try {
    const prefix = Buffer.alloc(Math.min(input.size, 1024 * 1024))
    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0)
    faststart = needsFaststart(prefix.subarray(0, bytesRead))
  } finally { await handle.close() }
  signal?.throwIfAborted()
  if (!faststart) return (await consume(input))
  const directory = await mkdtemp(join(tmpdir(), 'miaoimg-remux-'))
  let selected = input
  try {
    const output = join(directory, 'out.mp4')
    try {
      await remux(ffmpeg, input.path, output, signal)
      const fixed = await stat(output)
      if (fixed.size >= 1024) selected = { path: output, size: fixed.size }
    } catch (error) {
      signal?.throwIfAborted()
      console.warn(`[video-normalize] 跳过（保持原样）：${path} ${error?.message || error}`)
    }
    signal?.throwIfAborted()
    return await consume(selected)
  } finally { await rm(directory, { recursive: true, force: true }).catch(() => {}) }
}

export async function normalizeVideoBuffer(bytes, { path, mime, ffmpeg = 'ffmpeg' }: Record<string, any> = {}) {
  if (!Buffer.isBuffer(bytes)) return { bytes, changed: false, reason: 'not-buffer' }
  if (!looksLikeVideo(path, mime)) return { bytes, changed: false, reason: 'not-video' }
  // 下限只为挡掉「根本不是视频的碎片」：几十 KB 的测试小视频也该被修，所以放得很低。
  if (bytes.length < 1024) return { bytes, changed: false, reason: 'too-small' }
  if (bytes.length > MAX_BYTES) return { bytes, changed: false, reason: 'too-large' }
  if (!needsFaststart(bytes)) return { bytes, changed: false, reason: 'already-faststart' }
  const directory = await mkdtemp(join(tmpdir(), 'miaoimg-remux-'))
  const extension = String(path || '').toLowerCase().match(/\.[a-z0-9]{1,5}$/)?.[0] || '.mp4'
  const input = join(directory, `in${extension}`)
  const output = join(directory, 'out.mp4')
  try {
    await writeFile(input, bytes)
    await remux(ffmpeg, input, output)
    const fixed = await readFile(output)
    if (fixed.length < 1024) return { bytes, changed: false, reason: 'ffmpeg-empty' }
    console.log(`[video-normalize] 转封装完成：${path} ${bytes.length} → ${fixed.length} 字节（索引移到文件开头，未重编码）`)
    return { bytes: fixed, changed: true, reason: 'remuxed' }
  } catch (error) {
    console.warn(`[video-normalize] 跳过（保持原样）：${path} ${error?.message || error}`)
    return { bytes, changed: false, reason: 'ffmpeg-failed' }
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {})
  }
}
