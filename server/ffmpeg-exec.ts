import { isWorkspaceRequest } from './canvas-document.ts'
// 浏览器 FFmpeg 执行链路：MiaoImg 的 POST /api/ffmpeg/execute 契约在妙图里的实现。
//
// 与上游的差异：妙图的工作区文件存在服务端（数据库瘦索引 + MEDIA_ROOT 磁盘字节），
// 没有一个可以直接交给 ffmpeg 的工作目录。所以每个任务先开一个临时沙箱目录，把任务引用得到
// 的工作区文件落成真实文件，用系统 ffmpeg / ffprobe 在沙箱里执行，结束后把沙箱里新增或改动的
// 文件回写工作区。
// 沙箱路径只可能来自 workspaceFiles.path() 校验过的相对路径，不接受绝对路径、协议地址、
// 反斜杠或 ..，因此任务无法读写工作区以外的任何文件。
//
// 事件流形状与上游 packages/ffmpeg/src/remote.ts 完全一致（SSE 的 data 是 {event,args}），
// 前端 scaffold/browserFfmpeg.ts 直接复用同一套解析，不需要额外适配。
//
// 两个与上游有意为之的差异，改动前先读这两条：
// 1. 素材范围：沙箱只放入「参数里字面出现、且当前工作区确实存在」的路径。清单文件、
//    frame%03d.png 这类图片序列、movie=/subtitles= 指向的相对文件都不会自动带进来。
// 2. 安全口径：上游把原始参数、滤镜和清单里的间接 I/O 当作可信代码，因为它的 ffmpeg
//    跑在用户自己的机器上；妙图是多账号托管，同一个进程服务所有账号，普通账号用
//    -i /etc/passwd 就能读服务器文件。所以这里对每个参数都做工作区校验，宁严勿松。
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { failure } from './management-store.ts'
import { WORKSPACE_FILE_MAX_BYTES } from './workspace-files.ts'
import { currentProject, DEFAULT_PROJECT_ID } from './workspace-scope.ts'
import { isInternalAssetPath, isProtectedWorkspacePath } from './workspace-path.ts'

// 任务上限。取值的思路照抄上游（execute.ts 的 zod 约束、tools/ffmpeg 的语义），
// 但按“单机单进程 + 一家一份 SQLite”收紧到能稳住本机与生产镜像的量级。
export const FFMPEG_LIMITS = {
  requestBytes: 512 * 1024, // 单次请求体：calls 全是 JSON 调用数据，不含媒体
  maxCalls: 2048, // 单任务链式调用条数（上游 2048）
  maxArgs: 128, // 单条调用的参数个数（上游 128）
  maxMethodLength: 64, // 方法名长度（上游 64）
  taskTimeoutMs: 10 * 60 * 1000, // 单任务执行时长上限，超时发 SIGKILL
  maxConcurrentTasks: 3, // 进程内同时运行的 ffmpeg 任务数上限
  sandboxMaxBytes: 512 * 1024 * 1024, // 单任务落进沙箱的素材总量上限
  maxOutputFiles: 64, // 单任务回写工作区的文件个数上限
  outputMaxBytes: WORKSPACE_FILE_MAX_BYTES, // 单个产物与工作区写入上限一致（200MB）
  queryTimeoutMs: 30 * 1000, // 能力查询（-filters/-codecs 等）与 ffprobe 的超时
}

// ---- fluent-ffmpeg 的方法表：与上游 packages/ffmpeg/src/browserTypes.ts 逐条对齐 ----
// 前端只传方法名和参数数组，执行、路径校验都在这里完成。

export const chainMethods = [
  'input', 'addInput', 'mergeAdd', 'withInputFormat', 'inputFormat', 'fromFormat',
  'withInputFps', 'withInputFPS', 'withFpsInput', 'withFPSInput', 'inputFPS', 'inputFps', 'fpsInput', 'FPSInput',
  'nativeFramerate', 'withNativeFramerate', 'native', 'setStartTime', 'seekInput', 'loop',
  'withNoAudio', 'noAudio', 'withAudioCodec', 'audioCodec', 'withAudioBitrate', 'audioBitrate',
  'withAudioChannels', 'audioChannels', 'withAudioFrequency', 'audioFrequency', 'withAudioQuality', 'audioQuality',
  'withAudioFilter', 'withAudioFilters', 'audioFilter', 'audioFilters', 'withNoVideo', 'noVideo',
  'withVideoCodec', 'videoCodec', 'withVideoBitrate', 'videoBitrate', 'withVideoFilter', 'withVideoFilters', 'videoFilter', 'videoFilters',
  'withOutputFps', 'withOutputFPS', 'withFpsOutput', 'withFPSOutput', 'withFps', 'withFPS', 'outputFPS', 'outputFps', 'fpsOutput', 'FPSOutput', 'fps', 'FPS',
  'takeFrames', 'withFrames', 'frames', 'keepPixelAspect', 'keepDisplayAspect', 'keepDisplayAspectRatio', 'keepDAR',
  'withSize', 'setSize', 'size', 'withAspect', 'withAspectRatio', 'setAspect', 'setAspectRatio', 'aspect', 'aspectRatio',
  'applyAutopadding', 'applyAutoPadding', 'applyAutopad', 'applyAutoPad', 'withAutopadding', 'withAutoPadding', 'withAutopad', 'withAutoPad', 'autoPad', 'autopad',
  'addOutput', 'output', 'seekOutput', 'seek', 'withDuration', 'setDuration', 'duration', 'toFormat', 'withOutputFormat', 'outputFormat', 'format', 'map',
  'addInputOption', 'addInputOptions', 'withInputOption', 'withInputOptions', 'inputOption', 'inputOptions',
  'addOutputOption', 'addOutputOptions', 'addOption', 'addOptions', 'withOutputOption', 'withOutputOptions', 'withOption', 'withOptions', 'outputOption', 'outputOptions',
  'filterGraph', 'complexFilter', 'clone', 'renice',
]

export const runMethods = [
  'run', 'save', 'saveToFile', 'takeScreenshots', 'thumbnail', 'thumbnails', 'screenshot', 'screenshots', 'mergeToFile', 'concatenate', 'concat',
]

