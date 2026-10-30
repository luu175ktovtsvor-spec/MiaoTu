import { useEffect, useState } from 'react'

const base = '/desktop-downloads/updates/'
export function compareVersions(a: string, b: string) {
  const left = a.split('.').map(Number), right = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i]
  return 0
}

// This boundary describes verified official packages, never source-tree candidates.
// Feed publication must follow signing/notarization acceptance for both Mac builds.
export function getMacInstallState(publishedVersion: string | null): 'signed' | 'unsigned' | 'unknown' {
  if (!publishedVersion || !/^\d+\.\d+\.\d+$/.test(publishedVersion)) return 'unknown'
  return compareVersions(publishedVersion, '3.2.1') >= 0 ? 'signed' : 'unsigned'
}

// A source-tree candidate or release-note entry is not a published release.
// Both official update feeds must agree before the site labels a version latest.
export function usePublishedRelease() {
  const [version, setVersion] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
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
      return value
    })).then(([windows, mac]) => {
      if (windows !== mac) throw new Error('Release feeds differ')
      setVersion(mac)
    }).catch(() => { if (active) setFailed(true) })
      .finally(() => window.clearTimeout(timeout))
    return () => { active = false; controller.abort(); window.clearTimeout(timeout) }
  }, [])
  return { version, failed }
}
