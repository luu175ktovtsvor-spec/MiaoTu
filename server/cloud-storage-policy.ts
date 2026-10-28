export function cloudWorkspaceStorageEnabled(env = process.env) {
  return env.OIP_CLOUD_WORKSPACE_STORAGE !== 'disabled'
}

export function assertCloudWorkspaceWrite(method: string, env = process.env) {
  if (!cloudWorkspaceStorageEnabled(env) && !['GET', 'HEAD'].includes(method)) {
    throw Object.assign(new Error('项目和素材保存在桌面版，这里不再接收云端项目保存'), { status: 410 })
  }
}
