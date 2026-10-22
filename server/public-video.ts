// Internal video records retain provider receipts for download and recovery.
// User responses expose only the media fields consumed by the canvas, with
// authenticated links supplied by the caller instead of provider URLs.
export function publicVideoResult(video: Record<string, any> | null, links: { url: string; thumbnailUrl: string }) {
  if (!video) return null
  const workspacePath = video.metadata?.workspacePath
  return {
    id: video.id,
    url: links.url,
    mime: video.mime,
    duration: video.duration,
    width: video.width,
    height: video.height,
    thumbnailUrl: links.thumbnailUrl,
    metadata: typeof workspacePath === 'string' && workspacePath ? { workspacePath } : {},
    createdAt: video.createdAt,
  }
}
