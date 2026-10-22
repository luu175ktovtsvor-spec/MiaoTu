type RetentionState = { status?: unknown; parameters?: unknown; lease_id?: unknown; lease_at?: unknown }
const record = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value)

// A waiting task is not an active file reader after its original receipt has
// explicitly stopped recovering. The task and its charge still await review.
// Do not infer this state from elapsed generation time or a diagnostic string.
export function releasedDesktopImageInputs(state: RetentionState, now = Date.now()) {
  if (state.status !== 'running' || state.lease_id != null || state.lease_at != null || !Number.isFinite(now)) return false
  let parameters = state.parameters
  if (typeof parameters === 'string') { try { parameters = JSON.parse(parameters) } catch { return false } }
  if (!record(parameters) || parameters.desktopDelivery !== 1 || parameters.submissionUncertain !== true
    || Object.hasOwn(parameters, 'imageResultPending') || Object.hasOwn(parameters, 'imageResultRetry')) return false
  const stopped = parameters.imageResultRecoveryStopped
  if (!record(stopped) || !['expired', 'missing'].includes(stopped.reason) || typeof stopped.at !== 'string') return false
  const at = Date.parse(stopped.at)
  return Number.isFinite(at) && at <= now && new Date(at).toISOString() === stopped.at
}

// Prefilter only: the same transaction re-reads every remaining claimant and
// applies the strict predicate above before retiring an expired reference.
// The SQL alias is internal and fixed; the final placeholder is the sweep time.
export const RELEASED_DESKTOP_IMAGE_INPUTS_SQL = `COALESCE((g.status='running' AND g.lease_id IS NULL AND g.lease_at IS NULL
  AND json_extract(g.parameters,'$.desktopDelivery')=1 AND json_extract(g.parameters,'$.submissionUncertain')=1
  AND json_type(g.parameters,'$.imageResultPending') IS NULL AND json_type(g.parameters,'$.imageResultRetry') IS NULL
  AND json_extract(g.parameters,'$.imageResultRecoveryStopped.reason') IN ('expired','missing')
  AND json_type(g.parameters,'$.imageResultRecoveryStopped.at')='text'
  AND json_extract(g.parameters,'$.imageResultRecoveryStopped.at') GLOB '????-??-??T??:??:??.???Z'
  AND json_extract(g.parameters,'$.imageResultRecoveryStopped.at')<=?),0)`
