import { modelById } from './image-models.ts'

export type ImageTransport = { kind: 'json'; path: string; body: unknown } | {
  kind: 'multipart'; path: string; fields: Record<string, unknown>;
  files: readonly { field: string; bytes: BlobPart; mime: string; name: string }[];
}

/**
 * Server-only transport mapping. Public capability data is deliberately kept
 * in image-models.ts; these endpoint and field rules never leave the server.
 */
const TRANSPORTS = Object.freeze({
  ARK_SEEDREAM: 'ark-seedream',
  ARK_SEEDREAM4: 'ark-seedream-4',
  YUNSHU_OPENAI: 'yunshu-openai',
})

function resolvedModel(value) {
  const model = typeof value === 'object' ? value : modelById(value)
  if (!model) throw new Error('不支持的图片模型')
  return model
}

export function transportFor(value) {
  const model = resolvedModel(value)
  if (model.provider === 'yunshu' || model.provider === 'grok') return TRANSPORTS.YUNSHU_OPENAI
  if (model.id.startsWith('doubao-seedream-4-')) return TRANSPORTS.ARK_SEEDREAM4
  return TRANSPORTS.ARK_SEEDREAM
}

export function buildArkBody(request, config: Record<string, any> = {}) {
  const transport = transportFor(request.model)
  const body: Record<string, any> = {
    model: request.model.id,
    prompt: request.prompt,
    size: request.generation.size,
    response_format: request.edit ? 'b64_json' : (config.responseFormat || 'url'),
    watermark: Boolean(config.watermark),
  }
  // 火山官方 background 参数只在支持透明通道的模型（5.0 Pro/Flash）上传：
  // 旧模型（4.0）不发这个字段，避免上游把未知参数当成非法请求。
  if (request.model.supportsTransparent && (request.generation.background === 'transparent' || request.generation.background === 'opaque')) body.background = request.generation.background
  if (request.generation.layerDecomposition) body.layer_decomposition = true
  if (request.generation.optimizePrompt) body.optimize_prompt_options = { mode: request.generation.optimizePrompt }
  if (transport !== TRANSPORTS.ARK_SEEDREAM4) body.output_format = request.generation.format
  // 图层拆分由 layer_decomposition 决定输出张数，不能同时开组图参数。
  if (request.generation.count > 1 && !request.generation.layerDecomposition) {
    body.sequential_image_generation = 'auto'
    body.sequential_image_generation_options = { max_images: request.generation.count }
  }
  if (request.references.length) body.image = request.references.length === 1
    ? request.references[0].value
    : request.references.map((item) => item.value)
  applyUpstreamControls(body, request)
  return body
}

function applyUpstreamControls(body, request) {
  const selected = request.generation?.controls || {}
  for (const control of request.model.controls || []) {
    const value = selected[control.key]
    if (value === undefined || !control.upstream) continue
    body[control.upstream] = value
  }
}

function omitAutomaticFields(fields) {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== '' && value !== null && value !== undefined && value !== 'auto'))
}

function yunshuFields(request) {
  const fields = omitAutomaticFields({
    model: request.model.id,
    prompt: request.prompt,
    size: request.generation.size,
    quality: request.generation.quality,
    n: request.generation.count,
    output_format: request.generation.format,
    response_format: request.edit ? 'b64_json' : 'url',
    background: request.generation.background,
    input_fidelity: request.generation.inputFidelity,
  })
  applyUpstreamControls(fields, request)
  return fields
}

export function buildYunshuRequest(request): ImageTransport {
  if (request.model.provider === 'grok') {
    // Grok edits use JSON. Send one image field or the complete images array:
    // Sub2API counts both fields, so duplicating the first image would overcount.
    if (request.references.length > request.model.maxReferences) {
      throw Object.assign(new Error('当前模型最多支持 ' + request.model.maxReferences + ' 张参考图'), { status: 422 })
    }
    const body = omitAutomaticFields({
      model: request.model.id,
      prompt: request.prompt,
      resolution: request.generation.size,
      aspect_ratio: request.generation.ratio,
      quality: request.model.quality?.length ? request.generation.quality : undefined,
      n: request.generation.count,
      response_format: request.edit ? 'b64_json' : 'url',
    })
    applyUpstreamControls(body, request)
    const images = request.references.map(reference => ({ url: reference.value, type: 'image_url' }))
    if (images.length === 1) body.image = images[0]
    else if (images.length > 1) body.images = images
    return { kind: 'json', path: request.references.length ? '/images/edits' : '/images/generations', body }
  }
  const fields = yunshuFields(request)
  if (!request.references.length) return { kind: 'json', path: '/images/generations', body: fields }
  return {
    kind: 'multipart',
    path: '/images/edits',
    fields,
    files: request.references.map((item, index) => ({
      field: 'image[]',
      bytes: item.bytes,
      mime: item.mime,
      name: `reference-${index + 1}.${item.extension}`,
    })).concat(request.edit?.mask ? [{
      field: 'mask',
      bytes: request.edit.mask.bytes,
      mime: 'image/png',
      name: 'selection.png',
    }] : []),
  }
}

export function transportDescriptors() {
  return {
    [TRANSPORTS.ARK_SEEDREAM]: { provider: 'ark', path: '/images/generations', encoding: 'json' },
    [TRANSPORTS.ARK_SEEDREAM4]: { provider: 'ark', path: '/images/generations', encoding: 'json', omitsOutputFormat: true },
    [TRANSPORTS.YUNSHU_OPENAI]: { provider: 'yunshu', generationPath: '/images/generations', editPath: '/images/edits', encoding: 'json-or-multipart' },
  }
}
