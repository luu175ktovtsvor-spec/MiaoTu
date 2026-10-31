export function desktopBuild(value: unknown): number {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : 0
}
/** Product versions remain semantic versions; a monotonically increasing build
 * distinguishes an explicitly republished build of the same product version. */
export function newerDesktopRelease(candidate: { version: unknown; build?: unknown }, current: { version: unknown; build?: unknown }): boolean {
  const parts = (value: unknown) => /^\d+\.\d+\.\d+$/.test(String(value)) ? String(value).split('.').map(Number) : null
  const next = parts(candidate.version), now = parts(current.version)
  if (!next || !now) return false
  for (let index = 0; index < 3; index++) if (next[index] !== now[index]) return next[index] > now[index]
  return desktopBuild(candidate.build) > desktopBuild(current.build)
}
