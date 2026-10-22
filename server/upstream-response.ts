import { imageMime } from './result-cache.ts'

/**
 * Convert an upstream image response into the small, server-side image list
 * used by the downloader.  Upstreams occasionally return more images than
 * requested; cap before executeGeneration starts fetching remote image URLs.
 */
export function selectUpstreamImages(data, generation: Record<string, any> = {}) {
  const requestedCount = Number.isSafeInteger(Number(generation.count))
    ? Math.max(1, Number(generation.count))
    : 1
  const format = generation.format === 'jpg' ? 'jpeg' : generation.format
  return (Array.isArray(data?.data) ? data.data.slice(0, requestedCount) : [])
    .map((item) => ({
      // SUB2（云枢）可按生成/编辑返回不同格式；base64 的 MIME 以真实字节为准。
      // 尤其 format=auto 时，不能拼出不可解码的 data:image/auto。
      url: item.url || (item.b64_json ? `data:${imageMime(Buffer.from(item.b64_json, 'base64'), item.mime_type || `image/${format}`)};base64,${item.b64_json}` : ''),
      revisedPrompt: item.revised_prompt || data.revised_prompt || '',
    }))
    .filter((item) => item.url)
}
