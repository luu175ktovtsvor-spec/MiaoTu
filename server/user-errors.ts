import { numericMessageValues } from './numeric-messages.ts'

// Public copy only. Provider diagnostics stay in DB/upstream_calls and admin views.
// Backward compatibility for errors already stored or returned by an older cloud API.
const legacyErrorCopy: Record<string, string> = {
  "当前操作未能完成，请稍后重试或联系妙图团队": "操作失败，请重试",
  "当前操作不可用，请检查账号权限或联系妙图团队": "当前账号或会话无权执行这次操作。",
  "当前服务暂时不可用，请联系妙图团队": "模型调用暂不可用，请稍后再试",
  "当前请求未能完成，请调整后重试或联系妙图团队": "操作失败，请重试",
  "原图未能保存，请保留原任务并联系妙图团队核对，不要重复生成": "原图回执缺失，请保留原任务等待核对",
  "原图暂存期已结束，请联系妙图团队核对原任务，避免重复生成": "原图暂存期已结束",
  "原图暂存回执缺失，请保留原任务并联系妙图团队核对，避免重复生成": "原图回执缺失，请保留原任务等待核对",
  "本次生成未完成，预扣积分已退还。请调整后重试或联系妙图团队": "生成未完成，预扣积分已退还。",
  "本次生成未完成，请联系妙图团队核对结果": "生成未完成，请查看任务记录。",
  "保留任务编号并联系妙图团队排查；已有任务先查看状态，避免重复提交。": "稍后查看同一任务的状态，不要重新生成，以免重复扣费。",
  "保留原任务编号并联系妙图团队核对结果和费用，不要重新生成。": "保留原任务，核对结果和费用，不要重新生成。",
  "保留任务编号并联系妙图团队修复适配；本次尚未发送，不要反复提交。": "本次生成尚未发送，按提示检查平台页面、账号或参数后再试。",
  "稍后再试或联系妙图团队检查模型服务。": "当前模型暂时不可用，请稍后再试或选择其他模型",
  "检查登录账号和模型权限，仍不可用时联系妙图团队。": "请检查当前账号和模型权限。",
  "积分不足，请联系妙图团队": "积分不足，请先充值后生成",
  "模型服务地址已变化，请联系妙图团队": "模型调用暂不可用，请稍后再试",
  "生成服务地址发生变化，请联系妙图团队核对原任务，避免重复提交": "正在确认生成结果，请稍后查看状态，不要重复提交",
  "搜索服务暂不可用，请联系妙图团队检查服务配置": "搜索暂不可用，请稍后重试。",
  "Grok 视频通道暂无可用账号，请稍后重试或联系妙图团队": "当前模型暂时不可用，请稍后再试或选择其他模型",
  "本次已扣 {0} 积分；如需核对请联系妙图团队。": "本次已扣 {0} 积分。"
}

export function normalizeUserErrorCopy(text: string, lookup?: (key: string) => string | undefined): string {
  if (Object.hasOwn(legacyErrorCopy, text)) return legacyErrorCopy[text]
  const billing = /^本次已扣 ([0-9]+(?:\.[0-9]+)?) 积分；如需核对请联系妙图团队。$/.exec(text)
  if (billing) return `本次已扣 ${billing[1]} 积分。`
  // Older cloud APIs may already have translated the obsolete copy. Match only
  // application-owned messages and controlled numeric fields, never arbitrary text.
  if (lookup) for (const [previous, current] of Object.entries(legacyErrorCopy)) {
    const translated = lookup(previous)
    if (!translated) continue
    if (text === translated) return current
    const values = numericMessageValues(translated, text)
    if (values) return current.replace(/\{(\w+)\}/g, (token, key) => Object.hasOwn(values, key) ? String(values[key]) : token)
  }
  return text
}

