// FFmpeg 媒体工具：Agent（server/agent-api.ts）与 MCP（server/mcp-api.ts）共用同一份定义与执行体。
// 定义只写一次，两边都从这里取：Agent 在 createServerTools 里按 userId 建一份，
// MCP 在 tools/call 里按令牌解出的 userId 现取现用，行为与安全口径完全一致。
import { chainMethods, queryMethods, runFfmpegTask, runMethods } from './ffmpeg-exec.ts'
import { failure } from './management-store.ts'

const PATH_RULE = 'path/steps 里的文件只能是当前工作区内的相对路径；绝对路径、协议地址（http/file）、.. 和 movie=/subtitles= 这类内嵌绝对路径都会被拒绝。'

const FFMPEG_DESCRIPTION = [
  '用本机 FFmpeg 处理工作区里的音视频和图片：截帧、转码、裁剪、拼接、改尺寸等。',
  'steps 按顺序套用 fluent 调用（input/output/frames/seekInput 等），operation 是最后执行的方法，默认 run，也支持 save、screenshots、concat 和 availableEncoders 之类的能力查询。',
  `输入输出只能写当前工作区里的相对路径，不自动改输出名；${PATH_RULE}`,
  '已有 assets/ 内部原件保持原位，输出使用新路径；一组输出共同保存，任一保存冲突均不发布半份结果，处理期间发生的用户保存不会被本次旧结果覆盖。',
  '先用 operation={"method":"availableEncoders","args":[]} 之类的查询确认真实能力，不要猜编码器。',
  '截图命名规则（按它预测文件名）：takeScreenshots 的 args 传 {"count":3,"folder":"assets/out","filename":"tn.png"} 会产出 assets/out/tn.png、assets/out/tn_1.png、assets/out/tn_2.png——第一张用 filename，第二张起是「名字_序号.扩展名」，序号从 1 开始；给了 timemarks/timestamps 就按它取帧，只给 count 时按 (i+1)/(count+1) 等分取点。',
  'addInputOption / addOutputOption / outputOptions 这类原始选项要把选项和它的值拆成数组元素：["-map","[video]"]、["-metadata","title=a b"]，不要整串写成 "-map [video]"——ffmpeg 收到的会是一整个参数，直接报 Unrecognized option。',
  '执行沙箱只放入参数里字面出现、且当前工作区确实存在的路径：步骤和参数里直接写出来的工作区路径会被带进去，清单文件、frame%03d.png 这类图片序列、movie=/subtitles= 指向的文件不会被带进去；遇到 No such file or directory 类报错先按这条排查，不要反复重试同一条命令。',
].join('')

const FFPROBE_DESCRIPTION = [
  '用本机 FFprobe 探测工作区媒体的原始信息（格式、时长、尺寸、帧率、音轨、章节等），支持原生探测选项，返回完整的 ffprobe JSON。',
  PATH_RULE,
].join('')

const FFPROBE_PARAMETERS = {
  type: 'object',
  properties: {
    path: { type: 'string', description: '工作区媒体文件路径，如 assets/xxx.mp4' },
    options: { type: 'array', items: { type: 'string' }, description: '原生 ffprobe 选项，按参数数组原样传递，如 ["-show_chapters"]' },
  },
  required: ['path'],
}

const FFMPEG_PARAMETERS = {
  type: 'object',
  properties: {
    options: { type: 'object', description: '原生 fluent 构造选项（source/cwd/timeout 等），一般不传' },
    steps: {
      type: 'array',
      description: '按 fluent 顺序配置的调用列表；含空格的元数据写成 args:["-metadata","title=a b"]，不要嵌套数组',
      items: {
        type: 'object',
        properties: {
          method: { type: 'string', enum: chainMethods },
          args: { type: 'array', items: {}, description: '原样传给该方法的参数' },
          undefinedArgs: { type: 'array', items: { type: 'number' }, description: '需要传 undefined 的参数位置' },
        },
        required: ['method', 'args'],
      },
    },
    operation: {
      type: 'object',
      description: '最后执行的方法，默认 {"method":"run","args":[]}',
      properties: {
        method: { type: 'string', enum: [...runMethods, ...queryMethods] },
        args: { type: 'array', items: {} },
        undefinedArgs: { type: 'array', items: { type: 'number' } },
      },
      required: ['method', 'args'],
    },
  },
}

/**
 * 上游 packages/tools/ffmpeg 的语义：steps 按顺序套用 fluent 调用，operation 收尾执行。
 * 妙图的工作区在 SQLite 里，所以直接复用浏览器那条执行链路（沙箱 → ffmpeg → 回写工作区），
 * 沙箱范围、上限与路径校验全部由 ffmpeg-exec.ts 负责，这里不另开一套。
 */
async function runFfmpegTool({ workspaceFiles, userId, request, signal }: Record<string, any>) {
  let details
  let filenames
  await runFfmpegTask({
    workspaceFiles,
    userId,
    request: {
      requestId: crypto.randomUUID(),
      directory: '',
      options: request.options && typeof request.options === 'object' ? request.options : {},
      calls: request.steps,
      operation: request.operation,
      preserveInternalAssets: true,
    },
    signal,
    emit: event => {
      if (event.event === 'result') details = event.args[0]
      else if (event.event === 'filenames') filenames = event.args[0]
      else if (event.event === 'end') details = { stdout: event.args[0], stderr: event.args[1], ...(filenames ? { filenames } : {}) }
    },
  })
  signal?.throwIfAborted()
  return details ?? { filenames: filenames || [] }
}

// 定义只写一次：metadata 给 MCP 的 tools/list 用，createMediaTools 给两边执行用。
const MEDIA_TOOLS = [
  {
    name: 'ffprobe',
    description: FFPROBE_DESCRIPTION,
    parameters: FFPROBE_PARAMETERS,
    async run(context, args: Record<string, any> = {}) {
      const path = String(args.path || '').trim()
      if (!path) throw failure('请指定要探测的工作区文件', 422)
      const options = Array.isArray(args.options) ? args.options.map(String) : []
      return runFfmpegTool({ ...context, request: { steps: [{ method: 'input', args: [path] }], operation: { method: 'ffprobe', args: options.length ? [options] : [] } } })
    },
  },
  {
    name: 'ffmpeg',
    description: FFMPEG_DESCRIPTION,
    parameters: FFMPEG_PARAMETERS,
    async run(context, args: Record<string, any> = {}) {
      return runFfmpegTool({
        ...context,
        request: {
          options: args.options,
          steps: Array.isArray(args.steps) ? args.steps : [],
          operation: args.operation && typeof args.operation === 'object' ? args.operation : { method: 'run', args: [] },
        },
      })
    },
  },
]

/** MCP 的 MCP_TOOLS 直接拼这一份（只有 name/description/parameters）。 */
export const mediaToolMetadata = MEDIA_TOOLS.map(({ name, description, parameters }: Record<string, any>) => ({ name, description, parameters }))

/**
 * 建一份可执行的媒体工具。context 里带 workspaceFiles / userId / signal；
 * execute 的第二个参数可以覆盖它（Agent 每次调用会传自己的 signal）。
 */
export function createMediaTools(context) {
  return MEDIA_TOOLS.map(({ name, description, parameters, run }: Record<string, any>) => ({
    name,
    description,
    parameters,
    execute: async (args: Record<string, any> = {}, call: Record<string, any> = {}) => { await context.beforeExecute?.(); return run({ ...context, ...call }, args) },
  }))
}
