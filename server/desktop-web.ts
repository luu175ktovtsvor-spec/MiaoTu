import { createWebTools } from './web/tools.ts'
import { failure } from './management-store.ts'
import { json } from './http-auth.ts'
import { assertTextAccess } from './text-access.ts'

// A desktop proxy may resolve public names to fake private IPs. Execute only
// these two public web tools here, using the same pinned-DNS checks as web Agent.
export async function desktopWeb(request, response, session, url, { management, readJson, mutation }: Record<string, any>) {
  if (url.pathname !== '/api/imagine/desktop/web' || request.method !== 'POST') return false
  await assertTextAccess({ management, session, service: '联网工具' })
  mutation(request, session)
  const { tool, args = {} } = await readJson(request, 8192)
  if (!['webSearch', 'webFetch'].includes(tool)) throw failure('联网工具不存在', 422)
  // The peer may have gone away while the body was being read, before a close
  // listener existed. Check the current account before using the web service.
  if (response.destroyed || response.writableEnded) return true
  await assertTextAccess({ management, session, service: '联网工具' })
  const web = createWebTools({ beforeRequest: async () => (await assertTextAccess({ management, session, service: '联网工具' })) })
  const controller = new AbortController()
  const close = () => controller.abort()
  response.on('close', close)
  try {
    let result
    if (tool === 'webFetch') {
      const target = String(args?.url || '').trim()
      if (!target || target.length > 4096) throw failure('网页地址无效', 422)
      result = await web.fetchPublicText(target, controller.signal, { offset: args.offset, limit: args.limit, contentHash: args.contentHash })
    } else {
      const query = String(args?.query || '').trim()
      if (query.length < 2 || query.length > 300) throw failure('请输入 2 到 300 字的搜索关键词', 422)
      result = await web.searchWeb(query, Math.min(10, Math.max(1, Math.floor(Number(args?.limit) || 5))), controller.signal)
    }
    if (!response.destroyed && !response.writableEnded) json(response, 200, result)
  } finally {
    response.off('close', close)
  }
  return true
}
