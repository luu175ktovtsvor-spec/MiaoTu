import { createAiCompat } from '../server/ai-compat.ts'
import { readModelJson } from '../server/model-transport.ts'
import { createCustomProviderFetch } from '../server/provider-fetch.ts'
import { completeProviderText, listPublicProviderModels } from '../server/text-providers.ts'

// Legacy plugin text APIs share the same local provider settings as the Agent.
// MiaoImg model requests still go to the authenticated cloud gateway.
export function createDesktopTextApi({ workspaceFiles, cloud, loadOfficialModels, proxy, mutate, json, modelSignal = () => undefined, requestFetch = fetch }: Record<string, any>) {
  const compat = createAiCompat({ workspaceFiles, customProviderFetch: createCustomProviderFetch({ allowPrivate: true, fetchImpl: requestFetch }) })
  const captureAccount = () => {
    const account = cloud.account, revision = cloud.authRevision
    return () => {
      if (account !== cloud.account || revision !== cloud.authRevision) throw Object.assign(new Error('账号已切换，本次模型请求已停止'), { status: 409 })
    }
  }

  async function handle(request, response, session, url) {
    if (url.pathname === '/api/ai/models' && request.method === 'GET') {
      const assertCurrent = captureAccount()
      let official = []
      if (cloud.account) {
        try { official = await loadOfficialModels() }
        catch (error) { assertCurrent(); if (error.status === 409) throw error }
      }
      assertCurrent()
      json(response, 200, { code: 200, message: 'ok', data: [
        ...(Array.isArray(official) ? official.filter(model => model.providerId === 'miaoimg') : []),
        ...listPublicProviderModels(workspaceFiles, session.userId),
      ] })
      return true
    }
    if (!['/api/ai/generate', '/api/imagine/text'].includes(url.pathname) || request.method !== 'POST') return false
    mutate(request)
    const assertCurrent = captureAccount()
    const controller = new AbortController()
    const accountSignal = modelSignal()
    const signal = accountSignal ? AbortSignal.any([controller.signal, accountSignal]) : controller.signal
    const abort = () => { if (!response.writableEnded) controller.abort() }
    request.once('aborted', abort); response.once('close', abort)
    if (request.aborted || response.destroyed) abort()
    try {
      const payload = await readModelJson(request, undefined, signal)
      assertCurrent(); signal.throwIfAborted()
      const providerId = String(payload.providerId || '').trim()
      if (!providerId || providerId === 'miaoimg') {
        await proxy(request, response, url.pathname + url.search, { method: 'POST', body: payload, signal })
      } else if (url.pathname === '/api/ai/generate') {
        await compat.streamText(request, response, session, { payload, signal })
      } else {
        const result = await completeProviderText(workspaceFiles, session.userId, payload, { allowPrivate: true, signal, fetchImpl: requestFetch })
        assertCurrent(); signal.throwIfAborted()
        if (!response.destroyed && !response.writableEnded) json(response, 200, { ok: true, ...result })
      }
      return true
    } catch (error) {
      assertCurrent()
      throw error
    } finally {
      request.off('aborted', abort); response.off('close', abort)
      controller.abort()
    }
  }
  return { handle, stop: () => compat.stop() }
}