export const queryMethods = [
  'ffprobe', 'availableFilters', 'getAvailableFilters', 'availableCodecs', 'getAvailableCodecs',
  'availableEncoders', 'getAvailableEncoders', 'availableFormats', 'getAvailableFormats',
]

const chainNames = new Set(chainMethods)
const runNames = new Set(runMethods)
const queryNames = new Set(queryMethods)
const inputNames = new Set(['input', 'addInput', 'mergeAdd'])
const outputNames = new Set(['output', 'addOutput', 'save', 'saveToFile', 'mergeToFile', 'concatenate', 'concat'])
const screenshotNames = new Set(['takeScreenshots', 'thumbnail', 'thumbnails', 'screenshot', 'screenshots'])

const FFMPEG_BIN = process.env.OIP_FFMPEG_PATH || 'ffmpeg'
const FFPROBE_BIN = process.env.OIP_FFPROBE_PATH || 'ffprobe'

// 产物按扩展名回写 MIME，画布的图片/视频/音频节点靠它决定怎么预览。
const MIME_BY_EXTENSION = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo', ts: 'video/mp2t', mpg: 'video/mpeg', mpeg: 'video/mpeg', gif: 'image/gif',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', heic: 'image/heic',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/opus', weba: 'audio/webm', aiff: 'audio/aiff',
  json: 'application/json', txt: 'text/plain', srt: 'text/plain', vtt: 'text/vtt', csv: 'text/csv',
}

function mimeForPath(path) {
  const extension = (/\.([a-z0-9]+)$/i.exec(path) || [])[1]
  return MIME_BY_EXTENSION[String(extension || '').toLowerCase()] || 'application/octet-stream'
}

// ---- 沙箱路径 ----

function safeJoin(root, name) {
  const target = resolve(root, name)
  if (target !== root && !target.startsWith(root + sep)) throw failure('FFmpeg 文件路径越界', 403)
  return target
}

function workspacePath(workspaceFiles, value, label) {
  if (typeof value !== 'string' || !value.trim()) throw failure(`${label}必须是工作区文件路径`)
  let path
  try {
    path = workspaceFiles.path(value.trim())
  } catch {
    throw failure('FFmpeg 只能读写当前工作区内的相对路径文件', 403)
  }
  if (isProtectedWorkspacePath(path)) throw failure('该文件包含供应商密钥，媒体工具不能读取或修改', 403)
  return path
}

// ---- fluent 语义的调用状态：选项表按“同名选项保留最后一次设置，位置沿用第一次”去重 ----

function createState(options: Record<string, any> = {}) {
  const output = { target: null, options: [] }
  return {
    global: [],
    inputs: [],
    outputs: [output],
    currentInput: null,
    currentOutput: output,
    concat: null,
    extraFiles: [],
    options,
  }
}

function setOption(list, key, values = []) {
  const entry = { key, values }
  const index = list.findIndex(item => item.key === key)
  if (index >= 0) list[index] = entry
  else list.push(entry)
}

function appendRaw(list, tokens) {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token.startsWith('-')) { list.push({ key: token, values: [] }); continue }
    // 选项和它的值必须拆成数组元素。整串带空格的写法（上游 readme 的 outputOptions("-map [video]")）
    // 到了 ffmpeg 那里是一整个 argv，只会报 Unrecognized option；这里提前给出可照抄的改法。
    // 上游 fluent-ffmpeg 是否自己拆空格我们无法对照（仓库和 vendor 里都没有它的源码），不猜。
    if (/\s/.test(token)) throw failure(`FFmpeg 原始选项要拆成数组元素：${JSON.stringify(token.split(/\s+/))}，不要整串写成 ${JSON.stringify(token)}`, 422)
    const values = []
    while (index + 1 < tokens.length && !tokens[index + 1].startsWith('-')) { values.push(tokens[index + 1]); index += 1 }
    // 原始选项一律追加，不按同名去重：上游 fluent-ffmpeg 的 outputOptions 就是直接追加，
    // 而且同一路输出会合法地重复同一个选项——最典型的是 -map（上游 videoNode 的截取配方
    // 先 outputOptions("-map", "0:<视频>", …) 再 outputOptions("-map", "0:a:0?")），
    // -metadata 也常一次写多条。去重会把先写的那条吃掉，产物会缺轨。
    // 注意：只有原始选项走这里；videoCodec/size 这类有名字的链式方法仍用 setOption 保留“同名覆盖”。
    list.push({ key: token, values })
  }
}

function rawTokens(args) {
  const flat = args.length === 1 && Array.isArray(args[0]) ? args[0] : args
  return flat.filter(item => typeof item === 'string' && item.length).map(String)
}

function joined(args) {
  if (args.length === 1 && Array.isArray(args[0])) return args[0].map(String).join(',')
  return args.map(String).join(',')
}

function text(value, label) {
  if (value === undefined || value === null || value === '') throw failure(`${label}缺少参数`)
  return String(value)
}

// fluent 的 bitrate 方法以 kbit/s 接受无单位数值；FFmpeg 命令行则以 bit/s 接受。
// 原始 outputOptions('-b:a', ...) 仍遵循 FFmpeg 自己的单位，不经此转换。
function fluentBitrate(value, label) {
  const bitrate = text(value, label);
  return /^\d+(?:\.\d+)?$/.test(bitrate) ? `${bitrate}k` : bitrate;
}

function addInput(state, source) {
  const input = { source, options: [] }
  state.inputs.push(input)
  state.currentInput = input
  return input
}

function addOutput(state, target) {
  // 与 fluent 一致：当前输出还没设过目标时直接用这个目标，否则新开一路输出。
  if (!state.currentOutput.target) {
    state.currentOutput.target = target
    return state.currentOutput
  }
  const output = { target, options: [] }
  state.outputs.push(output)
  state.currentOutput = output
  return output
}

