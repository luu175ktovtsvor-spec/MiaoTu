export function isAdminHost() {
  return typeof window !== 'undefined' && window.location.hostname.toLowerCase() === 'admin.miaoimg.cn'
}
