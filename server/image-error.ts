export function upstreamImageError(status, payload: Record<string, any> = {}) {
  const code = String(payload.error?.code || payload.code || '')
  const raw = String(payload.error?.message || payload.message || '')
  if (['moderation_blocked','content_policy_violation','safety_violation','OutputImageSensitiveContentDetected'].includes(code)) return { status: 422, message: '生成结果触发上游内容审核，请更换素材或调整描述后重试', code: 'CONTENT_REJECTED' }
  if (code === 'InputImageSensitiveContentDetected') return { status: 422, message: '输入图片触发上游内容审核，请更换素材后重试', code: 'INPUT_REJECTED' }
  if (code === 'InvalidParameter') {
    // 上游只给英文报错，这里把常见原因翻成用户能看懂的中文，避免只看到"400"。
    if (/pixel to be at least/i.test(raw)) return { status: 422, message: '参考图分辨率太低，请使用至少 512×512 的图片', code: 'IMAGE_TOO_SMALL' }
    if (/too complex to decompose/i.test(raw)) return { status: 422, message: '这张图层次太复杂，图层拆分失败；请换主体更清晰的图片', code: 'LAYER_COMPLEX' }
    if (/invalid url specified/i.test(raw)) return { status: 422, message: '参考图格式无效，请重新上传图片后重试', code: 'IMAGE_INVALID' }
    return { status: 422, message: '图片参数不符合上游要求，请调整尺寸或素材后重试', code: 'PARAM_INVALID' }
  }
  if (status === 429) return { status: 429, message: '模型服务繁忙，请稍后重试', code: 'UPSTREAM_BUSY' }
  return { status: status >= 500 ? 502 : 422, message: `图片请求失败，请重试`, code: 'UPSTREAM_FAILED' }
}