// 往当前输出写一个“链式方法”。方法名已在调用前用 chainNames 过滤过。
function applyChain(state, method, args) {
  const output = () => state.currentOutput.options
  const input = () => {
    if (!state.currentInput) throw failure('FFmpeg 需要先用 input 指定工作区文件')
    return state.currentInput.options
  }
  switch (method) {
    case 'input': case 'addInput': case 'mergeAdd': addInput(state, text(args[0], 'input')); return
    case 'withInputFormat': case 'inputFormat': case 'fromFormat': setOption(input(), '-f', [text(args[0], method)]); return
    case 'withInputFps': case 'withInputFPS': case 'withFpsInput': case 'withFPSInput':
    case 'inputFPS': case 'inputFps': case 'fpsInput': case 'FPSInput': setOption(input(), '-r', [text(args[0], method)]); return
    case 'nativeFramerate': case 'withNativeFramerate': case 'native': setOption(input(), '-re'); return
    case 'setStartTime': case 'seekInput': setOption(input(), '-ss', [text(args[0], method)]); return
    case 'loop':
      setOption(input(), '-loop', ['1'])
      if (args[0] !== undefined && args[0] !== null) setOption(input(), '-t', [text(args[0], method)])
      return
    case 'withNoAudio': case 'noAudio': setOption(output(), '-an'); return
    case 'withAudioCodec': case 'audioCodec': setOption(output(), '-acodec', [text(args[0], method)]); return
    case 'withAudioBitrate': case 'audioBitrate': setOption(output(), '-b:a', [fluentBitrate(args[0], method)]); return
    case 'withAudioChannels': case 'audioChannels': setOption(output(), '-ac', [text(args[0], method)]); return
    case 'withAudioFrequency': case 'audioFrequency': setOption(output(), '-ar', [text(args[0], method)]); return
    case 'withAudioQuality': case 'audioQuality': setOption(output(), '-aq', [text(args[0], method)]); return
    case 'withAudioFilter': case 'withAudioFilters': case 'audioFilter': case 'audioFilters': setOption(output(), '-af', [joined(args)]); return
    case 'withNoVideo': case 'noVideo': setOption(output(), '-vn'); return
    case 'withVideoCodec': case 'videoCodec': setOption(output(), '-vcodec', [text(args[0], method)]); return
    case 'withVideoBitrate': case 'videoBitrate': {
      const bitrate = fluentBitrate(args[0], method)
      const constant = Boolean(args[1])
      setOption(output(), '-b:v', [bitrate])
      if (constant) {
        setOption(output(), '-maxrate', [bitrate])
        setOption(output(), '-minrate', [bitrate])
        setOption(output(), '-bufsize', [bitrate])
      }
      return
    }
    case 'withVideoFilter': case 'withVideoFilters': case 'videoFilter': case 'videoFilters': setOption(output(), '-vf', [joined(args)]); return
    case 'withOutputFps': case 'withOutputFPS': case 'withFpsOutput': case 'withFPSOutput':
    case 'withFps': case 'withFPS': case 'outputFPS': case 'outputFps': case 'fpsOutput': case 'FPSOutput':
    case 'fps': case 'FPS': setOption(output(), '-r', [text(args[0], method)]); return
    case 'takeFrames': case 'withFrames': case 'frames': setOption(output(), '-frames:v', [text(args[0], method)]); return
    case 'keepPixelAspect': setOption(output(), '-sample_aspect_ratio', ['1']); return
    case 'keepDisplayAspect': case 'keepDisplayAspectRatio': case 'keepDAR': setOption(output(), '-aspect', ['1']); return
    case 'withSize': case 'setSize': case 'size': setOption(output(), '-s', [text(args[0], method)]); return
    case 'withAspect': case 'withAspectRatio': case 'setAspect': case 'setAspectRatio': case 'aspect': case 'aspectRatio': setOption(output(), '-aspect', [text(args[0], method)]); return
    case 'applyAutopadding': case 'applyAutoPadding': case 'applyAutopad': case 'applyAutoPad':
    case 'withAutopadding': case 'withAutoPadding': case 'withAutopad': case 'withAutoPad':
    case 'autoPad': case 'autopad':
      // fluent 的自动补边依赖 size/aspect 状态；偶数尺寸补齐不等价，
      // drawbox 更会覆盖原画面。尚未实现的语义明确拒绝，调用方可显式给 pad 滤镜。
      throw failure('当前执行器不支持自动补边；请用 videoFilters 显式指定 scale/pad 的尺寸、位置和颜色', 422)
    case 'output': case 'addOutput': {
      const target = addOutput(state, text(args[0], method))
      if (Array.isArray(args[1])) appendRaw(target.options, rawTokens([args[1]]))
      return
    }
    case 'save': case 'saveToFile': case 'mergeToFile': case 'concatenate': case 'concat': {
      const target = text(args[0], method)
      if (method === 'mergeToFile' || method === 'concatenate' || method === 'concat') state.concat = target
      addOutput(state, target)
      return
    }
    case 'seekOutput': case 'seek': setOption(output(), '-ss', [text(args[0], method)]); return
    case 'withDuration': case 'setDuration': case 'duration': setOption(output(), '-t', [text(args[0], method)]); return
    case 'toFormat': case 'withOutputFormat': case 'outputFormat': case 'format': setOption(output(), '-f', [text(args[0], method)]); return
    // map 允许重复出现（多路输出选流），不做同名去重。
    case 'map': output().push({ key: '-map', values: [text(args[0], method)] }); return
    case 'addInputOption': case 'addInputOptions': case 'withInputOption': case 'withInputOptions':
    case 'inputOption': case 'inputOptions': appendRaw(input(), rawTokens(args)); return
    case 'addOutputOption': case 'addOutputOptions': case 'addOption': case 'addOptions':
    case 'withOutputOption': case 'withOutputOptions': case 'withOption': case 'withOptions':
    case 'outputOption': case 'outputOptions': appendRaw(output(), rawTokens(args)); return
    case 'filterGraph': case 'complexFilter': {
      const graph = args[0]
      if (typeof graph !== 'string' && (!Array.isArray(graph) || !graph.length || graph.some(filter => typeof filter !== 'string' || !filter.trim()))) {
        throw failure('复杂滤镜目前只支持字符串或非空字符串数组；对象滤镜尚未实现，请改写为 FFmpeg 滤镜字符串', 422)
      }
      // 数组的每项是独立滤镜链，必须用分号连接；逗号会把链误接到同一路。
      setOption(output(), '-filter_complex', [text(Array.isArray(graph) ? graph.join(';') : graph, method)])
      if (Array.isArray(args[1])) for (const spec of args[1]) output().push({ key: '-map', values: [String(spec)] })
      else if (typeof args[1] === 'string') output().push({ key: '-map', values: [args[1]] })
      return
    }
    case 'clone': throw failure('当前执行器不支持命令 clone；请分别提交独立 FFmpeg 任务', 422)
    case 'renice': throw failure('当前执行器不支持调整进程优先级 renice', 422)
    default: throw failure(`FFmpeg 配置方法不可用：${method}`)
  }
}

