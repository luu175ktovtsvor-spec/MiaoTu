type AcceptedVideoTask = { id: unknown; upstreamModel?: unknown; upstreamRequestId?: unknown; upstreamStatus?: unknown }
const diagnostic = (value: unknown, length: number) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, length)
const ACCEPTED_LOCAL_FAILURE = 'VIDEO_ACCEPTED_LOCAL_FAILURE'

// Once a creation response has a task ID, local bookkeeping failures cannot
// turn it into a rejected creation or authorize another paid POST. Keep the
// original task ID in the existing review reason even if its DB write failed.
export function acceptedVideoSubmissionError(cause: unknown, task: AcceptedVideoTask) {
  const upstreamTaskId = task.id
  const upstreamModel = String(task.upstreamModel ?? '')
  const upstreamStatus = Number.isInteger(Number(task.upstreamStatus)) ? Number(task.upstreamStatus) : 0
  return Object.assign(new Error(`视频上游已受理，本地收尾暂未完成，请核对原任务；taskId=${diagnostic(upstreamTaskId, 200)}；model=${diagnostic(upstreamModel, 200)}；HTTP=${upstreamStatus}`, { cause }), {
    status: 503, code: ACCEPTED_LOCAL_FAILURE, upstreamAccepted: true, submissionUncertain: true,
    upstreamTaskId, upstreamModel, upstreamStatus, upstreamRequestId: diagnostic(task.upstreamRequestId || upstreamTaskId, 200),
  })
}

// Only the host's accepted-create evidence can restore a pollable ID. Display
// truncation/sanitization must never manufacture an ID for an automatic GET.
export function acceptedVideoSubmissionRecovery(metadata: Record<string, any>, video: boolean, currentTaskId: unknown) {
  const id = metadata.upstreamTaskId
  const status = metadata.upstreamStatus
  if (video !== true || metadata.code !== ACCEPTED_LOCAL_FAILURE || metadata.upstreamAccepted !== true
    || typeof id !== 'string' || !id || id.length > 200 || id.trim() !== id || /[\s\u0000-\u001f\u007f]/u.test(id)
    || !Number.isInteger(status) || status < 200 || status >= 300
    || currentTaskId != null && currentTaskId !== '' && currentTaskId !== id) return null
  return { requestId: id, model: typeof metadata.upstreamModel === 'string' ? metadata.upstreamModel.slice(0, 200) : '', status }
}
