import { marked } from 'marked'
import { Parser } from 'htmlparser2'
import { isWorkspacePath, workspaceFileReference, type WorkspaceReferenceScope } from './workspace-path.ts'

export function resolveMarkdownPath(source: string, documentPath = '') {
  if (/^(?:https?:|mailto:|#)/i.test(source)) return
  if (/^(?:[a-z][a-z\d+.-]*:|[\\/])/i.test(source)) throw new Error('文件路径必须位于工作区内')
  const path = decodeURIComponent(source.split(/[?#]/)[0]!).replaceAll('\\', '/')
  if (!path || /^(?:[a-z][a-z\d+.-]*:|\/)/i.test(path) || path.includes('\0')) throw new Error('文件路径无效')
  const parts = documentPath.replaceAll('\\', '/').split('/').slice(0, -1)
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!parts.length) throw new Error('文件路径超出工作区')
      parts.pop()
    } else parts.push(part)
  }
  return parts.join('/')
}

export type MarkdownFileReference = { path: string; kind: 'media' | 'link' }
export { isMarkdownFile } from './workspace-path.ts'

// Follow the HTML srcset URL/descriptor boundaries. Commas inside a URL are
// significant, including data URLs and workspace filenames; only trailing URL
// commas or descriptor commas separate candidates. Retain candidate URLs even
// when a descriptor is invalid so cleanup stays conservative.
function srcsetSources(value: string) {
  const sources: string[] = []
  const whitespace = (character: string) => /[\t\n\f\r ]/.test(character)
  let position = 0
  while (position < value.length) {
    while (position < value.length && (whitespace(value[position]!) || value[position] === ',')) position++
    const start = position
    while (position < value.length && !whitespace(value[position]!)) position++
    const url = value.slice(start, position)
    if (!url) break
    sources.push(url.replace(/,+$/, ''))
    if (url.endsWith(',')) continue
    let parens = false
    while (position < value.length) {
      const character = value[position++]!
      if (parens) { if (character === ')') parens = false }
      else if (character === '(') parens = true
      else if (character === ',') break
    }
  }
  return sources
}

// No DOM or resource loading: the same rendered Markdown tokens and inert
// HTML attributes protect originals in the browser and native file layer.
export function markdownFileReferences(text: string, documentPath: string, scope?: WorkspaceReferenceScope): MarkdownFileReference[] {
  if (text.startsWith('\ufeff')) text = text.slice(1)
  if (!text.includes('[') && !text.includes('<')) return []
  const references = new Map<string, MarkdownFileReference['kind']>()
  const add = (value: string, kind: MarkdownFileReference['kind']) => {
    try {
      let path: string | undefined
      if (/^(?:[a-z][a-z\d+.-]*:|[\\/])/i.test(value)) {
        const reference = workspaceFileReference(value, scope)
        if (reference?.sameScope) path = reference.path
      } else path = resolveMarkdownPath(value, documentPath)
      if (isWorkspacePath(path) && references.get(path) !== 'media') references.set(path, kind)
    } catch { /* Invalid or external references do not own workspace files. */ }
  }
  marked.walkTokens(marked.lexer(text, { gfm: true }), token => {
    if (token.type === 'image') add(token.href, 'media')
    else if (token.type === 'link') add(token.href, 'link')
    else if (token.type === 'html') {
      const parser = new Parser({ onopentag(name, attributes) {
        // markdownDom retains these standard HTML media elements and their
        // source/poster attributes. A direct workspace API URL works without
        // the Markdown image loader and must still retain its original.
        if (['img', 'video', 'audio', 'source', 'track'].includes(name) && attributes.src) add(attributes.src, 'media')
        if ((name === 'img' || name === 'source') && attributes.srcset) {
          for (const source of srcsetSources(attributes.srcset)) add(source, 'media')
        }
        if (name === 'video' && attributes.poster) add(attributes.poster, 'media')
        if (name === 'a' && attributes.href) add(attributes.href, 'link')
      } })
      parser.end(token.text)
    }
  })
  return [...references].map(([path, kind]) => ({ path, kind }))
}

export const getMarkdownFileReferences = (text: string, path: string, scope?: WorkspaceReferenceScope) => markdownFileReferences(text, path, scope).map(reference => reference.path)
