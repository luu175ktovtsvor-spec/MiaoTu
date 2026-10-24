// Only routing fields are retained. Credentials, signed URLs, prompts and
// reference material never enter this diagnostic receipt.
export type PlatformGenerationRoute = { modelKey?: string; modeKey?: string; abilityType?: number; duration?: number; ratio?: string; resolution?: string }
export type PlatformExpectedRoute = PlatformGenerationRoute & { implicitResolution?: string }

export function readGenerationRoute(data: readonly { bytes?: Uint8Array }[] | undefined): PlatformGenerationRoute | undefined {
  if (!data?.length || data.some(part => !part.bytes)) return
  const size = data.reduce((sum, part) => sum + part.bytes!.byteLength, 0)
  if (!size || size > 4 * 1024 * 1024) return
  try {
    const body = JSON.parse(Buffer.concat(data.map(part => Buffer.from(part.bytes!))).toString('utf8'))
    const message = Array.isArray(body.messages) && body.messages.length === 1 ? body.messages[0] : undefined
    const rawAbility = body.chat_ability ?? message?.ext?.chat_ability
    const ability = typeof rawAbility === 'string' ? rawAbility ? JSON.parse(rawAbility) : undefined : rawAbility
    let abilityType = Number(ability?.ability_type)
    let parameters = ability?.ability_param
    for (let depth = 0; depth < 4; depth++) {
      if (typeof parameters === 'string') parameters = JSON.parse(parameters)
      if (parameters && typeof parameters.model !== 'string' && parameters.ability_param !== undefined) {
        if (parameters.ability_type !== undefined) abilityType = Number(parameters.ability_type)
        parameters = parameters.ability_param
      }
      else break
    }
    const modelKey = parameters?.model
    if (modelKey !== undefined && (typeof modelKey !== 'string' || !/^[A-Za-z0-9 _.:-]{1,128}$/.test(modelKey))) return
    const rawModeKey = body.option?.model_config?.model_item_key ?? body.model_item_key ?? body.ext?.model_item_key ?? message?.ext?.model_item_key
    const modeKey = rawModeKey === '' ? undefined : rawModeKey
    if (modeKey !== undefined && (typeof modeKey !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(modeKey))) return
    if (modelKey === undefined && modeKey === undefined && !Number.isInteger(abilityType)) return
    const duration = Number(parameters?.duration)
    const resolution = abilityType === 17 ? parameters?.resolution : undefined
    if (resolution !== undefined && (typeof resolution !== 'string' || !/^[A-Za-z0-9_.:-]{1,32}$/.test(resolution))) return
    const rawRatio = [parameters?.ratio, parameters?.image_creation_ratio, parameters?.image_ratio].find(value => typeof value === 'string')
    return { ...(modelKey ? { modelKey } : {}), ...(modeKey !== undefined ? { modeKey } : {}),
      ...(Number.isInteger(abilityType) ? { abilityType } : {}),
      ...(Number.isInteger(duration) && duration > 0 ? { duration } : {}),
      ...(typeof rawRatio === 'string' && /^(auto|[0-9]+:[0-9]+)$/.test(rawRatio) ? { ratio: rawRatio } : {}),
      ...(typeof resolution === 'string' ? { resolution: resolution.toLowerCase() } : {}),
    }
  } catch { return }
}

export function generationRouteMismatch(actual: PlatformGenerationRoute | undefined, expected: PlatformExpectedRoute, platform = '平台') {
  if (!actual) return `${platform}生成请求的模型参数无法识别，已阻止发送，请更新平台适配`
  if (expected.abilityType !== undefined && actual.abilityType !== expected.abilityType) return `${platform}实际请求的生成能力 ${actual.abilityType ?? '未知'} 与节点 ${expected.abilityType} 不一致，已阻止发送`
  if (expected.modelKey !== undefined && actual.modelKey !== expected.modelKey || expected.modeKey !== undefined && actual.modeKey !== expected.modeKey) return `${platform}实际请求的模型与节点选择不一致，已阻止发送`
  if (expected.duration !== undefined && actual.duration !== expected.duration) return `${platform}实际请求的时长与节点选择不一致，已阻止发送`
  // 视频请求一定会带比例。生图只在请求里出现比例字段时核对，避免把未知字段名当成不一致。
  if (expected.ratio && expected.ratio !== 'auto' && (actual.ratio || expected.abilityType === 17) && actual.ratio !== expected.ratio) return `${platform}实际请求的比例与节点选择不一致，已阻止发送`
  if (expected.resolution && (actual.resolution ?? expected.implicitResolution) !== expected.resolution) return `${platform}实际请求的清晰度与节点选择不一致，已阻止发送`
  return ''
}
