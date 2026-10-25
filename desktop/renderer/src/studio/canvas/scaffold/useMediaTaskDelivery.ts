import { inject, onScopeDispose, type Ref } from 'vue';
import { useVueFlow, type GraphNode } from '@vue-flow/core';
import { canvasMediaPath, clearCanvasMediaTask, planCanvasMedia, type CanvasMediaTask } from '../../../../../canvas-delivery.ts';
import type { NodeOutputs, NodeMediaValue } from './values';

export function useMediaTaskDelivery(node: GraphNode, outputs: Readonly<Ref<NodeOutputs>>, kind: 'image' | 'video') {
  const flow = useVueFlow();
  const persist = inject<(() => Promise<void>) | undefined>('persistCanvasTaskBinding', undefined);
  const getSignal = inject<(() => AbortSignal) | undefined>('canvasOperationSignal', undefined);
  let boundLifetime: AbortSignal | undefined;
  let disposed = false;
  let boundRequestId = node.data?.taskRequestId as string | undefined;
  onScopeDispose(() => { disposed = true; });
  const data = () => node.data as CanvasMediaTask;
  function assertCurrent(signal?: AbortSignal, lifetime = boundLifetime) {
    signal?.throwIfAborted();
    lifetime?.throwIfAborted();
    if (disposed || flow.findNode(node.id) !== node) throw new Error('画布节点已变化，请重新操作');
  }
  function recover(requestId: string) {
    boundLifetime = getSignal?.();
    assertCurrent();
    if (boundRequestId === requestId && data().taskRequestId !== requestId) return;
    boundRequestId = requestId;
    if (data().taskRequestId === requestId) return;
    data().taskRequestId = requestId;
    delete data().taskOutputPath;
    delete data().taskExtraNodeIds;
  }
  async function bind(requestId: string, existing = false, extraNodeIds?: string[], signal?: AbortSignal) {
    if (boundRequestId !== requestId || !boundLifetime) boundLifetime = getSignal?.();
    const lifetime = boundLifetime;
    assertCurrent(signal, lifetime);
    // The POST acknowledgement may arrive after native delivery cleared T.
    // A repeated T callback must never recreate ownership or its baseline.
    if (boundRequestId === requestId) return;
    if (existing) recover(requestId);
    else {
      boundRequestId = requestId;
      data().taskRequestId = requestId;
      data().taskOutputPath = canvasMediaPath(outputs.value, kind);
      data().taskExtraNodeIds = extraNodeIds;
    }
    try {
      if (!persist) throw new Error('画布尚未就绪，无法保存生成任务');
      await persist();
      assertCurrent(signal, lifetime);
      if (data().taskRequestId !== requestId) throw new Error('画布任务已变化，请重新操作');
    } catch (error) {
      if (!existing) clearCanvasMediaTask(data(), requestId);
      throw error;
    }
  }
  function apply(requestId: string, results: readonly { path: string; mimeType: string; downloadSource?: NodeMediaValue['downloadSource'] }[]) {
    assertCurrent();
    // useNode's output ref is authoritative before nodeSkeleton's next tick.
    const nodes = flow.getNodes.value.map(item => item === node ? { ...item, data: { ...item.data, outputs: outputs.value } } : item);
    const plan = planCanvasMedia(nodes, { nodeId: node.id, requestId, kind, items: results.map(item => ({ path: item.path, mime: item.mimeType, downloadSource: item.downloadSource })) });
    if (!plan) throw new Error('原任务已脱离当前节点，请从生成历史取回结果');
    if (!plan.owned) return;
    if (plan.output) outputs.value[kind] = plan.output;
    flow.addNodes(plan.additions);
    clearCanvasMediaTask(data(), requestId);
  }
  return { bind, recover, apply, clear: (requestId: string) => clearCanvasMediaTask(data(), requestId) };
}
