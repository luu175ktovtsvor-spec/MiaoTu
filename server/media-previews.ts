import { spawn } from 'node:child_process'
import { createReadStream, mkdirSync, lstatSync, utimesSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { localMediaInputOptions } from './media-input.ts'
import { MediaJobs, waitForMedia } from './media-jobs.ts'
import { mediaPermissions, writeFileAtomic } from './media-files.ts'
import { sweepPreviewFiles } from './preview-files.ts'

const FFMPEG = process.env.OIP_FFMPEG_PATH || 'ffmpeg'
// 历史卡片的展示框在桌面端约 200 px；320 px 长边已经覆盖高 DPI，同时能
// 让小而简单的 PNG 不因转成 JPEG 反而变大。
const PREVIEW_MAX_DIMENSION = 320
const PREVIEW_TIMEOUT_MS = 20_000

function ffmpegPreview(source, video, maxDimension = PREVIEW_MAX_DIMENSION, signal?: AbortSignal) {
  signal?.throwIfAborted()
  return new Promise<any>((resolve, reject) => {
    // Pipe still images so image2 cannot interpret a filename as a sequence.
    // This also lets JPEG use jpeg_pipe without changing video seek behavior.
    const imageFile = typeof source === 'string' && !video ? createReadStream(source) : null
    const scale = `scale='if(gt(iw,ih),min(iw,${maxDimension}),-2)':'if(gt(iw,ih),-2,min(ih,${maxDimension}))'`
    const args = [
      '-v', 'error',
      '-threads', '1',
      ...localMediaInputOptions({ images: true }),
      '-i', typeof source === 'string' && !imageFile ? source : 'pipe:0',
      '-vf', scale,
      '-frames:v', '1',
      '-f', 'image2pipe',
      '-c:v', 'mjpeg',
      '-q:v', '7',
      'pipe:1',
    ]
    const child = spawn(FFMPEG, args, { signal, killSignal: 'SIGKILL', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const output = []
    let errors = ''
    let settled = false
    let failure: Error | undefined
    let inputDone = Promise.resolve()
    const finish = (error, value?: any) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error != null) reject(error)
      else resolve(value)
    }
    const timer = setTimeout(() => {
      failure = new Error(`生成${video ? '视频首帧' : '图片缩略图'}超时`)
      child.kill('SIGKILL')
    }, PREVIEW_TIMEOUT_MS)
    child.stdout.on('data', chunk => output.push(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { if (errors.length < 4096) errors += chunk.slice(0, 4096 - errors.length) })
    child.on('error', error => { failure = error })
    child.on('close', async code => {
      imageFile?.destroy()
      await inputDone
      if (signal?.aborted) { finish(signal.reason); return }
      if (failure) { finish(failure); return }
      if (code !== 0 || !output.length) {
        const detail = errors.trim().slice(0, 240)
        finish(new Error(detail || `ffmpeg 生成${video ? '视频首帧' : '图片缩略图'}失败`))
        return
      }
      finish(null, Buffer.concat(output))
    })
    child.stdin.on('error', () => {})
    if (imageFile) {
      inputDone = pipeline(imageFile, child.stdin, { signal }).catch(error => {
        // The first image/frame can finish before an animated image is drained.
        if (!['EPIPE', 'ERR_STREAM_PREMATURE_CLOSE', 'ERR_STREAM_DESTROYED'].includes(error.code)) {
          failure ||= error
          child.kill('SIGKILL')
        }
      })
    } else child.stdin.end(typeof source === 'string' ? undefined : Buffer.from(source))
  })
}

export function createMediaPreview(source, { video = false, maxDimension = PREVIEW_MAX_DIMENSION, signal }: Record<string, any> = {}) {
  return ffmpegPreview(source, video, maxDimension, signal)
}

export function createMediaPreviews({ ensureTools = async () => {}, cacheDirectory }: { ensureTools?: () => Promise<unknown>; cacheDirectory?: () => string } = {}) {
  const jobs = new MediaJobs<string>(2)
  const existing = (path: string) => {
    try {
      const info = lstatSync(path)
      if (!info.isFile() || info.isSymbolicLink() || info.size <= 0) return false
      if (cacheDirectory && Date.now() - info.mtimeMs >= 60_000) { const now = new Date(); utimesSync(path, now, now) }
      return true
    } catch { return false }
  }
  let sweeping: Promise<Awaited<ReturnType<typeof sweepPreviewFiles>> | undefined> | undefined
  let nextSweepAt = 0
  const sweep = (force = true) => {
    if (!cacheDirectory || jobs.signal.aborted) return Promise.resolve(undefined)
    if (sweeping) return sweeping
    if (!force && Date.now() < nextSweepAt) return Promise.resolve(undefined)
    nextSweepAt = Date.now() + 60_000
    sweeping = sweepPreviewFiles(cacheDirectory(), { signal: jobs.signal, active: path => jobs.has(path) })
      .catch(error => { if (!jobs.signal.aborted) console.warn('[preview] 缓存回收待重试', error?.code || 'unknown'); return undefined })
      .finally(() => { sweeping = undefined })
    return sweeping
  }
  const timer = cacheDirectory ? setInterval(() => { void sweep() }, 15 * 60_000) : undefined
  timer?.unref()
  if (cacheDirectory) void sweep()
  return {
    async read(path: string, source: string | Buffer, { video = false, maxDimension = PREVIEW_MAX_DIMENSION, beforeCommit = () => {} } = {}, signal?: AbortSignal) {
      path = resolve(path)
      jobs.signal.throwIfAborted(); signal?.throwIfAborted()
      if (existing(path)) { beforeCommit(); return path }
      return jobs.run(path, async (taskSignal, validateReaders) => {
        if (existing(path)) { validateReaders(); return path }
        await waitForMedia(ensureTools(), taskSignal); taskSignal.throwIfAborted()
        const preview = await createMediaPreview(source, { video, maxDimension, signal: taskSignal })
        taskSignal.throwIfAborted(); validateReaders()
        mkdirSync(dirname(path), { recursive: true, mode: mediaPermissions().directory })
        writeFileAtomic(path, preview)
        void sweep(false)
        return path
      }, signal, beforeCommit)
    },
    sweep: () => sweep(),
    async stop() { clearInterval(timer); await Promise.allSettled([jobs.stop(), sweeping]) },
  }
}

export const MEDIA_PREVIEW_MIME = 'image/jpeg'
