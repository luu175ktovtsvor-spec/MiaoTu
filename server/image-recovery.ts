import type { ManagementStore } from './management-store.ts'
import { GENERATION_LIMITS, GENERATION_STATES } from './generation-contract.ts'
import { ImageReceiptFiles, imageReceiptBinding, type StoredImageReceipt } from './image-receipt-files.ts'

// This collector can only resume an original receipt. The new-generation
// admission, reference inputs and provider POST remain in the normal queue.
type RecoveryOptions = {
  files: ImageReceiptFiles; management: ManagementStore; workerId: string;
  active: (id: string, requestId: string) => boolean;
  capacity: () => boolean;
  resume: (row: Record<string, any>, receipt: StoredImageReceipt) => void;
}
export class ImageReceiptRecovery {
  private pending?: Promise<void>
  private stopped = false
  private warnings = new Set<string>()
  private options: RecoveryOptions
  constructor(options: RecoveryOptions) { this.options = options }
  collect(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (!this.pending) this.pending = this.scan().finally(() => { this.pending = undefined })
    return this.pending
  }
  stop() { this.stopped = true; return this.pending || Promise.resolve() }
  private async scan() {
    const { files, management, active, capacity, resume, workerId } = this.options
    const live = (id: string) => {
      if (files.isWriting(id)) return true
      const row = management.get('SELECT request_id,lease_id,lease_at FROM generations WHERE id=?', id)
      return Boolean(row && (active(id, row.request_id) || row.lease_id && Date.parse(row.lease_at) > Date.now() - GENERATION_LIMITS.leaseMs))
    }
    const ids = await files.list(true)
    for (const id of ids) {
      if (this.stopped) return
      try {
        const row = management.get('SELECT * FROM generations WHERE id=?', id)
        if (live(id)) continue
        if (row?.status === GENERATION_STATES.SUCCEEDED) { await files.remove(id); this.warnings.delete(id); continue }
        const receipt = row
          ? await files.recover(id, imageReceiptBinding(row), () => live(id))
          : await files.load(id, undefined, true)
        if (!receipt) continue
        if (live(id)) continue
        if (receipt.expiresAt <= Date.now()) {
          if (management.stopImageResultRecovery(id, 'expired')) { await files.remove(id); this.warnings.delete(id) }
          continue
        }
        if (!row || row.status !== GENERATION_STATES.RUNNING || !capacity()) continue
        const claimed = management.claimImageResult(id, workerId)
        if (claimed && !this.stopped) { resume(claimed, receipt); this.warnings.delete(id) }
        else if (claimed) management.releaseLease(id, workerId)
      } catch (error) {
        // Corrupt checkpoints also expire. Preserve the real task/ledger and
        // never infer a provider rejection from a file error.
        if (!live(id) && await files.expiredInvalid(id, management.artifactTtlMs()) && management.stopImageResultRecovery(id, 'expired')) await files.remove(id)
        else if (!this.warnings.has(id)) {
          this.warnings.add(id)
          console.warn('[image] 原图恢复回执暂不可读', id, error?.code || 'unknown')
        }
      }
    }
    for (const row of management.all("SELECT id,request_id,owner_scope,user_id,model FROM generations WHERE status='running' AND json_extract(parameters,'$.imageResultPending')=1")) {
      if (this.stopped) return
      if (ids.includes(row.id) || live(row.id)) continue
      // A receipt may have appeared since the directory snapshot. Recheck it
      // before reporting missing files; never turn that race into a new POST.
      if (!await files.recover(row.id, imageReceiptBinding(row), () => live(row.id)) && !live(row.id)) management.stopImageResultRecovery(row.id, 'missing')
    }
    // Only abandoned private temp directories; active leases are excluded.
    await files.pruneTemporary(management.artifactTtlMs(), live)
    for (const id of this.warnings) if (!ids.includes(id)) this.warnings.delete(id)
  }
}
