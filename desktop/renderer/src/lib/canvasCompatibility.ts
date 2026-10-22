import { legacyHostGlobals, legacyCanvasEvents, legacyCanvasStorage } from '../../../../server/canvas-document.ts'

let installed = false

// Installed plug-ins can keep their existing exports while the host uses the
// current namespace. Historical spellings live in the migration manifest.
export function installCanvasCompatibility() {
  if (installed) return
  installed = true
  const host = window as unknown as Record<string, unknown>
  for (const [previous, current] of Object.entries(legacyHostGlobals)) {
    if (Object.getOwnPropertyDescriptor(host, previous)?.get) continue
    if (host[current] === undefined && host[previous] !== undefined) host[current] = host[previous]
    Object.defineProperty(host, previous, { configurable: true, get: () => host[current], set: value => { host[current] = value } })
  }
  const forwarded = new WeakSet<Event>()
  for (const [previous, current] of Object.entries(legacyCanvasEvents)) {
    for (const [from, to] of [[previous, current], [current, previous]]) window.addEventListener(from, event => {
      if (forwarded.has(event)) return
      const next = new CustomEvent(to, { detail: (event as CustomEvent).detail })
      forwarded.add(next)
      window.dispatchEvent(next)
    })
  }
  for (const [previous, current] of Object.entries(legacyCanvasStorage)) {
    try { if (localStorage.getItem(current) === null && localStorage.getItem(previous) !== null) localStorage.setItem(current, localStorage.getItem(previous)!) } catch { /* Storage may be unavailable. */ }
  }
}