export function userFacingError(value, { status = 0, submissionUncertain = false, generationStatus = '', chargedPoints = null, reservedPoints = 0 }: Record<string, any> = {}) {
  const original = String(value?.message || value || '').trim()
  const text = normalizeUserErrorCopy(original)
  if (/^原图暂存期已结束/.test(text)) return '原图暂存期已结束'
  if (/^原图(?:暂存回执缺失|回执缺失|未能保存，请保留原任务)/.test(text)) return '原图回执缺失，请保留原任务等待核对'
  if (submissionUncertain) return '正在确认生成结果，请稍后查看状态，不要重复提交'
  if (/real person|真人|(?:参考图|图片).{0,24}(?:可能含人像|疑似人像)/i.test(text)) return '参考图片被当前模型判定可能包含真人，未通过图片审核'
  if (/text content contains sensitive content|文本.*(?:敏感|审核未通过)/i.test(text)) return '生成描述未通过当前模型的文本审核'
  if (/real person|moderation|content.?policy|safety|sensitive|敏感|审核|违禁/i.test(text)) return '参考素材或描述未通过当前模型的使用限制，请调整素材或描述后再试'
  if (/余额不足|积分不足|quota|insufficient|credits?.*(?:exhaust|insufficient)|额度已用尽/i.test(text)
    && /上游|渠道|H3|秘塔|方舟|Grok|quota|credits|insufficient/i.test(text)) return '当前模型暂时不可用，请稍后再试或选择其他模型'
  if (/api.?key|尚未配置|服务端.?key|凭据|credential|authorization.*failed/i.test(text)) return '模型调用暂不可用，请稍后再试'
  if (/aborted|aborterror|timeout|timed out|connect timeout|fetch failed|load failed|network|ECONN|ETIMEDOUT|ENOTFOUND|请求中断|请求超时|生成请求超时/i.test(text)) {
    if (['failed', 'expired'].includes(generationStatus)) return chargedPoints != null && Number(chargedPoints) === 0 && Number(reservedPoints) > 0
      ? '生成未完成，预扣积分已退还。'
      : '生成未完成，请查看任务记录。'
    return '暂时无法读取服务响应，请稍后查看状态；已有任务不会重复提交'
  }
  if (Number(status) === 401) return '登录已过期，请重新登录'
  if (Number(status) === 429) return '请求过于频繁，请稍后再试'
  if (/Request.?id|https?:\/\/|\/app\/|\/opt\/|\.(?:[cm]?jsx?|tsx?)\b|upstream|stack trace|Traceback|Exception|error code|方舟|秘塔|火山|Yunshu|Sub2API/i.test(text)) return '操作失败，请重试'
  if (/(?:联系|聯絡|聯繫)妙[图圖](?:团队|團隊)/.test(text)) return '操作失败，请重试'
  // Preserve actionable Chinese validation/permission/canvas-conflict messages.
  if (text && /[\u3400-\u9fff]/.test(text)) return text
  if (Number(status) === 404) return '资源暂时无法读取，请刷新后重试'
  if (Number(status) === 403) return '当前账号或会话无权执行这次操作。'
  return '操作失败，请重试'
}

