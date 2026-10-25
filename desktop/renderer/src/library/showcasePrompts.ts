type PromptTranslations = Record<string, { 'zh-Hans'?: string; en?: string }>
const files = new Map<string, unknown>()

async function readFile<T>(file: string, signal: AbortSignal): Promise<T> {
  if (files.has(file)) return files.get(file) as T
  const response = await fetch('./' + file, { signal })
  if (!response.ok) throw new Error('Prompt content unavailable')
  const data: unknown = await response.json()
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid prompt content')
  if (files.size >= 24) files.delete(files.keys().next().value!)
  files.set(file, data)
  return data as T
}

export async function readOriginalPrompt(file: string, id: string, signal: AbortSignal) {
  const data = await readFile<Record<string, string>>(file, signal)
  if (typeof data[id] !== 'string' || !data[id].trim()) throw new Error('Original prompt missing')
  return data[id]
}

export async function readPromptTranslation(file: string, id: string, locale: 'zh-Hans' | 'en', signal: AbortSignal) {
  const data = await readFile<PromptTranslations>(file, signal)
  const text = data[id]?.[locale]
  return typeof text === 'string' ? text.trim() : ''
}
