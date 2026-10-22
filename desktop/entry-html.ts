import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { Parser } from 'htmlparser2'

function entryPolicy(html: string) {
  const hashes = new Set<string>()
  let inline: string | undefined
  const parser = new Parser({
    onopentag(name, attributes) {
      if (name === 'script') inline = Object.hasOwn(attributes, 'src') ? undefined : ''
    },
    ontext(text) { if (inline !== undefined) inline += text },
    onclosetag(name) {
      if (name !== 'script') return
      if (inline !== undefined) hashes.add(`'sha256-${createHash('sha256').update(inline, 'utf8').digest('base64')}'`)
      inline = undefined
    },
  }, { decodeEntities: false })
  // HTML input preprocessing normalizes line endings before CSP hashes the
  // script text. Preserve every other character, including surrounding spaces.
  parser.end(html.replace(/\r\n?/g, '\n'))
  return [
    `script-src 'self' blob: ${[...hashes].join(' ')}`.trimEnd(),
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; ')
}

// Only the trusted renderer build's entry can authorize inline scripts. User
// files use their existing sandbox policy and never pass through this reader.
export function createDesktopEntryHtml(webRoot: string) {
  const entry = resolve(webRoot, 'index.html')
  let cached: { identity: string; body: Buffer; policy: string } | undefined
  return (file: string) => {
    if (resolve(file) !== entry) return undefined
    const stat = statSync(entry)
    const identity = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':')
    if (cached?.identity !== identity) {
      const body = readFileSync(entry)
      cached = { identity, body, policy: entryPolicy(body.toString('utf8')) }
    }
    // Serve the exact cached bytes used for this policy, rather than streaming
    // the file again after a concurrent development build could replace it.
    return cached
  }
}
