import type { GraphNode, useVueFlow } from "@vue-flow/core";
import { useNodeEvent } from "@miaoimg/nodes-scaffold/nodeEvent";
import { translate } from "@miaoimg/i18n/vue";
import { getSelectionTree } from "./selectionNodes";
import { canvasInjectionKey } from "../../../../../server/canvas-document.ts";

type DeletionGuard = (nodeIds: readonly string[], signal?: AbortSignal) => Promise<void>;
const guardsKey = canvasInjectionKey("miaoimg.nodeDeletionGuards");
type DeletionFlow = ReturnType<typeof useVueFlow> & { [guardsKey]?: Set<DeletionGuard> };

// Store on the shared flow, as with node events, so separate plugin bundles see
// the same document guards. Subscriptions are explicitly released by the host.
// Guards flush current state and can run before teardown and again at commit.
export function onBeforeCanvasNodeDeletion(flow: DeletionFlow, guard: DeletionGuard) {
  if (!flow[guardsKey]) Object.defineProperty(flow, guardsKey, { value: new Set<DeletionGuard>() });
  const guards = flow[guardsKey]!;
  guards.add(guard);
  return () => { guards.delete(guard); };
}

export async function prepareCanvasNodeDeletion(flow: DeletionFlow, nodeIds: readonly string[], signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!nodeIds.length) return;
  for (const guard of [...flow[guardsKey] ?? []]) {
    await guard(nodeIds, signal);
    signal?.throwIfAborted();
  }
}

// Node callbacks may save files or refuse removal. Keep the graph intact until
// every callback succeeds, then remove the captured nodes and edges together.
export async function deleteCanvasNodes(flow: ReturnType<typeof useVueFlow>, selection: GraphNode[], signal?: AbortSignal) {
  signal?.throwIfAborted();
  const nodes = getSelectionTree(selection, flow.getNodes.value).reverse();
  const ids = new Set(nodes.map(node => node.id));
  const parents = new Map(nodes.map(node => [node.id, node.parentNode]));
  const connectedEdges = () => flow.getEdges.value.filter(edge => ids.has(edge.source) || ids.has(edge.target));
  const edges = connectedEdges().map(edge => ({ edge, source: edge.source, target: edge.target,
    sourceHandle: edge.sourceHandle, targetHandle: edge.targetHandle }));

  function validateNode(node: GraphNode) {
    signal?.throwIfAborted();
    if (flow.findNode(node.id) !== node || node.parentNode !== parents.get(node.id)) throw new Error(translate("节点已变化，请重新操作"));
    if (node.deletable === false) throw new Error(translate("节点不允许删除：{0}", { 0: node.id }));
  }

  function validate() {
    signal?.throwIfAborted();
    nodes.forEach(validateNode);
    if (flow.getNodes.value.some(child => child.parentNode && ids.has(child.parentNode) && !ids.has(child.id))) {
      throw new Error(translate("分组内容已变化，请重新删除"));
    }
    const current = connectedEdges();
    const currentEdges = new Set(current);
    if (current.some(edge => edge.deletable === false)) throw new Error(translate("节点存在不可删除的连接"));
    if (current.length !== edges.length || edges.some(saved => !currentEdges.has(saved.edge)
      || saved.edge.source !== saved.source || saved.edge.target !== saved.target
      || saved.edge.sourceHandle !== saved.sourceHandle || saved.edge.targetHandle !== saved.targetHandle)) {
      throw new Error(translate("画布连接已变化，请重新操作"));
    }
  }

  validate();
  await prepareCanvasNodeDeletion(flow, [...ids], signal);
  validate();
  for (const node of nodes) {
    validateNode(node);
    await useNodeEvent(node.id, flow).emit("delete");
    validateNode(node);
  }
  // A document can receive another edit while a node's teardown is waiting.
  // Flush it again immediately before committing the structural removal.
  await prepareCanvasNodeDeletion(flow, [...ids], signal);
  validate();
  // No await between the final validation and the single graph mutation.
  flow.removeNodes([...ids], true, false);
  return { nodeIds: [...ids], edgeIds: edges.map(({ edge }) => edge.id) };
}
