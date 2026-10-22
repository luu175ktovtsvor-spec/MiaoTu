// A reserved media order already owns its credit hold. Only current execution
// permission and the original worker lease are checked at the transport edge;
// a balance reduced to zero by that hold must not reject the admitted order.
export type ReservedDispatchPolicy = {
  running: boolean
  ownsLease: boolean
  userOwned: boolean
  active: boolean
  enabled: boolean
  modelKnown: boolean
  modelEnabled: boolean
  modelAllowed: boolean
  video: boolean
  videoEnabled: boolean
}

export function assertReservedDispatch(policy: ReservedDispatchPolicy) {
  const deny = (message: string, status: number): never => {
    throw Object.assign(new Error(message), { status, submissionNotStarted: true })
  }
  if (!policy.running || !policy.ownsLease) deny('原任务已停止执行或租约已变更', 409)
  if (!policy.userOwned) deny('新模型请求必须属于已登录用户', 401)
  if (!policy.active) deny('账号已停用，尚未发起模型请求', 403)
  if (!policy.enabled || policy.video && !policy.videoEnabled) deny('管理员已暂停生成，尚未发起模型请求', 503)
  if (!policy.modelKnown || !policy.modelEnabled || !policy.modelAllowed) deny('生成模型权限已变更，尚未发起模型请求', 403)
}

// Only a server-retained pre-dispatch marker proves a running order was not
// sent. Older running records without that evidence keep their unknown state.
export function canRefundMediaCancellation(status: string, submissionState: unknown, upstreamRequestId: unknown) {
  return status === 'queued' || status === 'running' && submissionState === 'not_started' && !upstreamRequestId
}
