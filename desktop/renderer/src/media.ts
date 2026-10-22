const BASE_URL = import.meta.env.BASE_URL || '/'
const THUMBNAIL_PREFIX = String(import.meta.env.VITE_OIP_THUMBNAIL_PREFIX || '').replace(/^\/+|\/+$/g, '')
const THUMBNAIL_FALLBACK_PREFIX = String(import.meta.env.VITE_OIP_THUMBNAIL_FALLBACK_PREFIX || '').replace(/^\/+|\/+$/g, '')
const THUMBNAIL_FORMAT = String(import.meta.env.VITE_OIP_THUMBNAIL_FORMAT || '').replace(/^\./, '')

export function assetUrl(localPath) {
  if (!localPath) return null
  if (/^https?:\/\//i.test(localPath)) return localPath

  const cleanBase = BASE_URL.endsWith('/') ? BASE_URL : `${BASE_URL}/`
  const cleanPath = String(localPath).replace(/^\/+/, '')
  return `${cleanBase}${cleanPath}`
}

export function isImageLikeUrl(url) {
  return Boolean(url && /\.(jpe?g|png|webp|gif|avif)(\?|$)/i.test(url))
}

export function isVideoLikeUrl(url) {
  return Boolean(url && /\.(mp4|m4v|mov|webm)(\?|$)/i.test(url))
}

function uniqueSources(...sources) {
  return [...new Set(sources.filter(Boolean))]
}

export function imageSources(image) {
  return uniqueSources(assetUrl(image?.local), image?.url)
}

export function thumbnailSources(image) {
  const localPath = image?.local
  const relativePath = localPath ? String(localPath).replace(/^\/+/, '').replace(/^images\//, '') : ''
  const previewPath = THUMBNAIL_FORMAT
    ? relativePath.replace(/\.[^./]+$/, `.${THUMBNAIL_FORMAT}`)
    : relativePath
  const thumbnail = THUMBNAIL_PREFIX && previewPath
    ? assetUrl(`${THUMBNAIL_PREFIX}/${previewPath}`)
    : null
  const fallback = THUMBNAIL_FALLBACK_PREFIX && relativePath
    ? assetUrl(`${THUMBNAIL_FALLBACK_PREFIX}/${relativePath}`)
    : null
  return uniqueSources(thumbnail, fallback, ...imageSources(image))
}

export function firstImageSources(item) {
  const first = item.images?.[0]
  if (first) return thumbnailSources(first)
  return uniqueSources(posterForVideo(item, item.videos?.[0]))
}

function posterForVideo(item, video) {
  if (video?.poster) return assetUrl(video.poster)
  if (isImageLikeUrl(video?.url)) return video.url
  const first = item.images?.[0]
  return first ? imageSources(first)[0] : null
}

export function videoSources(video) {
  return video ? uniqueSources(isVideoLikeUrl(video.local) ? assetUrl(video.local) : null, isVideoLikeUrl(video.url) ? video.url : null) : []
}

export function mediaItems(item) {
  return [
    ...(item.images || []).map((image) => ({
      type: 'image', sources: imageSources(image),
      mobileSources: thumbnailSources(image), sourceUrl: image.url,
    })),
    ...(item.videos || []).map((video) => {
      const sources = typeof window !== 'undefined' && window.miaoDesktop && /^\d+$/.test(String(item.tweet_id)) && Number.isInteger(video.index)
        ? [`/api/library/videos/${item.tweet_id}/${video.index}`]
        : videoSources(video)
      return sources.length ? {
        type: 'video', sources, poster: posterForVideo(item, video),
        sourceUrl: isVideoLikeUrl(video.url) ? video.url : item.tweet_url,
      } : {
        type: 'video-link', url: item.tweet_url,
        sources: uniqueSources(posterForVideo(item, video)),
      }
    }),
  ]
}
