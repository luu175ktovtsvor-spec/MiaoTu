import { assertTextModelPolicy } from './text-model-policy.ts'
import { assertModelAccess, assertModelIdentity } from './model-access.ts'

// 云端自配供应商仍属于当前账号，但不使用妙图积分。
export const assertTextIdentity = assertModelIdentity

// 妙图模型与云端联网工具读取实时余额；Agent 暂不记账。
export const assertTextAccess = assertModelAccess

export function assertTextModelAccess(options: Record<string, any>) {
  const user = assertTextAccess(options)
  assertTextModelPolicy(options.management.settings(), options.modelId, user.models || [])
  return user
}
