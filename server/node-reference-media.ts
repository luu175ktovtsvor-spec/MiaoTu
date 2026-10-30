// Private node turns may inspect only their explicitly attached project media.
import { readFile } from 'node:fs/promises'
import { failure } from './management-store.ts'
import { createVideoReviewTool, VIDEO_REVIEW_CONTENT } from './video-review.ts'

// Only renderer tools returning actual scene samples use this transport. Keep
// binary data out of chat/tool logs, but deliver images to the text model.
export function directorPreviewContent(value) {
  if (!value?.summary || !Array.isArray(value.frames) || !value.frames.length || value.frames.length > 4) throw failure('场景回看未返回有效画面', 422)
  let bytes = 0
  const content: Array<Record<string, any>> = [{ type: 'text', text: JSON.stringify(value.summary) }]
  for (const frame of value.frames) {
    if (!Number.isFinite(frame.time) || frame.time < 0 || frame.mimeType !== 'image/jpeg' || typeof frame.data !== 'string' || frame.data.length > 1_400_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(frame.data)) throw failure('场景回看画面格式无效', 422)
    const jpeg = Buffer.from(frame.data, 'base64')
    bytes += jpeg.length
    if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || bytes > 4 * 1024 * 1024) throw failure('场景回看画面无效或过大', 422)
    content.push({ type: 'text', text: `当前方案实际渲染：${frame.time} 秒` }, { type: 'image', data: frame.data, mimeType: 'image/jpeg' })
  }
  return { summary: value.summary, [VIDEO_REVIEW_CONTENT]: content }
}

export async function prepareNodeReferences({ references = [], workspaceFiles, userId, signal, ensureMediaTools }: Record<string, any>) {
  if (!Array.isArray(references) || references.length > 8) throw failure('每次最多引用 8 项素材', 422)
  const images = [], manifest = [], videoPaths = new Map()
  const review = createVideoReviewTool({ workspaceFiles, userId, signal, maxFrames: 32 })
  const mediaCount = references.filter(ref => ref?.dataType !== 'STRING').length
  let bytes = 0
  for (const [index, ref] of references.entries()) {
    signal?.throwIfAborted()
    const referenceIndex = index + 1
    if (ref?.dataType === 'STRING') { manifest.push({ referenceIndex, type: 'text' }); continue }
    if (!['IMAGE', 'VIDEO'].includes(ref?.dataType) || typeof ref.value?.url !== 'string') throw failure('引用素材格式无效', 422)
    const path = ref.value.url
    // locate validates both ownership and relative paths. Never fetch a URL supplied by a model.
    const file = (await workspaceFiles.locate(userId, path))
    if (ref.dataType === 'IMAGE') {
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.mime) || file.size > 4 * 1024 * 1024) throw failure('参考图片须为 PNG、JPEG、WebP 或 GIF，且不超过 4 MB', 422)
      const data = file.diskPath ? await readFile(file.diskPath) : file.bytes
      bytes += data.length
      images.push({ type: 'image', data: data.toString('base64'), mimeType: file.mime })
      manifest.push({ referenceIndex, type: 'image', imageNumber: images.length })
    } else {
      await ensureMediaTools?.()
      const result = await review.execute({ path, frameCount: Math.min(32, Math.floor(64 / Math.max(1, mediaCount))) }, { signal })
      videoPaths.set(referenceIndex, path)
      const start = images.length
      for (const image of result[VIDEO_REVIEW_CONTENT].filter(item => item.type === 'image')) { images.push(image); bytes += Buffer.byteLength(image.data, 'base64') }
      manifest.push({ referenceIndex, type: 'video', ...result.summary, samples: result.summary.samples.map((sample, i) => ({ ...sample, imageNumber: start + i + 1 })) })
    }
    if (bytes > 8 * 1024 * 1024) throw failure('参考画面过多，请减少引用素材后重试', 413)
  }
  const tools = videoPaths.size ? [{
    name: 'inspectReference',
    description: '查看本轮已引用视频的更多真实画面。referenceIndex 对应 referenceManifest；按动作细节选择相邻 timestamps，每次最多 8 个。只读，不改变原视频，不识别声音。',
    parameters: { type: 'object', additionalProperties: false, required: ['referenceIndex', 'timestamps'], properties: {
      referenceIndex: { type: 'integer', minimum: 1, maximum: 8 },
      timestamps: { type: 'array', minItems: 1, maxItems: 8, uniqueItems: true, items: { type: 'number', minimum: 0 } },
    } },
    async execute(args, context) {
      const path = videoPaths.get(args.referenceIndex)
      if (!path || !Array.isArray(args.timestamps) || !args.timestamps.length || args.timestamps.length > 8) throw failure('请选择本轮视频引用和 1–8 个时间点', 422)
      return review.execute({ path, timestamps: args.timestamps }, context)
    },
  }] : []
  return { images, manifest, tools }
}
