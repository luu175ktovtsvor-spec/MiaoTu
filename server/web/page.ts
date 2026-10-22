import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'
import TurndownService from 'turndown'
import sniffEncoding from 'html-encoding-sniffer'
import { MIMEType } from 'node:util'
import { failure } from '../management-store.ts'

export function decodeWebText(bytes: Uint8Array, contentType: string) {
  let type: MIMEType
  try { type = new MIMEType(contentType) }
  catch { throw failure('网页内容类型无效', 422) }
  const mime = type.essence
  const charset = type.params.get('charset') || undefined
  const xml = mime === 'text/xml' || /^application\/(?:[\w.-]+\+)?xml$/.test(mime)
  const encoding = mime === 'text/html' || xml
    ? sniffEncoding(bytes, { xml, transportLayerEncodingLabel: charset, defaultEncoding: 'UTF-8' })
    : charset || 'utf-8'
  try { return new TextDecoder(encoding).decode(bytes) }
  catch { throw failure('网页字符编码不受支持', 422) }
}

// Parse fetched bytes only: no browser, scripts, resource loads or personal
// cookies. Readability selects the article; Turndown preserves links and code.
export function extractWebPage(html: string, url: string) {
  let window = parseHTML(html)
  if (window.document.documentElement?.localName !== 'html') window = parseHTML(`<html><body>${html}</body></html>`)
  const { document } = window
  if (document.querySelectorAll('*').length > 20_000) throw failure('网页结构过于复杂，请用浏览器读取', 413)
  let base = url
  try {
    const candidate = new URL(document.querySelector('base[href]')?.getAttribute('href') || url, url)
    if (['http:', 'https:'].includes(candidate.protocol) && !candidate.username && !candidate.password) base = candidate.href
  } catch { /* Invalid base URLs do not invalidate the fetched article. */ }
  // Some server-rendered pages wrap their article in a form. Readability
  // distinguishes that content from controls; removing the wrapper loses both.
  for (const node of document.querySelectorAll('script,style,noscript,template,nav,aside,iframe,object,embed,img,svg,canvas,video,audio,[hidden],[aria-hidden="true"]')) node.remove()
  for (const link of document.querySelectorAll('a[href]')) {
    try {
      const target = new URL(link.getAttribute('href') || '', base)
      if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('unsupported link')
      link.setAttribute('href', target.href)
    } catch { link.removeAttribute('href') }
  }
  const markdown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
  // Keep table cells and row boundaries readable without passing raw HTML.
  markdown.addRule('tableCell', { filter: ['th', 'td'], replacement: content => ` ${content.trim()} |` })
  markdown.addRule('tableRow', { filter: 'tr', replacement: content => `\n|${content}\n` })
  const articleDocument = document.cloneNode(true)
  if (!(articleDocument instanceof window.Document)) throw failure('网页正文解析失败', 422)
  // cloneNode does not copy custom document properties; bind the fetched URL
  // to the document Readability actually consumes.
  Object.defineProperty(articleDocument, 'baseURI', { value: base, configurable: true })
  Object.defineProperty(articleDocument, 'documentURI', { value: url, configurable: true })
  const article = new Readability(articleDocument, { maxElemsToParse: 20_000, serializer: node => markdown.turndown(node) }).parse()
  const fallback = document.querySelector('main') || document.querySelector('article') || document.body
  const text = article?.content?.trim() || markdown.turndown(fallback).trim()
  if (!text) throw failure('网页未提供可读取的正文，可能需要浏览器加载或登录', 422)
  // Title is metadata, not another unpaged copy of attacker-controlled HTML.
  // Keep the same title budget as search results while preserving all article text.
  return { title: (article?.title || document.title || '').slice(0, 400), text, format: 'markdown' }
}
