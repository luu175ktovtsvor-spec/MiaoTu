export type ImageModelRequest = {
  model: string
  prompt: string
  size?: string
  quality?: string
  format?: string
  background?: string
  count?: number
  references?: string[]
  edit?: boolean
  async?: boolean
}

export type VideoModelRequest = {
  model: string
  prompt: string
  duration?: number
  resolution?: string
  mode?: 'text' | 'image' | 'edit' | 'extend'
  image?: string
  images?: string[]
  video?: string
  async?: boolean
}

export type ModelRouter = {
  image(request: ImageModelRequest, csrf?: string): Promise<Record<string, unknown>>
  video(request: VideoModelRequest, csrf?: string): Promise<Record<string, unknown>>
  imageStatus(requestId: string, accessToken?: string): Promise<Record<string, unknown>>
  videoStatus(requestId: string, accessToken?: string): Promise<Record<string, unknown>>
  cancelImage(requestId: string, accessToken?: string, csrf?: string): Promise<Record<string, unknown>>
}

async function readResponse(response: Response): Promise<Record<string, unknown>> {
  const data = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok || data.ok === false) {
    throw new Error(String(data.error || data.message || `模型请求失败（${response.status}）`))
  }
  return data
}

function headers(csrf?: string) {
  return {
    'content-type': 'application/json',
    ...(csrf ? { 'x-csrf-token': csrf } : {}),
  }
}

export function createModelRouter(fetchImpl: typeof fetch = fetch): ModelRouter {
  return {
    async image(request, csrf) {
      return readResponse(await fetchImpl('./api/imagine/generate', {
        method: 'POST',
        headers: headers(csrf),
        body: JSON.stringify(request),
      }))
    },
    async video(request, csrf) {
      return readResponse(await fetchImpl('./api/imagine/video', {
        method: 'POST',
        headers: headers(csrf),
        body: JSON.stringify(request),
      }))
    },
    async imageStatus(requestId, accessToken = '') {
      const query = accessToken ? `?access=${encodeURIComponent(accessToken)}` : ''
      return readResponse(await fetchImpl(`./api/imagine/generation/${encodeURIComponent(requestId)}${query}`))
    },
    async videoStatus(requestId, accessToken = '') {
      const query = accessToken ? `?access=${encodeURIComponent(accessToken)}` : ''
      return readResponse(await fetchImpl(`./api/imagine/video/${encodeURIComponent(requestId)}${query}`))
    },
    async cancelImage(requestId, accessToken = '', csrf) {
      const query = accessToken ? `?access=${encodeURIComponent(accessToken)}` : ''
      return readResponse(await fetchImpl(`./api/imagine/generation/${encodeURIComponent(requestId)}/cancel${query}`, {
        method: 'POST',
        headers: headers(csrf),
      }))
    },
  }
}
