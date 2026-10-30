import { spawn } from 'node:child_process'
import { MediaJobs, execMedia, waitForMedia } from '../server/media-jobs.ts'

type AudioFile = { path: string; revision: string; diskPath?: string | null; mime: string }
type Tools = { ensureTools?: () => Promise<void>; ffmpeg?: () => string; ffprobe?: () => string }
const BARS = 128
// Do not let an indexed audio file act as an indirect playlist or input URL.
const FORMATS = 'wav,mp3,mov,matroska,webm,ogg,flac,aac,aiff,au,caf,amr,ac3,eac3,dts,ape,wv,tta,w64,dsf,iff'

async function extract(file: AudioFile, ffmpeg: string, ffprobe: string, signal: AbortSignal) {
  signal.throwIfAborted()
  const input = ['-protocol_whitelist', 'file,pipe', '-format_whitelist', FORMATS, '-i', file.diskPath!]
  const metadata = await execMedia(ffprobe, ['-v', 'error', ...input, '-show_entries', 'stream=index,codec_type,sample_rate,duration,duration_ts,time_base:stream_disposition=default:format=duration', '-of', 'json'],
    { signal, maxBuffer: 128 * 1024 })
  signal.throwIfAborted()
  const media = JSON.parse(metadata) as { streams?: { index: number; codec_type?: string; sample_rate?: string; duration?: string; duration_ts?: number; time_base?: string; disposition?: { default?: number } }[]; format?: { duration?: string } }
  const streams = media.streams?.filter(stream => stream.codec_type === 'audio') || []
  const audio = streams.find(stream => stream.disposition?.default) || streams[0]
  const [numerator, denominator] = (audio?.time_base || '').split('/').map(Number)
  const exactDuration = Number(audio?.duration_ts) * numerator! / denominator!
  const duration = [exactDuration, Number(audio?.duration), Number(media.format?.duration)].find(value => Number.isFinite(value) && value > 0)
  const rate = Number(audio?.sample_rate)
  if (!audio || !duration || !Number.isFinite(rate) || rate <= 0) throw new Error('无法读取音频波形的时长和采样率')
  // Keep each decoded frame bounded even for long recordings. astats supplies
  // the maximum across channels, without cancelling opposite-phase channels.
  const samples = Math.max(1, Math.min(4096, Math.floor(duration * rate / BARS)))
  const filter = `asetpts=PTS-STARTPTS,asetnsamples=n=${samples}:p=0,astats=metadata=1:reset=1:measure_perchannel=none:measure_overall=Peak_level,ametadata=mode=print:key=lavfi.astats.Overall.Peak_level:file=-`
  return new Promise<number[]>((resolve, reject) => {
    const child = spawn(ffmpeg, ['-v', 'error', '-nostdin', '-threads', '1', '-filter_threads', '1', ...input, '-map', `0:${audio.index}`, '-vn', '-sn', '-dn', '-af', filter, '-f', 'null', '-'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const peaks = Array<number>(BARS).fill(0)
    let text = '', errors = '', time = 0, frames = 0, failure: Error | undefined
    const abort = () => { child.kill('SIGKILL') }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    const line = (value: string) => {
      const position = /^frame:\d+\s+pts:\S+\s+pts_time:(\S+)/.exec(value)
      if (position) { time = Number(position[1]); return }
      if (!value.startsWith('lavfi.astats.Overall.Peak_level=')) return
      const level = Number(value.slice(value.indexOf('=') + 1).replace(/^-inf$/i, '-Infinity'))
      if (!Number.isFinite(time) || time < 0 || !Number.isFinite(level) && level !== -Infinity) return
      frames++
      const peak = level === -Infinity ? 0 : 10 ** (level / 20)
      if (!Number.isFinite(peak)) return
      const first = Math.min(BARS - 1, Math.floor(time / duration * BARS))
      const last = Math.min(BARS - 1, Math.ceil((time + samples / rate) / duration * BARS) - 1)
      for (let bar = first; bar <= last; bar++) peaks[bar] = Math.max(peaks[bar]!, peak)
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      text += chunk
      let end: number
      while ((end = text.indexOf('\n')) >= 0) { line(text.slice(0, end).trim()); text = text.slice(end + 1) }
      if (text.length > 4096) { failure = new Error('音频波形回执异常'); abort() }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { errors = (errors + chunk).slice(-2048) })
    // close follows process exit and stream release, including failed spawn.
    child.on('error', error => { failure = error })
    child.on('close', code => {
      signal.removeEventListener('abort', abort)
      if (signal.aborted) { reject(signal.reason); return }
      if (failure || code !== 0) { reject(failure || new Error(errors.trim() || '音频波形提取失败')); return }
      if (text.trim()) line(text.trim())
      if (!frames) { reject(new Error('音频波形回执为空')); return }
      const maximum = Math.max(...peaks)
      resolve(maximum > 0 ? peaks.map(peak => peak / maximum) : peaks)
    })
  })
}

export function createAudioWaveforms({ ensureTools = async () => {}, ffmpeg = () => process.env.OIP_FFMPEG_PATH || 'ffmpeg', ffprobe = () => process.env.OIP_FFPROBE_PATH || 'ffprobe' }: Tools = {}) {
  const jobs = new MediaJobs<number[]>(1, { timeoutMs: 120000 })
  const cache = new Map<string, number[]>()

  async function read(scope: string, file: AudioFile, signal?: AbortSignal, beforeCommit: () => void = () => {}): Promise<number[]> {
    signal?.throwIfAborted(); jobs.signal.throwIfAborted()
    if (!file.diskPath || !file.mime.startsWith('audio/')) throw Object.assign(new Error('当前文件无法在本机提取音频波形'), { status: 422 })
    const key = JSON.stringify([scope, file.path, file.revision])
    const cached = cache.get(key)
    if (cached) { await beforeCommit(); cache.delete(key); cache.set(key, cached); return [...cached] }
    if (!jobs.has(key) && jobs.size >= 32) throw Object.assign(new Error('音频波形正在排队，请稍后重试'), { status: 503 })
    const peaks = await jobs.run(key, async (taskSignal, validateReaders) => {
      taskSignal.throwIfAborted()
      await waitForMedia(ensureTools(), taskSignal)
      taskSignal.throwIfAborted()
      const peaks = await extract(file, ffmpeg(), ffprobe(), taskSignal)
      taskSignal.throwIfAborted()
      await validateReaders()
      cache.set(key, peaks)
      if (cache.size > 256) cache.delete(cache.keys().next().value!)
      return peaks
    }, signal, beforeCommit)
    return [...peaks]
  }
  return { read, async stop() { cache.clear(); await jobs.stop() } }
}
