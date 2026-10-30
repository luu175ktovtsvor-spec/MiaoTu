// The server catalog is the only list of selectable parameters. These helpers
// read that payload; they do not know model ids and do not fill in a ratio,
// duration or resolution the catalog omitted.

export type ParameterRules = {
  maxPromptCharacters?: number
  resolutionsByMode?: Record<string, string[]>
  referenceResolutions?: string[]
  resolutionsByControl?: Record<string, Record<string, string[]>>
  ratiosByMode?: Record<string, string[]>
  durationByMode?: Record<string, { min?: number; max?: number }>
  inheritByMode?: Record<string, Array<'duration' | 'ratio' | 'resolution'>>
  referenceInputsByMode?: Record<string, Record<string, { minDuration?: number; maxDuration?: number }>>
  referencesByMode?: Record<string, { image?: [number, number]; video?: [number, number]; audio?: [number, number] }>
  audioByMode?: Record<string, 'hidden' | false>
  hintsByMode?: Record<string, string>
  requireVisualInMixed?: boolean
  framePlusReferences?: boolean
  pinFramesInMixed?: boolean
  promptOptionalWithImage?: boolean
  promptOptionalWithReferences?: boolean
}

export function resolutionsForControls(model: RuledModel | undefined, parameters: Record<string, unknown>, listed: string[], mode?: unknown) {
  const modeResolutions = model?.parameterRules?.resolutionsByMode?.[modeName(mode)]
  return listed.filter(resolution => (!Array.isArray(modeResolutions) || modeResolutions.includes(resolution)) && Object.entries(model?.parameterRules?.resolutionsByControl || {}).every(([key, rules]) => {
    const value=String(parameters[key] ?? model?.controls?.find(control => control.key===key)?.default ?? '')
    const allowed=rules[value]
    return !Array.isArray(allowed) || allowed.includes(resolution)
  }))
}

export type CatalogControl = {
  key: string
  label: string
  type: 'boolean' | 'select' | 'number'
  upstream?: string
  modes?: string[]
  options?: string[]
  default?: string
  min?: number
  max?: number
  step?: number
}

type RuledModel = {
  providerId?: string
  ratios?: string[]
  durations?: number[]
  durationResolutionMap?: { duration: number[]; resolution: string[] }[]
  maxDurationByMode?: Record<string, number>
  parameterRules?: ParameterRules
  controls?: CatalogControl[]
}

export function modeName(mode: unknown) {
  if (Array.isArray(mode)) return 'image'
  if (typeof mode !== 'string' || !mode) return 'text'
  try {
    const parsed = JSON.parse(mode)
    return typeof parsed === 'string' ? parsed : Array.isArray(parsed) ? 'image' : mode
  } catch {
    return mode
  }
}

export function ratiosForMode(model: RuledModel | undefined, mode: unknown) {
  if (!model) return []
  const listed = model.parameterRules?.ratiosByMode
  const name = modeName(mode)
  if (listed && Object.prototype.hasOwnProperty.call(listed, name)) return listed[name] || []
  return model.ratios || []
}

export function durationsForMode(model: RuledModel | undefined, mode: unknown) {
  if (!model) return []
  const name = modeName(mode)
  const rule = model.parameterRules?.durationByMode?.[name] || {}
  const cap = rule.max ?? model.maxDurationByMode?.[name]
  return [...new Set((model.durationResolutionMap ?? []).flatMap(item => item.duration))]
    .filter(value => rule.min == null || value < 0 || value >= rule.min)
    .filter(value => cap == null || value < 0 || value <= cap)
    .sort((left, right) => left - right)
}

export function inheritedFields(model: RuledModel | undefined, mode: unknown) {
  return model?.parameterRules?.inheritByMode?.[modeName(mode)] || []
}

export function visibleControls(model: RuledModel | undefined, mode: unknown) {
  const name = modeName(mode)
  return (model?.controls || []).filter(control => !control.modes || control.modes.includes(name))
}

// Omitted and false mean "do not send". A selected value keeps the catalog key,
// which is the field the upstream adapter already accepts.
export function controlPayload(model: RuledModel | undefined, mode: unknown, values: Record<string, unknown> | undefined) {
  const payload: Record<string, unknown> = {}
  for (const control of visibleControls(model, mode)) {
    const value = values?.[control.key]
    if (value === undefined || value === '' || value === false) continue
    if (control.type === 'boolean' && value !== true) continue
    if (control.type === 'select' && !control.options?.includes(String(value))) continue
    if (control.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value)
      || control.min != null && value < control.min || control.max != null && value > control.max)) continue
    payload[control.key] = value
  }
  return payload
}

export function resolutionsForMode(model: RuledModel | undefined, mode: unknown, duration: number | undefined, parameters: Record<string, unknown> = {}) {
  const listed = [...new Set((model?.durationResolutionMap || []).filter(item => duration !== undefined && item.duration.includes(duration)).flatMap(item => item.resolution))]
  return resolutionsForControls(model, parameters, listed, mode)
}

