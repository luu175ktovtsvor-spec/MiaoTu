type TextModelPolicy = { enabled: boolean; models?: Record<string, boolean> }

// Shared policy only: callers still authenticate the account and validate the
// registered model. No database or credentials are owned by this module.
export function assertTextModelPolicy(settings: TextModelPolicy, modelId: string, allowedModels: readonly string[] = []) {
  const deny = (message: string, status: number): never => { throw Object.assign(new Error(message), { status }) }
  if (!settings.enabled) deny('模型调用暂不可用，请稍后再试', 503)
  if (settings.models?.[modelId] === false) deny('这个文本模型已暂停', 403)
  if (allowedModels.length && !allowedModels.includes(modelId)) deny('这个文本模型未对你的账号开放', 403)
}
