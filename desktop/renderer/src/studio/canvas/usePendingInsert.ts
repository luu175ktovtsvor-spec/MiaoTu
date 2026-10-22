import { nextTick, watch } from 'vue'
import type { PendingCanvasInsert } from '@/stores/workspace'

type InsertedNode = { data: Record<string, unknown> }
type Options = {
  pending(): PendingCanvasInsert | null;
  take(): PendingCanvasInsert | null;
  ready(): boolean;
  binding(): string;
  signal(): AbortSignal;
  nodes(): readonly InsertedNode[];
  insert(value: PendingCanvasInsert): InsertedNode | undefined;
  save(): Promise<void>;
  acknowledge(value: PendingCanvasInsert): void;
  onInsertError(error: unknown): void;
}

// The shell retains the intent until node data is saved. Its stable id also
// survives a replay after an interrupted acknowledgment, preventing duplicates.
export function usePendingInsert(options: Options) {
  watch([options.pending, options.binding, options.ready], async () => {
    const value = options.pending()
    if (!value || !options.ready()) return
    const binding = options.binding(), signal = options.signal()
    await nextTick()
    if (signal.aborted || binding !== options.binding() || !options.ready() || options.pending() !== value) return
    // No asynchronous work between claiming and creating the node: a second
    // canvas/watcher cannot consume the same intent during a layout tick.
    const claimed = options.take()
    if (!claimed) return
    try {
      if (!options.nodes().some(node => node.data?.miaoimgInsertId === claimed.id)) {
        const node = options.insert(claimed)
        if (!node) throw new Error('画布尚未就绪')
        node.data.miaoimgInsertId = claimed.id
      }
    } catch (error) {
      if (!signal.aborted && binding === options.binding()) options.onInsertError(error)
      return
    }
    try {
      await options.save()
      // A successful save can acknowledge its original shell binding even if
      // that view has since retired. A failed save retains the shell's intent.
      options.acknowledge(claimed)
    } catch { /* The existing canvas save path reports and retains its error. */ }
  }, { immediate: true, flush: 'post' })
}