// Saved keyframes point to connected node outputs, so reordering references does
// not retarget a pin. Resolve the original path only when quoting or submitting.
export type VideoKeyframeSelection = { reference: string; timestamp_s: number }
export type VideoKeyframeImage = { reference: string; path: string; mimeType: string; label: string; preview?: string }
export function resolveVideoKeyframes(model: { keyframes?: number } | undefined, mode: unknown,
  selections: VideoKeyframeSelection[], images: VideoKeyframeImage[], duration: number | undefined) {
  if (!selections.length) return []
  const limit = model?.keyframes || 0
  if (!limit) throw new Error('当前模型不支持 keyframes')
  if (selections.length > limit) throw new Error(`keyframes 最多支持 ${limit} 个`)
  if (!['image', 'startFrameOptional', 'endFrameOptional', 'startEndRequired'].includes(modeName(mode))) throw new Error('当前模型不支持这个生成模式')
  const slots = new Set<number>()
  return selections.map(selection => {
    const image = images.find(item => item.reference === selection.reference)
    if (!image) throw new Error('参考素材已更新，请重新连接后生成')
    const timestamp = Number(selection.timestamp_s), slot = Math.round(timestamp * 3)
    if (!Number.isFinite(timestamp) || timestamp <= 0 || !duration || timestamp >= duration || Math.abs(timestamp * 3 - slot) > 1e-6) throw new Error('keyframe 时间必须在视频内部并对齐 1/3 秒网格')
    if (slots.has(slot)) throw new Error('keyframe 时间不能重复')
    slots.add(slot)
    return { image: { url: image.path }, timestamp_s: slot / 3 }
  })
}

export type VideoFramePins = { firstFrame?: string; lastFrame?: string }
export function resolveVideoFramePins(model: { parameterRules?: ParameterRules } | undefined, mode: unknown,
  pins: VideoFramePins, images: VideoKeyframeImage[]) {
  const read = (reference: string | undefined) => {
    if (!reference) return undefined
    if (!model?.parameterRules?.pinFramesInMixed || modeName(mode) !== 'image') throw new Error('当前模型不支持这个生成模式')
    const image = images.find(item => item.reference === reference)
    if (!image) throw new Error('参考素材已更新，请重新连接后生成')
    return { path: image.path, mimeType: image.mimeType }
  }
  return { firstFrame: read(pins.firstFrame), lastFrame: read(pins.lastFrame) }
}

// Only the built-in video node owns these fields. Group copies rebind pins to
// copied image outputs while standalone copies keep their original sources.
export function remapVideoFrameReferences(data: Record<string, any>, ids: ReadonlyMap<string, string>) {
  const remap = (key: unknown) => {
    if (typeof key !== 'string') return key
    try {
      const value: unknown = JSON.parse(key)
      if (Array.isArray(value) && value.length === 2 && value.every(part => typeof part === 'string') && ids.has(value[0])) return JSON.stringify([ids.get(value[0]), value[1]])
    } catch { /* Keep a missing or malformed saved reference visible for repair. */ }
    return key
  }
  if (Array.isArray(data.keyframes)) data.keyframes = data.keyframes.map(item => item && typeof item === 'object' ? { ...item, reference: remap(item.reference) } : item)
  if (data.pinnedFrames && typeof data.pinnedFrames === 'object' && !Array.isArray(data.pinnedFrames)) data.pinnedFrames = { ...data.pinnedFrames, firstFrame: remap(data.pinnedFrames.firstFrame), lastFrame: remap(data.pinnedFrames.lastFrame) }
}

// Display only: keep source ids and original file paths intact for signing and
// copying. Storage UUIDs are never useful names in a visual image selector.
export function videoReferenceLabel(nodeLabel: string | undefined, path: string, fallback: string, genericLabels: readonly string[] = []) {
  const generic = new Set(['图片', '图片生成', '未命名节点', 'Image', 'Image generation', 'Unnamed node', 'files', 'reference', ...genericLabels])
  const readable = (value: string) => {
    const stem = value.replace(/\.[a-z0-9]{1,8}$/i, '')
    const remainder = stem.replace(/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}|[a-f0-9]{24,64}/ig, '')
    return Boolean(value.trim() && !generic.has(value.trim()) && (remainder === stem || !/^[\s._\-\d]*$/.test(remainder)))
  }
  const label = String(nodeLabel || '').trim()
  if (readable(label)) return label
  let name = String(path || '').split(/[?#]/, 1)[0]!.split(/[\\/]/).at(-1) || ''
  try { name = decodeURIComponent(name) } catch { /* Keep a readable literal filename. */ }
  return readable(name) ? name : fallback
}
