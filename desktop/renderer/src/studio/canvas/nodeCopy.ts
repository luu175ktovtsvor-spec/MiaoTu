import type { Edge, GraphEdge, GraphNode, Node } from "@vue-flow/core";
import { getTargetValues } from "./scaffold/nodeInputs";
import { referenceKey, remapReferenceKey, orderNodeReferences, nodeReferenceMentions } from "./scaffold/nodeReferences";
import { isPromptModel, remapPromptReferenceIds, normalizePromptModel, getPromptText } from "./scaffold/promptModel";
import { remapCanvasTextSnapshots } from '../../../../../server/canvas-text-snapshot.ts';
import { captureWorkspaceScope, DEFAULT_PROJECT } from '@/lib/workspaceRemote';
import type { WorkspaceReferenceScope } from '../../../../../server/workspace-path.ts';

export function captureCanvasCopyScope(): WorkspaceReferenceScope {
  return { ...captureWorkspaceScope(), defaultProject: DEFAULT_PROJECT, origin: window.location.origin };
}

// All copy entry points keep custom persistent geometry/configuration, while
// excluding Vue Flow's live references and the original selection state.
export function cloneNodeGraph(nodes: Node[], edges: Edge[]) {
  const ids = new Set(nodes.map(node => node.id));
  return JSON.parse(JSON.stringify({
    nodes: nodes.map(node => {
      const { computedPosition, handleBounds, selected, dimensions, isParent, resizing, dragging, events, initialized, ...saved } = node as GraphNode & { initialized?: boolean };
      return { ...saved, data: saved.data ?? {} };
    }),
    edges: edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)).map(edge => {
      const { selected, sourceNode, targetNode, sourceX, sourceY, targetX, targetY, events, ...saved } = edge as GraphEdge;
      return saved;
    }),
  })) as { nodes: Node[]; edges: Edge[] };
}

// 只操作复制后独占的数据；保留副本以外的输入来源，不猜测其他插件字段的含义。
export function remapCopiedNodeReferences(copies: Node[], edges: Edge[], ids: ReadonlyMap<string, string>, retained: Node[], scope: WorkspaceReferenceScope) {
  remapCanvasTextSnapshots(copies, ids, scope);
  const nodes = new Map([...retained, ...copies].map(node => [node.id, node]));
  const incoming = Map.groupBy(edges, edge => edge.target);
  for (const copy of copies) {
    const data = copy.data;
    if (data.referenceOrder && typeof data.referenceOrder === "object" && !Array.isArray(data.referenceOrder)) {
      data.referenceOrder = Object.fromEntries(Object.entries(data.referenceOrder).map(([handle, keys]) => [handle,
        Array.isArray(keys) ? keys.map(key => typeof key === "string" ? remapReferenceKey(key, ids) : key) : keys,
      ]));
    }
    if (isPromptModel(data.promptModel)) data.promptModel = remapPromptReferenceIds(data.promptModel, ids);
  }
  for (const copy of copies) {
    const data = copy.data;
    // 内置提示词使用 in 端口。更新已连接参考序号，缺失的稳定标签保留到重新连接或由用户移除。
    if (!isPromptModel(data.promptModel) || !Array.isArray(data.referenceOrder?.in)) continue;
    const values = orderNodeReferences(getTargetValues(copy.id, "in", nodes, incoming.get(copy.id) ?? []), data.referenceOrder.in);
    data.referenceOrder = { ...data.referenceOrder, in: values.map(referenceKey) };
    const promptModel = normalizePromptModel(data.promptModel, nodeReferenceMentions(values));
    data.promptModel = promptModel;
    data.prompt = getPromptText(promptModel);
  }
  return copies;
}
