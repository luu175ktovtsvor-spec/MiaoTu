import { assertTextModelPolicy } from './text-model-policy.ts'
import { assertModelIdentity } from './model-access.ts'

// 云端自配供应商仍属于当前账号，但不使用妙图积分。
export const assertTextIdentity = assertModelIdentity

// Eligibility follows the effective per-user policy; reservation rechecks it.
export function assertTextAccess(options: Record<string, any>) {
  const user = assertModelIdentity(options)
  if (!(Number(user.points) > 0) && !options.management?.textBilling?.hasFreeAccess(user.id, options.modelId, options.source || 'agent')) throw Object.assign(new Error('积分不足，请先充值后使用文本模型'), { status: 402 })
  return user
}

export function assertTextModelAccess(options: Record<string, any>) {
  const user = assertTextAccess(options)
  assertTextModelPolicy(options.management.settings(), options.modelId, user.models || [])
  return user
}
