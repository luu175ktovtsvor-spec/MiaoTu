// A reservation is an account hold, never evidence of settled text usage.
// This view also covers zero-credit requests which have no ledger debit row.
export function textChargeView(row: Record<string, any>) {
  return {
    id: row.id,
    requestId: row.request_id,
    model: row.model,
    status: row.status,
    statusLabel: row.status === 'billing_review' ? '文本用量待核对' : '文本预扣待结算',
    reservedPoints: Number(row.reserved_points || 0),
    reason: String(row.error || ''),
    createdAt: row.created_at,
    reviewAt: row.status === 'billing_review' ? row.finished_at || null : null,
  }
}
