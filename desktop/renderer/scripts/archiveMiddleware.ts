import { serveArchiveFile } from '../../../server/archive-file.ts'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const WEB_DIR = fileURLToPath(new URL('../', import.meta.url))
const IMAGE_DIR = resolve(WEB_DIR, '../../images')
const CONTENT_TYPES = {
  '.avif': 'image/avif', '.gif': 'image/gif', '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
}
export function blockPrivateArchive(middlewares) {
  middlewares.use((request, response, next) => {
    const pathname = new URL(request.url || '/', 'http://miaoimg.local').pathname
    if (!pathname.startsWith('/db/')) return next()
    response.statusCode = 404
    response.end('Not found')
  })
}

function serveArchiveImages(middlewares) {
  middlewares.use(async (request, response, next) => {
    if (!['GET', 'HEAD'].includes(request.method)) return next()
    let pathname: string
    try { pathname = new URL(request.url || '/', 'http://miaoimg.local').pathname }
    catch { response.statusCode = 400; response.end('Bad image path'); return }
    if (!pathname.startsWith('/images/')) return next()

    let relativePath
    try {
      relativePath = decodeURIComponent(pathname.slice('/images/'.length))
    } catch {
      response.statusCode = 400
      response.end('Bad image path')
      return
    }

    const filePath = resolve(IMAGE_DIR, relativePath)
    if (!filePath.startsWith(`${IMAGE_DIR}${sep}`)) {
      response.statusCode = 403
      response.end('Forbidden')
      return
    }

    try {
      if (!await serveArchiveFile(request, response, filePath, CONTENT_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream')) next()
    } catch {
      if (response.headersSent || response.destroyed) { response.destroy(); return }
      next()
    }
  })
}

export function archiveImagesPlugin() {
  return {
    name: 'miaoimg-images',
    configureServer(server) {
      serveArchiveImages(server.middlewares)
    },
    configurePreviewServer(server) {
      serveArchiveImages(server.middlewares)
    },
  }
}
