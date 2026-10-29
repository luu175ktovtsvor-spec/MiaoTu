// Read-only video inspection for the Agent. Source media stays in account-scoped storage.
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { failure } from './management-store.ts'

// Only locally created results can carry native images; browser JSON cannot forge this marker.
export const VIDEO_REVIEW_CONTENT = Symbol('miaoimg.videoReview.content')
// Uploaded playlists must not cause subprocesses to fetch URLs or read other local files.
const INPUT_OPTIONS = ['-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm,avi,flv,mpeg,mpegvideo,mpegts,ogg,asf,mxf,h264,hevc']

function capture(command, args, signal, maxBytes = 1024 * 1024) {
  return new Promise<any>((resolve, reject) => {
    signal?.throwIfAborted()
    const process = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks = []
    let size = 0, stderr = '', finished = false
    let stopped: unknown
    const finish = (error, data?: any) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve(data)
    }
    // A kill request can precede process/stdio close. Keep the caller's files
    // owned until close, including cancellation, output limits and spawn errors.
    const stop = (error) => { stopped ??= error; process.kill('SIGKILL') }
    const abort = () => stop(signal.reason || new Error('已停止视频分析'))
    // This is a read-only probe, never a generation request or a paid retry.
    const timer = setTimeout(() => stop(failure('视频读取暂未完成，请稍后重新分析同一素材', 504)), 30_000)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    process.stdout.on('data', chunk => {
      if (stopped !== undefined) return
      size += chunk.length
      if (size > maxBytes) stop(failure('采样画面超过读取上限', 413))
      else chunks.push(chunk)
    })
    process.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2000) })
    process.on('error', error => { stopped ??= error })
    process.on('close', code => {
      if (stopped !== undefined) finish(stopped)
      else if (code !== 0) finish(failure('无法读取这段视频，请检查素材是否完整或选择其他视频', 422))
      else finish(null, Buffer.concat(chunks))
    })
  })
}

export function createVideoReviewTool({ workspaceFiles, userId, signal, maxFrames = 8 }: Record<string, any>) {
  return {
    name: 'inspectVideo',
    description: '查看当前账号工作区视频的真实采样画面，返回按时间顺序排列的图片和元信息。默认均匀采样6帧，可指定1–8个秒数，适合视频复刻与镜头分析；不转写声音，不代表看过全部画面。不接收外部URL或其他账号路径，不创建原片副本。',
    parameters: {
      type: 'object', additionalProperties: false, required: ['path'],
      properties: {
        path: { type: 'string', minLength: 1, maxLength: 1024, description: 'listWorkspaceFiles或节点输出返回的工作区相对路径' },
        frameCount: { type: 'integer', minimum: 1, maximum: maxFrames, description: '均匀采样帧数，默认6；与timestamps二选一' },
        timestamps: { type: 'array', minItems: 1, maxItems: maxFrames, uniqueItems: true, items: { type: 'number', minimum: 0 }, description: '要查看的秒数，不得超过视频时长；与frameCount二选一' },
      },
    },
    async execute(args: Record<string, any> = {}, context: Record<string, any> = {}) {
      const activeSignal = context.signal || signal
      if (typeof args.path !== 'string' || !args.path.trim() || args.path.length > 1024) throw failure('请选择工作区视频', 422)
      if (args.timestamps !== undefined && args.frameCount !== undefined) throw failure('采样帧数与时间点请任选一种', 422)
      const count = args.frameCount ?? 6
      if (!Number.isInteger(count) || count < 1 || count > maxFrames) throw failure('每次可查看1–8帧画面', 422)
      if (args.timestamps !== undefined && (!Array.isArray(args.timestamps) || !args.timestamps.length || args.timestamps.length > maxFrames || args.timestamps.some(t => !Number.isFinite(t) || t < 0) || new Set(args.timestamps).size !== args.timestamps.length)) throw failure('采样时间点无效', 422)
      activeSignal?.throwIfAborted()
      // locate enforces account/project ownership before any subprocess sees the path.
      const located = (await workspaceFiles.locate(userId, args.path))
      let temporary
      try {
        let input = located.diskPath
        if (!input) {
          temporary = await mkdtemp(join(tmpdir(), 'miaoimg-video-review-'))
          input = join(temporary, 'source')
          await writeFile(input, located.bytes)
        }
        const raw = await capture('ffprobe', ['-v', 'error', ...INPUT_OPTIONS, '-show_streams', '-show_format', '-of', 'json', input], activeSignal)
        const probe = JSON.parse(raw.toString())
        const video = probe.streams?.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic)
        const audio = probe.streams?.find(stream => stream.codec_type === 'audio')
        const duration = Number(video?.duration || probe.format?.duration)
        if (!video || !Number.isFinite(duration) || duration <= 0 || !video.width || !video.height) throw failure('素材中没有可采样的视频画面', 422)
        if (video.width * video.height > 67_108_864 || video.width > 16384 || video.height > 16384) throw failure('视频尺寸过大，请选择较小尺寸的参考视频', 422)
        const [fpsNumerator, fpsDenominator = 1] = String(video.avg_frame_rate || '0/1').split('/').map(Number)
        const fps = fpsDenominator ? fpsNumerator / fpsDenominator : 0
        const last = Math.max(0, duration - Math.max(0.1, fps > 0 ? 1 / fps : 0.1))
        const times = args.timestamps
          ? [...args.timestamps].sort((a, b) => a - b)
          : Array.from({ length: count }, (_, index) => Number((count === 1 ? last / 2 : last * index / (count - 1)).toFixed(3)))
        if (times.some(t => t >= duration)) throw failure('采样时间点超出视频时长', 422)
        const content = []
        const sampled = []
        for (const requested of times) {
          const time = Math.min(requested, last)
          const jpeg = await capture('ffmpeg', ['-nostdin', '-v', 'error', '-ss', String(time), ...INPUT_OPTIONS, '-i', input, '-map', '0:' + video.index, '-frames:v', '1', '-vf', "scale=512:512:force_original_aspect_ratio=decrease", '-q:v', '4', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'], activeSignal)
          if (!jpeg.length || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw failure('未取到这个时间点的画面，请选择更早的时间点', 422)
          sampled.push({ requestedSeconds: requested, seekSeconds: time })
          content.push({ type: 'text', text: '采样画面 ' + sampled.length + '，定位时间 ' + time + ' 秒（非精确剪切边界）' }, { type: 'image', data: jpeg.toString('base64'), mimeType: 'image/jpeg' })
        }
        const summary = {
          path: located.path || args.path, duration, width: video.width, height: video.height, fps,
          hasAudio: Boolean(audio), frameCount: sampled.length, samples: sampled,
          limitation: '仅查看上述采样画面，未完整观看、未识别对白或音乐；需要更细节时指定时间点继续采样。',
        }
        return { summary, [VIDEO_REVIEW_CONTENT]: [{ type: 'text', text: JSON.stringify(summary) }, ...content] }
      } finally {
        if (temporary) await rm(temporary, { recursive: true, force: true })
      }
    },
  }
}
