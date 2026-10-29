import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, readdirSync, renameSync, rmSync, statSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { alignMediaOwner, ensureMediaDirectory, mediaRoot, mediaPermissions } from './media-files.ts'
import { localMediaInputOptions, MEDIA_INPUT_VERSION } from './media-input.ts'
import { MediaJobs, waitForMedia, execMedia } from './media-jobs.ts'

export function createVideoPlayback({ root = mediaRoot, ensureTools = async () => {}, ffmpeg = () => process.env.OIP_FFMPEG_PATH || 'ffmpeg' }: Record<string, any> = {}) {
  const jobs = new MediaJobs<any>(1)
  const MAX_CACHE = 512 * 1024 * 1024
  const TTL = 24 * 60 * 60 * 1000
  // 播放缓存不进入工作区/生成索引；原片下载及模型输入始终沿用原 URL。
  function prune() {
    const directory = root()
    const entries = []
    for (const owner of readdirSync(directory, { withFileTypes: true })) {
      if (!owner.isDirectory() || owner.name.startsWith('.')) continue
      const folder = join(directory, owner.name, '_previews')
      try { for (const file of readdirSync(folder)) {
        if (/^playback-v[12]-[a-f0-9]{64}\.mp4\.tmp-[a-f0-9-]+\.mp4$/.test(file)) {
          const path = join(folder, file)
          if (Date.now() - statSync(path).mtimeMs > 10 * 60 * 1000) rmSync(path, { force: true })
          continue
        }
        if (!/^playback-v[12]-[a-f0-9]{64}\.mp4$/.test(file)) continue
        const path = join(folder, file), info = statSync(path)
        entries.push({ path, size: info.size, touched: info.mtimeMs })
      } } catch { /* 无缓存 */ }
    }
    entries.sort((a,b) => b.touched - a.touched)
    let retained = 0
    for (const item of entries) {
      if (Date.now() - item.touched > TTL || retained + item.size > MAX_CACHE) rmSync(item.path, { force: true })
      else retained += item.size
    }
  }
  const sweep = setInterval(() => { try { prune() } catch { /* 稍后重试 */ } }, 15 * 60 * 1000)
  sweep.unref()
  async function playback(owner, file, { signal, beforeCommit = () => {} }: { signal?: AbortSignal; beforeCommit?: () => void } = {}) {
    signal?.throwIfAborted()
    if (jobs.signal.aborted || !file.diskPath || !file.mime.startsWith('video/')) return null
    const key = createHash('sha256').update(String(file.blob || file.path + ':' + file.revision)).digest('hex')
    const folder = join(root(), owner, '_previews')
    ensureMediaDirectory(folder)
    const path = join(folder, `playback-v${MEDIA_INPUT_VERSION}-${key}.mp4`)
    const existing = () => {
      try { const info = statSync(path); if (info.size > 0) { const time = new Date(); utimesSync(path, time, time); return { ...file, diskPath: path, bytes: null, mime: 'video/mp4', size: info.size, revision: file.revision + `-playback-v${MEDIA_INPUT_VERSION}` } } } catch { /* 尚未生成 */ }
      return null
    }
    await beforeCommit()
    const ready = existing()
    if (ready) return ready
    if (!jobs.has(path) && jobs.size >= 8) return null
    return jobs.run(path, async (taskSignal, validateReaders) => {
      try {
        const cached = existing(); if (cached) { await validateReaders(); return cached }
        taskSignal.throwIfAborted()
        await waitForMedia(ensureTools(), taskSignal)
        taskSignal.throwIfAborted()
        prune()
        const temporary = path + '.tmp-' + randomUUID() + '.mp4'
        try {
          // 只压播放预览：不裁剪、不拉伸、不替换原件；一次一个工作进程、两个线程。
          await execMedia(ffmpeg(), ['-v','error','-threads','2',...localMediaInputOptions(),'-i',file.diskPath,'-map','0:v:0','-map','0:a:0?','-vf',"scale='if(gt(iw,ih),min(iw,720),-2)':'if(gt(iw,ih),-2,min(ih,720))'",'-fpsmax','30','-c:v','libx264','-threads','2','-preset','veryfast','-crf','26','-maxrate','1200k','-bufsize','2400k','-pix_fmt','yuv420p','-c:a','aac','-b:a','96k','-movflags','+faststart','-y',temporary],
            {timeout:180000,maxBuffer:512*1024,signal:taskSignal})
          taskSignal.throwIfAborted(); await validateReaders()
          if (statSync(temporary).size > 64 * 1024 * 1024) throw new Error('播放缓存过大')
          chmodSync(temporary, mediaPermissions().file); alignMediaOwner(temporary); renameSync(temporary,path)
          const result = existing(); prune(); return result
        } finally { rmSync(temporary,{force:true}) }
      } catch (error) {
        if (taskSignal.aborted || [403,409,410].includes(Number(error?.status))) throw error
        console.warn('[video-playback] 预览暂不可用：'+error.message); return null
      }
    }, signal, beforeCommit)
  }

  return { playback, async stop() { clearInterval(sweep); await jobs.stop() } }
}
let shared
export function videoPlayback(owner, file, options?: { signal?: AbortSignal; beforeCommit?: () => void }) {
  shared ||= createVideoPlayback()
  return shared.playback(owner, file, options)
}
export async function stopVideoPlayback() { await shared?.stop() }
