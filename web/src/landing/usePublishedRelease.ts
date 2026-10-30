import { useEffect, useState } from 'react'

const base = '/desktop-downloads/updates/'
export function compareVersions(a: string, b: string) {
  const left = a.split('.').map(Number), right = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i]
  return 0
}

// A file digest changes the download URL when a distribution image is repacked.
export function macDownloadRevisions(text: string) {
  const revisions: Record<string, string> = {}
  for (const match of text.matchAll(/^\s*- url: (.+)\r?\n\s+sha512: (\S+)/gm)) {
    const name = match[1].trim().replace(/^['"]|['"]$/g, '')
    const arch = /-(arm64|x64)\.dmg$/.exec(name)?.[1]
    if (arch && /^[A-Za-z0-9+/]{86}==$/.test(match[2])) revisions[arch + '.dmg'] = match[2].slice(0, 16)
  }
  if (!revisions['arm64.dmg'] || !revisions['x64.dmg']) throw new Error('Mac download digests unavailable')
  return revisions
}

// A source-tree candidate or release-note entry is not a published release.
// Both official update feeds must agree before the site labels a version latest.
export function usePublishedRelease() {
  const [version, setVersion] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [downloadRevisions, setDownloadRevisions] = useState<Record<string, string>>({})
  useEffect(() => {
    let active = true
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 12000)
    Promise.all(['latest.yml', 'latest-mac.yml'].map(async file => {
      const response = await fetch(base + file, { cache: 'no-store', signal: controller.signal })
      if (!response.ok) throw new Error('Release feed unavailable')
      const text = await response.text()
      const value = text.match(/^version:\s*['"]?(\d+\.\d+\.\d+)['"]?\s*$/m)?.[1]
      if (!value) throw new Error('Invalid release version')
      return { version: value, text }
    })).then(([windows, mac]) => {
      if (windows.version !== mac.version) throw new Error('Release feeds differ')
      const revisions = macDownloadRevisions(mac.text)
      if (active) { setDownloadRevisions(revisions); setVersion(mac.version) }
    }).catch(() => { if (active) setFailed(true) })
      .finally(() => window.clearTimeout(timeout))
    return () => { active = false; controller.abort(); window.clearTimeout(timeout) }
  }, [])
  return { version, failed, downloadRevisions }
}
