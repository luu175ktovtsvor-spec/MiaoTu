export type CanvasControlTarget = { directory?: string | null; expectedCanvasId?: string | null }
type CanvasState = { directory?: string | null; canvasId?: string | null }

export function captureCanvasControlTarget(state?: CanvasState | null): CanvasControlTarget {
  return { directory: state?.directory ?? null, expectedCanvasId: state?.canvasId ?? null }
}

// Metadata belongs to admission, not dispatch. Keep the same check at both
// receipt and after asynchronous panel activation, before selecting a context.
export function assertCanvasControlTarget(request: CanvasControlTarget, state: CanvasState) {
  if (request.directory && request.directory !== state.directory
    || request.expectedCanvasId !== undefined && request.expectedCanvasId !== (state.canvasId ?? null)) {
    throw Object.assign(new Error('工作区已切换，请重新读取应用状态'), { status: 409 })
  }
}
