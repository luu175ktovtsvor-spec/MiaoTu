export function cloudWorkspaceStorageEnabled(env = process.env) {
  return env.OIP_CLOUD_WORKSPACE_STORAGE !== 'disabled'
}