// 任意参数里都不允许出现工作区以外的位置：绝对路径、~/、协议地址、回退上级目录，
// 以及 movie= / subtitles= 这类内嵌在滤镜里的绝对路径写法。原始选项（outputOptions 等）
// 同样会被 ffmpeg 当成真实的输入输出，所以这道检查和 input/output 的路径校验一样是必须的。
//
// 这是与上游有意为之的差异：上游 remote.ts 只校验 input/output 的显式路径，其余参数
// 按可信代码原样透传（它的 ffmpeg 跑在用户自己机器上）；妙图是多账号托管，同一个进程
// 服务所有账号，不拦就等于任何注册用户都能用 -i /etc/passwd 读服务器文件。
const ESCAPING_PATH = /(^|[\s=:,;\[("'])(~\/|\/|[a-z][a-z\d+.-]*:\/\/)|(^|[\\/])\.\.([\\/]|$)|\\/

function assertArguments(value, method) {
  if (typeof value === 'string') {
    if (ESCAPING_PATH.test(value)) throw failure(`FFmpeg 参数不能引用工作区以外的路径：${method}`, 403)
    return
  }
  if (Array.isArray(value)) { for (const item of value) assertArguments(item, method); return }
  if (value && typeof value === 'object') for (const item of Object.values(value)) assertArguments(item, method)
}

/** 套用一条调用：输入/输出的首参必须是工作区相对路径，其余参数原样交给链式方法。 */
function applyCall(state, call) {
  if (screenshotNames.has(call.method) || call.method === 'run') return
  assertArguments(call.args, call.method)
  if (inputNames.has(call.method) || outputNames.has(call.method)) {
    const path = workspacePath(state.workspaceFiles, call.args[0], call.method)
    applyChain(state, call.method, [path, ...call.args.slice(1)])
    return
  }
  applyChain(state, call.method, call.args)
}

function flatten(list) {
  const flat = []
  for (const item of list) flat.push(item.key, ...item.values)
  return flat
}

function buildArguments(state) {
  const args = [...flatten(state.global)]
  if (state.concat) {
    // 拼接走 concat 解复用器：输入清单是沙箱里的真实文件，源路径相对沙箱根。
    args.push('-f', 'concat', '-safe', '0', '-i', state.concat.listName)
    const options = flatten(state.currentOutput.options)
    // 调用方没指定编码器时按 fluent 的拼接配方直接 -c copy（流拷贝，不重编码）。
    if (!options.some(item => ['-c', '-codec', '-vcodec', '-acodec'].includes(item))) args.push('-c', 'copy')
    args.push(...options, state.currentOutput.target)
    return args
  }
  for (const input of state.inputs) args.push(...flatten(input.options), '-i', input.source)
  for (const output of state.outputs) {
    if (!output.target) continue
    args.push(...flatten(output.options), output.target)
  }
  return args
}

function declaredOutputs(state) {
  if (state.concat) return state.currentOutput.target ? [state.currentOutput.target] : []
  return state.outputs.filter(output => output.target).map(output => output.target)
}

// ---- 进程执行 ----

function formatTimemark(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00:00.00'
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${rest.toFixed(2).padStart(5, '0')}`
}

function progressPayload(block, duration) {
  const seconds = Number(block.out_time_us) / 1e6 || Number(block.out_time_ms) / 1e3 || 0
  const number = value => {
    const parsed = Number(String(value ?? '').replace(/[^\d.-]/g, ''))
    return Number.isFinite(parsed) ? parsed : 0
  }
  return {
    frames: number(block.frame),
    currentFps: number(block.fps),
    currentKbps: number(block.bitrate),
    targetSize: number(block.total_size),
    timemark: formatTimemark(seconds),
    ...(duration > 0 ? { percent: Math.min(100, Math.round((seconds / duration) * 1000) / 10) } : {}),
  }
}

function parseCodecData(stderr) {
  const format = /Input #\d+,\s*([^,]+(?:,[^,]+)*?),\s*from/.exec(stderr)
  const duration = /Duration:\s*(\d+:\d+:\d+\.\d+)/.exec(stderr)
  const video = /Stream #\d+:\d+.*?:\s*Video:\s*(.+)/.exec(stderr)
  const audio = /Stream #\d+:\d+.*?:\s*Audio:\s*(.+)/.exec(stderr)
  if (!format && !duration && !video && !audio) return null
  const split = line => String(line || '').split(',').map(part => part.trim()).filter(Boolean)
  return {
    format: format ? format[1].trim() : '',
    audio: audio ? split(audio[1])[0] || '' : '',
    audio_details: audio ? split(audio[1]).slice(1) : [],
    video: video ? split(video[1])[0] || '' : '',
    video_details: video ? split(video[1]).slice(1) : [],
    duration: duration ? duration[1] : 'N/A',
  }
}

// 打不开文件时补一句沙箱规则：调用方最常见的原因就是引用了没被带进沙箱的间接文件。
function sandboxHint(stderr) {
  const text = String(stderr || '')
  if (!/No such file or directory|Error opening input|Could not open|Impossible to open|Unable to find a suitable output format/.test(text)) return ''
  return '（沙箱只会放入参数里字面出现、且当前工作区存在的路径；清单文件、图片序列、movie=/subtitles= 指向的文件不会自动带进去，需要改用工作区里的直接路径）'
}

function serializeError(error: any) {
  if (!error) return { name: 'Error', message: 'FFmpeg 执行失败' }
  if (error instanceof Error) {
    return { name: error.name, message: error.message, ...((error as NodeJS.ErrnoException).code ? { code: (error as NodeJS.ErrnoException).code } : {}) }
  }
  return { name: 'Error', message: String(error) }
}

/**
 * 跑一个子进程，把 stderr 逐行、`-progress` 的进度块、以及解析出的媒体信息转成事件。
 * 取消和超时都用 SIGKILL 终止，保证 ffmpeg 不会留在后台继续写沙箱。
 */
function runProcess(binary, args, { cwd, signal, timeoutMs, emit, wantProgress, duration }: Record<string, any>) {
  signal?.throwIfAborted()
  return new Promise<any>(resolvePromise => {
    const child = spawn(binary, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    let stdoutBuffer = ''
    let stderrBuffer = ''
    let block = {}
    let codecDataSent = false
    let timedOut = false
    let canceled = false
    let settled = false
    let processError: unknown

    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const finish = (code, error) => {
      if (settled) return
      settled = true
      cleanup()
      resolvePromise({ code, error, stdout, stderr, timedOut, canceled })
    }
    const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs) : undefined
    const onAbort = () => { canceled = true; child.kill('SIGKILL') }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()

    const sendCodecData = () => {
      if (codecDataSent) return
      const data = parseCodecData(stderr)
      if (!data || (data.duration === 'N/A' && !data.video && !data.audio)) return
      codecDataSent = true
      emit({ event: 'codecData', args: [data] })
    }
    // An error (including a failed spawn) precedes stdio close. Retain the
    // first failure and keep the sandbox owned until the real close event.
    child.on('error', error => { processError ??= error })
    child.on('close', code => { sendCodecData(); finish(processError === undefined ? code ?? -1 : -1, processError ?? null) })

    child.stdout.on('data', chunk => {
      const value = chunk.toString('utf8')
      stdout += value
      if (!wantProgress) return
      stdoutBuffer += value
      let index
      while ((index = stdoutBuffer.indexOf('\n')) >= 0) {
        const line = stdoutBuffer.slice(0, index).trim()
        stdoutBuffer = stdoutBuffer.slice(index + 1)
        const match = /^([\w_]+)=(.*)$/.exec(line)
        if (!match) continue
        block[match[1]] = match[2]
        if (match[1] !== 'progress') continue
        emit({ event: 'progress', args: [progressPayload(block, duration)] })
        block = {}
      }
    })

    child.stderr.on('data', chunk => {
      const value = chunk.toString('utf8')
      stderr += value
      stderrBuffer += value
      let index
      while ((index = stderrBuffer.indexOf('\n')) >= 0) {
        const line = stderrBuffer.slice(0, index).trim()
        stderrBuffer = stderrBuffer.slice(index + 1)
        if (!line) continue
        emit({ event: 'stderr', args: [line] })
      }
      // 输入信息在 stderr 前几行就齐了，早点发出去，界面好显示。
      // 等到 Stream mapping / Output #0 说明输入各条流都已打印完，音轨信息不会漏。
      if (!codecDataSent && /Stream mapping:|Output #0/.test(stderr)) sendCodecData()
    })
  })
}

/** 只取结果、不发事件的短查询（ffprobe / 能力查询）。 */
async function runQuery(binary, args, timeoutMs, cwd, signal) {
  const result = await runProcess(binary, args, {
    cwd, signal, timeoutMs, emit: () => {}, wantProgress: false, duration: 0,
  })
  if (result.canceled || signal?.aborted) throw Object.assign(new Error('FFmpeg 查询已取消'), { name: 'AbortError' })
  if (result.timedOut) throw failure('FFmpeg 查询超时', 504)
  if (result.code !== 0) throw failure(String(result.stderr || '').split('\n').filter(Boolean).slice(-3).join(' ').trim() || 'FFmpeg 查询失败', 500)
  return result.stdout
}

async function probeDuration(sandbox, state, signal) {
  signal?.throwIfAborted()
  const source = state.inputs[0]?.source
  if (!source) return 0
  try {
    const stdout = await runQuery(FFPROBE_BIN, ['-v', 'error', '-print_format', 'json', '-show_format', source], FFMPEG_LIMITS.queryTimeoutMs, sandbox, signal)
    const parsed = JSON.parse(stdout)
    const value = Number(parsed?.format?.duration)
    return Number.isFinite(value) && value > 0 ? value : 0
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw error
    return 0
  }
}

// ---- 请求校验 ----

function validateCall(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw failure('FFmpeg 调用格式无效')
  const method = String(raw.method || '')
  if (!method || method.length > FFMPEG_LIMITS.maxMethodLength) throw failure('FFmpeg 方法名无效')
  const args = Array.isArray(raw.args) ? raw.args : []
  if (args.length > FFMPEG_LIMITS.maxArgs) throw failure('FFmpeg 单条调用的参数过多', 413)
  const undefinedArgs = (Array.isArray(raw.undefinedArgs) ? raw.undefinedArgs : [])
    .filter(index => Number.isInteger(index) && index >= 0 && index < args.length)
  return { method, args: args.map((value, index) => undefinedArgs.includes(index) ? undefined : value) }
}

function validateRequest(payload) {
  if (!payload || typeof payload !== 'object') throw failure('FFmpeg 请求格式无效')
  if (typeof payload.requestId !== 'string' || !/^[\w-]{8,64}$/.test(payload.requestId)) throw failure('FFmpeg 请求标识无效')
  const directory = String(payload.directory || '')
  if (!directory || directory.length > 4096) throw failure('FFmpeg 工作区无效')
  const rawOptions = payload.options && typeof payload.options === 'object' ? payload.options : {}
  const calls = Array.isArray(payload.calls) ? payload.calls : []
  if (calls.length > FFMPEG_LIMITS.maxCalls) throw failure('FFmpeg 调用条数超过上限', 413)
  return {
    requestId: payload.requestId,
    directory,
    options: {
      source: rawOptions.source,
      cwd: rawOptions.cwd,
      niceness: rawOptions.niceness,
      priority: rawOptions.priority,
      stdoutLines: rawOptions.stdoutLines,
      timeout: rawOptions.timeout,
    },
    calls: calls.map(validateCall),
    operation: validateCall(payload.operation || { method: 'run', args: [] }),
  }
}

// ---- 沙箱：工作区 → 真实文件 → 工作区 ----

async function putFile(sandbox, workspaceFiles, userId, state, path) {
  if (state.files.has(path)) return
  if (isProtectedWorkspacePath(path)) throw failure('该文件包含供应商密钥，媒体工具不能读取', 403)
  let info
  try { info = workspaceFiles.stat(userId, path) } catch { throw failure(`FFmpeg 参数里引用的文件不在当前工作区：${path}`, 404) }
  if (!workspaceFiles.localLargeFiles && state.bytes + info.size > FFMPEG_LIMITS.sandboxMaxBytes) throw failure('FFmpeg 任务的素材总量超过上限', 413)
  const target = safeJoin(sandbox, path)
  await mkdir(dirname(target), { recursive: true })
  if (workspaceFiles.copyTo) await workspaceFiles.copyTo(userId, path, target)
  else await writeFile(target, Buffer.from(workspaceFiles.read(userId, path).bytes))
  const written = await stat(target)
  state.bytes += written.size
  state.files.set(path, { size: written.size, mtimeMs: written.mtimeMs })
}

/** 参数里凡是“确实存在于工作区的路径”，都先落到沙箱，滤镜/清单里的间接引用也能拿到文件。 */
function collectInputs(calls, operation, state, add) {
  const visit = value => {
    if (typeof value === 'string') { add(value); return }
    if (Array.isArray(value)) { for (const item of value) visit(item); return }
    if (value && typeof value === 'object') { for (const item of Object.values(value)) visit(item) }
  }
  for (const call of [...calls, operation]) {
    for (const value of call.args) visit(value)
  }
  if (state.options.source) add(state.options.source)
}

async function walkFiles(root, current = root, found = []) {
  const entries = await readdir(current, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(current, entry.name)
    const info = await lstat(full).catch(() => null)
    if (!info || info.isSymbolicLink()) continue
    if (info.isDirectory()) { await walkFiles(root, full, found); continue }
    if (!info.isFile()) continue
    found.push({ path: relative(root, full).split(sep).join('/'), size: info.size, mtimeMs: info.mtimeMs, full })
  }
  return found
}

async function writeBack(sandbox, workspaceFiles, userId, state, signal) {
  signal?.throwIfAborted()
  const candidates = (await walkFiles(sandbox)).filter(item => {
    const known = state.files.get(item.path)
    return !known || known.size !== item.size || known.mtimeMs !== item.mtimeMs
  })
  if (candidates.length > FFMPEG_LIMITS.maxOutputFiles) throw failure('FFmpeg 产物文件数超过上限', 413)
  const total = candidates.reduce((sum, item) => sum + item.size, 0)
  if (!workspaceFiles.localLargeFiles && total > FFMPEG_LIMITS.sandboxMaxBytes) throw failure('FFmpeg 产物总量超过上限', 413)
  for (const item of candidates) {
    if (isProtectedWorkspacePath(item.path)) throw failure('该文件包含供应商密钥，媒体工具不能修改', 403)
    if (state.preserveInternalAssets && isInternalAssetPath(item.path) && state.outputRevisions.has(item.path)) {
      throw failure('节点内部原件保持原位，请将媒体处理结果保存到新路径', 409)
    }
    if (!workspaceFiles.localLargeFiles && item.size > FFMPEG_LIMITS.outputMaxBytes) throw failure(`FFmpeg 产物超过 ${Math.round(FFMPEG_LIMITS.outputMaxBytes / 1024 / 1024)}MB：${item.path}`, 413)
  }
  await workspaceFiles.importFiles(userId, candidates.map(item => ({
    path: item.path, mime: mimeForPath(item.path), source: item.full,
    revision: state.outputRevisions.get(item.path) ?? null,
  })), {
    signal, maxBytes: workspaceFiles.localLargeFiles ? Infinity : FFMPEG_LIMITS.outputMaxBytes,
  })
  return candidates.map(item => item.path)
}

function concatListContent(inputs) {
  return inputs.map(input => `file '${String(input.source).replace(/'/g, "'\\''")}'`).join('\n') + '\n'
}

/**
 * 截图的输出与命名规则（调用方按这个预测文件名）：
 * - 时间点：给了 timemarks/timestamps 就按它来；只给 count 时按 (i+1)/(count+1) 等分取点，
 *   百分比时间点用探测到的时长换算，count 缺省为 1（即 50% 处一张）。
 * - 命名：第一张用调用方给的 filename（默认 tn.png），第二张起是「名字_序号.扩展名」，序号从 1 开始。
 * - 时间点与文件名都在这里落成工作区相对路径，仍然要过 workspacePath 校验。
 *
 * 仓库和 vendor 里都没有 fluent-ffmpeg 源码，无法逐字对照上游 screenshots 配方的命名与滤镜图；
 * 这里用「每个时间点一路输出 + 输出侧 -ss」实现，可观察结果（文件名序列与帧内容）一致，实现方式不同。
 */
async function prepareScreenshotOutputs(sandbox, state, args, duration) {
  const config = args[0]
  const settings = typeof config === 'number' ? { count: config } : (config && typeof config === 'object' ? { ...config } : {})
  const folderArg = settings.folder ?? args[1] ?? ''
  const folder = folderArg ? workspacePath(state.workspaceFiles, folderArg, 'screenshots folder') : ''
  const filename = String(settings.filename || 'tn.png')
  const marks = [...(Array.isArray(settings.timemarks) ? settings.timemarks : []), ...(Array.isArray(settings.timestamps) ? settings.timestamps : [])]
  const count = Math.min(FFMPEG_LIMITS.maxOutputFiles, Math.max(1, Math.floor(Number(settings.count) || marks.length || 1)))
  // 给了 timemarks 就按它来；只给 count 时按等分时间点取，与 fluent 的取点思路一致。
  const points = marks.length ? marks : Array.from({ length: count }, (_item, index) => `${Math.round(((index + 1) / (count + 1)) * 100)}%`)
  const outputs = points.map((mark, index) => {
    const value = typeof mark === 'number' ? mark : String(mark)
    const seconds = typeof value === 'string' && value.endsWith('%')
      ? (duration > 0 ? (parseFloat(value) / 100) * duration : NaN)
      : Number(value)
    if (!Number.isFinite(seconds)) throw failure('FFmpeg 截图需要先探测到媒体时长，或用具体时间点')
    // 第一张沿用 filename，之后按 名字_序号.扩展名 命名（序号从 1 开始）。
    const name = index === 0 ? filename : filename.replace(/(\.[^.]+)?$/, suffix => `_${index}${suffix || ''}`)
    const rel = folder ? `${folder}/${name}` : name
    workspacePath(state.workspaceFiles, rel, 'screenshots filename')
    return { target: rel, options: [{ key: '-ss', values: [String(seconds)] }, { key: '-frames:v', values: ['1'] }] }
  })
  for (const output of outputs) await mkdir(dirname(safeJoin(sandbox, output.target)), { recursive: true })
  return outputs
}

/**
 * 执行一次浏览器发来的 FFmpeg 请求，事件通过 emit({event,args}) 抛出。
 * 与上游 executeRemoteFfmpeg 的事件集一致：start / progress / stderr / codecData / filenames / result / end / error。
 */
export async function runFfmpegTask({ workspaceFiles, userId, request, signal, emit }: Record<string, any>) {
  const started = Date.now()
  const sandbox = await mkdtemp(join(tmpdir(), 'miao-ffmpeg-'))
  const state: any = createState(request.options)
  state.workspaceFiles = workspaceFiles
  state.preserveInternalAssets = request.preserveInternalAssets === true
  try {
    signal?.throwIfAborted()
    if (state.options.niceness !== undefined || state.options.priority !== undefined) {
      throw failure('当前执行器不支持 options.niceness / options.priority 调整进程优先级', 422)
    }
    for (const call of request.calls) {
      if (!chainNames.has(call.method)) throw failure(`FFmpeg 配置方法不可用：${call.method}`)
    }
    const operation = request.operation
    if (!queryNames.has(operation.method) && !runNames.has(operation.method)) {
      throw failure(`FFmpeg 执行方法不可用：${operation.method}`)
    }
    // The right to replace an output comes from before processing began, not
    // from a fresh revision observed after the user edited it during encoding.
    // Read-only probes need no output snapshot.
    if (!queryNames.has(operation.method)) state.outputRevisions = new Map(workspaceFiles.list(userId).map(entry => [entry.path, entry.revision]))

    // 1. options.source 等价于 fluent 构造时的第一个输入，必须先落地，
    //    否则 factory(path).native() 这类“先配置输入选项”的写法会找不到当前输入。
    if (state.options.source !== undefined && state.options.source !== null) {
      addInput(state, workspacePath(workspaceFiles, state.options.source, 'options.source'))
    }
    // 再把链式调用套用到状态上，输入/输出必须是工作区相对路径。
    for (const call of request.calls) applyCall(state, call)

    // 2. 落素材：显式输入 + 参数里出现且真实存在的工作区文件。
    const files = new Map()
    const add = path => {
      let value
      try { value = workspaceFiles.path(path.trim()) } catch { return }
      if (!value || files.has(value)) return
      if (isProtectedWorkspacePath(value)) throw failure('该文件包含供应商密钥，媒体工具不能读取或修改', 403)
      try { workspaceFiles.stat(userId, value); files.set(value, true) } catch { /* 不是工作区文件，按字面参数处理 */ }
    }
    collectInputs(request.calls, request.operation, state, add)
    // 显式输入必须是工作区里真实存在的文件：图片序列、清单文件这类通配或间接写法在这里就说清楚，
    // 不用等 ffmpeg 报一句难懂的 No such file or directory。
    for (const input of state.inputs) {
      try { workspaceFiles.stat(userId, input.source) } catch {
        throw failure(`FFmpeg 输入文件不在当前工作区：${input.source}（图片序列、清单文件这类通配或间接引用不会自动带进沙箱，请改用工作区里实际存在的直接路径）`, 404)
      }
    }
    state.files = new Map()
    state.bytes = 0
    for (const path of files.keys()) {
      signal?.throwIfAborted()
      await putFile(sandbox, workspaceFiles, userId, state, path)
    }

    const timeoutMs = workspaceFiles.localLargeFiles ? 0 : Number.isFinite(Number(state.options.timeout)) && Number(state.options.timeout) > 0
      ? Math.min(Number(state.options.timeout), FFMPEG_LIMITS.taskTimeoutMs)
      : FFMPEG_LIMITS.taskTimeoutMs

    // 3. 查询类操作：跑 ffprobe / ffmpeg 能力查询，把结果作为 result 事件发回。
    if (queryNames.has(operation.method)) {
      const extra = Array.isArray(operation.args[0]) ? operation.args[0].map(String) : []
      signal?.throwIfAborted()
      let data
      if (operation.method === 'ffprobe') {
        const source = state.inputs[0]?.source
        if (!source) throw failure('FFmpeg ffprobe 需要先用 input 指定工作区文件')
        const stdout = await runQuery(FFPROBE_BIN, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', ...extra, source], FFMPEG_LIMITS.queryTimeoutMs, sandbox, signal)
        data = JSON.parse(stdout)
      } else {
        const flag = /encoder/i.test(operation.method) ? '-encoders' : /codec/i.test(operation.method) ? '-codecs' : /format/i.test(operation.method) ? '-formats' : '-filters'
        data = await runQuery(FFMPEG_BIN, [flag, ...extra], FFMPEG_LIMITS.queryTimeoutMs, sandbox, signal)
      }
      emit({ event: 'result', args: [data] })
      return { data, filenames: [] }
    }

    // 4. 执行类操作：补齐截图/拼接的输出，再起进程。
    // 时长只探测一次：截图要用它换算百分比时间点，进度事件要用它算 percent。
    let duration = 0
    if (screenshotNames.has(operation.method)) {
      duration = await probeDuration(sandbox, state, signal)
      state.outputs = await prepareScreenshotOutputs(sandbox, state, operation.args, duration)
      state.currentOutput = state.outputs[0]
    } else if (operation.method !== 'run') {
      applyCall(state, operation)
    }
    if (state.concat) {
      const listName = `.miao-concat-${randomUUID()}.txt`
      const listPath = safeJoin(sandbox, listName)
      await writeFile(listPath, concatListContent(state.inputs), 'utf8')
      const listInfo = await stat(listPath)
      state.files.set(listName, { size: listInfo.size, mtimeMs: listInfo.mtimeMs })
      state.concat = { listName }
    }
    // 产物目录可能只是工作区里的一个路径前缀，沙箱里先建出来，ffmpeg 才不会因为目录缺失失败。
    for (const target of declaredOutputs(state)) await mkdir(dirname(safeJoin(sandbox, target)), { recursive: true })
    if (!declaredOutputs(state).length) throw failure('FFmpeg 至少需要一个工作区内的输出文件')

    if (!duration) duration = state.concat ? 0 : await probeDuration(sandbox, state, signal)
    const args = ['-nostdin', '-y', '-progress', 'pipe:1', '-nostats', ...buildArguments(state)]
    signal?.throwIfAborted()
    emit({ event: 'start', args: [[FFMPEG_BIN, ...args].join(' ')] })
    const result = await runProcess(FFMPEG_BIN, args, {
      cwd: sandbox, signal, timeoutMs, emit, wantProgress: true, duration,
    })
    if (result.canceled || signal?.aborted) throw Object.assign(new Error('FFmpeg 任务已取消'), { name: 'AbortError' })
    if (result.timedOut) throw failure(`FFmpeg 执行超过 ${Math.round(timeoutMs / 1000)} 秒上限，已终止`, 504)
    if (result.code !== 0) {
      const tail = String(result.stderr || '').split('\n').map(line => line.trim()).filter(Boolean).slice(-3).join(' ')
      throw failure(`${tail || 'FFmpeg 执行失败'}${sandboxHint(result.stderr)}`, 500)
    }

    // 5. 产物回写工作区，再把真实写回的文件名发出去。
    const filenames = await writeBack(sandbox, workspaceFiles, userId, state, signal)
    emit({ event: 'filenames', args: [filenames] })
    emit({ event: 'end', args: [result.stdout || null, result.stderr || null] })
    return { data: { filenames, declared: declaredOutputs(state), seconds: Math.round((Date.now() - started) / 1000) }, filenames }
  } finally {
    await rm(sandbox, { recursive: true, force: true }).catch(() => {})
  }
}

// ---- HTTP 接口 ----

let runningTasks = 0
const cancellations = new Map()

function respondError(response, status, message) {
  if (response.headersSent) return
  const body = JSON.stringify({ ok: false, code: status, message })
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

/**
 * POST /api/ffmpeg/execute：prepare 与 cancel 回 JSON，其余回 SSE 事件流。
 * 工作区只认当前登录账号：directory 必须是本账号的工作区标识。
 */
export function createFfmpegExec({ workspaceFiles, workspaceKey }: Record<string, any>) {
  async function handle(request, response, session, url, helpers) {
    if (url.pathname !== '/api/ffmpeg/execute') return false
    const { json, readJson, sameOrigin } = helpers
    if (request.method !== 'POST') throw failure('接口不存在', 404)
    sameOrigin(request)
    if (!isWorkspaceRequest(request.headers)) throw failure('请求被拒绝，请刷新页面后重试', 403)

    let input
    try {
      input = validateRequest(await readJson(request, FFMPEG_LIMITS.requestBytes))
      const directory = input.directory.replace(/^miaoimg:/, '')
      const owner = workspaceKey(session.userId)
      const project = currentProject() || DEFAULT_PROJECT_ID
      // The UI directory includes the project. Files remain scoped by the request;
      // never select a project from this client-supplied directory string.
      if (directory !== owner && directory !== `${owner}:${project}`) throw failure('工作区不属于当前账号', 403)
    } catch (error) {
      respondError(response, error.status || 400, error.message || 'FFmpeg 请求无效')
      return true
    }

    const key = `${session.userId}\0${currentProject() || DEFAULT_PROJECT_ID}\0${input.requestId}`
    if (input.operation.method === 'cancel') {
      cancellations.get(key)?.abort()
      json(response, 200, { code: 200, message: '', data: null })
      return true
    }
    if (input.operation.method === 'prepare') {
      json(response, 200, { code: 200, message: '', data: null })
      return true
    }
    if (cancellations.has(key)) { respondError(response, 409, 'FFmpeg 请求已在执行'); return true }
    if (runningTasks >= FFMPEG_LIMITS.maxConcurrentTasks) { respondError(response, 429, '当前 FFmpeg 任务较多，请稍后再试'); return true }

    const controller = new AbortController()
    cancellations.set(key, controller)
    runningTasks += 1
    const close = () => controller.abort()
    request.once('aborted', close)
    response.once('close', close)
    let heartbeat
    try {
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      response.flushHeaders?.()
      // 心跳避免中间代理掐掉长任务；1 秒一次，与上游一致。
      heartbeat = setInterval(() => { if (!response.writableEnded && !response.destroyed) response.write(': keepalive\n\n') }, 1000)
      const send = event => {
        if (response.writableEnded || response.destroyed) return
        response.write(`data: ${JSON.stringify(event)}\n\n`)
      }
      await runFfmpegTask({ workspaceFiles, userId: session.userId, request: input, signal: controller.signal, emit: send })
      if (!response.writableEnded) response.end()
    } catch (error) {
      // 事件流已经开始，错误只能作为 error 事件下发；前端据此 reject 调用方的回调。
      if (!response.writableEnded && !response.destroyed) {
        response.write(`data: ${JSON.stringify({ event: 'error', args: [serializeError(error)] })}\n\n`)
        response.end()
      }
    } finally {
      clearInterval(heartbeat)
      runningTasks -= 1
      if (cancellations.get(key) === controller) cancellations.delete(key)
      request.off('aborted', close)
      response.off('close', close)
    }
    return true
  }

  return { handle }
}
