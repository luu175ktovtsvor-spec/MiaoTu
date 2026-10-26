// The server catalog is the only list of selectable parameters. These helpers
// read that payload; they do not know model ids and do not fill in a ratio,
// duration or resolution the catalog omitted.

export type ParameterRules = {
  resolutionsByControl?: Record<string, Record<string, string[]>>
  ratiosByMode?: Record<string, string[]>
  durationByMode?: Record<string, { min?: number; max?: number }>
  inheritByMode?: Record<string, Array<'duration' | 'ratio' | 'resolution'>>
  referencesByMode?: Record<string, { image?: [number, number]; video?: [number, number]; audio?: [number, number] }>
  audioByMode?: Record<string, 'hidden' | false>
  hintsByMode?: Record<string, string>
  requireVisualInMixed?: boolean
  framePlusReferences?: boolean
  promptOptionalWithImage?: boolean
}

export function resolutionsForControls(model: RuledModel | undefined, parameters: Record<string, unknown>, listed: string[]) {
  return listed.filter(resolution => Object.entries(model?.parameterRules?.resolutionsByControl || {}).every(([key, rules]) => {
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
    payload[control.key] = value
  }
  return payload
}
