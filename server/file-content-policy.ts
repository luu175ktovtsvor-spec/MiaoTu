// Uploaded/provider/archive bytes are data even when navigated to directly.
// Permit passive SVG styling/embedded images, without running file scripts or
// loading network resources. Chromium's standalone media viewer re-reads its
// own URL, so audio/video alone retain origin for that existing playback path.
export function fileContentHeaders(mime: unknown): Record<string, string> {
  const type = String(mime || '').split(';')[0]!.trim().toLowerCase()
  const media = /^(?:video|audio)\/[\w.+-]+$/.test(type)
  return {
    'content-security-policy': media
      ? "default-src 'none'; media-src 'self'; sandbox allow-same-origin"
      : "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; sandbox",
    'x-content-type-options': 'nosniff',
  }
}

export function forwardedFileHeaders(response: { headers: Headers }): Record<string, string> {
  const names = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'cache-control']
  const headers: Record<string, string> = {}
  for (const name of names) {
    const value = response.headers.get(name)
    // Fetch exposes decoded bytes. The encoded transfer length cannot describe
    // the body relayed by this server; let HTTP stream its actual length.
    if (value !== null && !(name === 'content-length' && response.headers.get('content-encoding'))) headers[name] = value
  }
  return { ...headers, ...fileContentHeaders(headers['content-type']) }
}
