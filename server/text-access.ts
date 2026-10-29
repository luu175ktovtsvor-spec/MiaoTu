import { assertTextModelPolicy } from './text-model-policy.ts'
import { assertModelIdentity } from './model-access.ts'

// 云端自配供应商仍属于当前账号，但不使用妙图积分。
export const assertTextIdentity = assertModelIdentity

// Eligibility follows the effective per-user policy; reservation rechecks it.
export async function assertTextAccess(options: Record<string, any>) {
  const user = (await assertModelIdentity(options))
  if (!(Number(user.points) > 0) && !(await options.management?.textBilling?.hasFreeAccess(user.id, options.modelId, options.source || 'agent'))) throw Object.assign(new Error('积分不足，请先充值后使用文本模型'), { status: 402 })
  return user
}

export async function assertTextModelAccess(options: Record<string, any>) {
  const user = (await assertTextAccess(options))
  assertTextModelPolicy((await options.management.settings()), options.modelId, user.models || [])
  return user
}