// Classify the original diagnostic before redaction. No extra model request and
// no prompt, asset URL, provider credential or raw stack is sent to the client.
export function explainUserError(value, options: Record<string, any> = {}) {
  const text = String(value?.message || value || '').trim()
  const summary = userFacingError(text, options)
  let category = 'unknown'
  let reason = '服务没有提供足够的信息，暂时不能确定具体原因。'
  let action = options.requestId ? '稍后查看同一任务的状态，不要重新生成，以免重复扣费。' : '请重试'
  if (/^原图(?:暂存(?:期已结束|回执缺失)|回执缺失|未能保存，请保留原任务)/.test(text)) {
    category = 'result_unavailable'
    reason = /^原图暂存期已结束/.test(text) ? '原结果的临时保存期限已结束，系统已停止自动取图。' : /^原图暂存回执缺失/.test(text) ? '原结果的临时回执缺失，系统不能安全地继续取图。' : '系统已停止自动取图，原任务的结果和费用需要人工核对。'
    action = '保留原任务，核对结果和费用，不要重新生成。'
  } else if (/^生成已完成，(?:正在保存原图|原图保存暂未成功)/.test(text)) {
    category = 'result_saving'
    reason = '模型已经返回结果，系统正在取回和保存原图。'
    action = '稍后查看同一任务；系统只继续保存原结果，不会重新生成。'
  } else if (options.submissionUncertain) {
    category = 'submission_uncertain'
    reason = '提交后的响应未能确认，任务可能已被接受，目前仍在查询原任务。'
    action = '稍后查看同一任务的状态，不要重新生成，以免重复扣费。'
  } else if (/订阅权益提示/.test(text) && /尚未发送/.test(text)) {
    category = 'subscription_required'; reason = '平台在选择这个模型时弹出了订阅提示，本次生成尚未发送。'; action = '在平台窗口核对该模型所需的会员或额度；确认可用后再提交，或手动选择其他模型。'
  } else if (/实际请求的.*不一致.*阻止发送/.test(text)) {
    category = 'route_mismatch'; reason = '平台准备发送的模型或参数与节点选择不一致，妙图已在发送前拦截。'; action = '本次生成尚未发送，按提示检查平台页面、账号或参数后再试。'
  } else if (/尚未发送|尚未提交/.test(text)) {
    category = 'not_submitted'; reason = summary; action = '本次生成尚未发送，按提示检查平台页面、账号或参数后再试。'
  } else if (/real person|真人|(?:参考图|图片).{0,24}(?:可能含人像|疑似人像)/i.test(text)) {
    category = 'reference_person_rejected'
    reason = '当前模型将输入图片判定为可能包含真人，因此拒绝本次请求；这不等于已确认图片中是真人。'
    action = '检查并替换带人物面孔的参考图片，或选择明确支持这类素材的模型。'
  } else if (/text content contains sensitive content|文本.*(?:敏感|审核未通过)/i.test(text)) {
    category = 'prompt_moderation'
    reason = '当前模型明确拒绝了生成描述。服务未指出具体词句，不能确定是哪一段触发审核。'
    action = '检查生成描述，移除可能引起歧义或违反使用限制的内容后再试；重复提交同一描述通常无效。'
  } else if (/moderation|content.?policy|safety|sensitive|敏感|审核|违禁/i.test(text)) {
    category = 'content_moderation'
    reason = '请求被当前模型的内容审核拒绝；现有信息无法确定是描述还是哪份参考素材触发。'
    action = '分别检查描述和参考素材，调整后再试。'
  } else if (Number(options.status) === 401 || /登录.*(?:过期|失效)|请先登录/.test(text)) {
    category = 'login_required'; reason = '当前登录状态无法授权这次操作。'; action = '重新登录后继续；已有任务用原账号查看，本地项目仍然保留。'
  } else if (/积分不足|余额不足/.test(text) && !/上游|渠道|quota|credits|秘塔|方舟/.test(text)) {
    category = 'insufficient_points'; reason = '当前账号的可用积分不足以支付本次请求。'; action = '补充积分，或调整生成参数后重新查看报价。'
  } else if (/quota|insufficient|credits?.*(?:exhaust|insufficient)|api.?key|尚未配置|凭据|credential|暂时不可用/i.test(text)) {
    category = 'service_unavailable'; reason = '当前模型服务暂时无法接受请求。'; action = '当前模型暂时不可用，请稍后再试或选择其他模型'
  } else if (/aborted|aborterror|timeout|timed out|fetch failed|network|ECONN|ETIMEDOUT|ENOTFOUND|请求中断|请求超时|无法读取服务响应/i.test(text)) {
    category = 'connection_interrupted'; reason = '获取服务响应时连接中断或超时；仅凭这一点无法判断模型是否已经完成。'; action = '先查看原任务状态，系统继续取回同一任务，不要重复生成。'
  } else if (/参考.*(?:上传失败|读取失败|下载失败)|failed to (?:fetch|download).*image/i.test(text)) {
    category = 'reference_unavailable'; reason = '本次请求所需的参考素材未能被读取。'; action = '确认参考素材能预览；稍后重试素材传输，不要重复提交状态未确认的生成任务。'
  } else if (Number(options.status) === 422 || /不支持|不能超过|请选择|请输入|请先选择|无效|必须|暂无内容/.test(text)) {
    category = 'invalid_input'; reason = summary; action = '按提示调整素材或参数，再查看报价并提交。'
  } else if (Number(options.status) === 429) {
    category = 'rate_limited'; reason = summary; action = summary
  } else if (Number(options.status) === 403) {
    category = 'permission_denied'; reason = '当前账号或会话无权执行这次操作。'; action = '请检查当前账号和模型权限。'
  }
  let billing = ''
  if (['failed', 'expired', 'cancelled'].includes(options.generationStatus) && options.chargedPoints != null) {
    const charged = Number(options.chargedPoints)
    if (Number.isFinite(charged) && charged === 0) billing = Number(options.reservedPoints) > 0 ? '本次未扣积分，预扣积分已退还。' : '本次未扣积分。'
    else if (Number.isFinite(charged) && charged > 0) billing = `本次已扣 ${charged} 积分。`
  }
  const requestId = /^[A-Za-z0-9_-]{8,100}$/.test(String(options.requestId || '')) ? String(options.requestId) : ''
  return { version: 1, category, summary, reason, action, billing, ...(requestId ? { requestId } : {}) }
}
