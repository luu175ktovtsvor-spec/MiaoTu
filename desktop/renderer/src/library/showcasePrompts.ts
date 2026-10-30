import type { FilmDetail } from '../../../../server/showcase-schema'

export async function readShowcaseDetail(id: string, version: string, signal: AbortSignal): Promise<FilmDetail> {
  const response = await fetch(`./api/library/showcase/films/${encodeURIComponent(id)}?version=${encodeURIComponent(version)}`, { signal })
  if (!response.ok) throw new Error('Film content unavailable')
  return response.json()
}
