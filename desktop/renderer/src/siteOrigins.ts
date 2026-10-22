export const LANDING_ORIGIN = 'https://miaoimg.cn'
export const CANVAS_ORIGIN = 'https://canvas.miaoimg.cn'
export const ADMIN_ORIGIN = 'https://admin.miaoimg.cn'

function hostname() {
  return typeof window === 'undefined' ? '' : window.location.hostname.toLowerCase()
}

export function isCanvasHost() {
  return hostname() === 'canvas.miaoimg.cn'
}

export function isAdminHost() {
  return hostname() === 'admin.miaoimg.cn'
}

// Keep local preview links on the same Vite server; production uses named
// origins so the address bar communicates which product surface is open.
export function canvasEntry(path = '/') {
  if (hostname() === 'localhost' || hostname() === '127.0.0.1') return `${path}${path.includes('?') ? '&' : '?'}studio=1`
  return `${CANVAS_ORIGIN}${path}`
}

export function landingEntry(path = '/') {
  if (hostname() === 'localhost' || hostname() === '127.0.0.1') return path
  return `${LANDING_ORIGIN}${path}`
}
