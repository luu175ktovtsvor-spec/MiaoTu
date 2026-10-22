import prepared from './playback.json'

// Published derivatives have separate immutable URLs; source films stay intact.
export function playbackUrl(source: string) {
  return (prepared as Record<string, string>)[source] || source
}
