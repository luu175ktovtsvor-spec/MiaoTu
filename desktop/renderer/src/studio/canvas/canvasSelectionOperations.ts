import { nextTick } from "vue";
import { getRectOfNodes, type useVueFlow, type GraphNode, type Node, type XYPosition } from "@vue-flow/core";
import { useNodeEvent } from "@miaoimg/nodes-scaffold/nodeEvent";
import { getSelectionRoots, getSelectionTree } from "./selectionNodes";
import { translate } from "@miaoimg/i18n/vue";
import { waitForNodeRuntime } from "./nodeRuntime";
import { captureCanvasCopyScope, remapCopiedNodeReferences } from "./nodeCopy";

// UI buttons, keyboard shortcuts, embedded Agent and MCP execute these same operations.
export function createCanvasSelectionOperations(flow: ReturnType<typeof useVueFlow>) {
  function assertMutable(selection: GraphNode[]) {
    for (const node of getSelectionTree(selection, flow.getNodes.value)) {
      if (flow.findNode(node.id) !== node) throw new Error(`节点已变化：${node.id}`);
      if (node.draggable === false) throw new Error(`节点不允许调整：${node.id}`);
      if (node.resizing || node.dragging) throw new Error("节点正在拖动或缩放，请结束后重试");
    }
  }
async function duplicateNodes(selection: GraphNode[], signal: AbortSignal, withEdges = true, positions?: Map<string, XYPosition>) {
  const scope = captureCanvasCopyScope();
  assertMutable(selection);
  const nodes = getSelectionTree(selection, flow.getNodes.value);
  const nodeIds = new Set(nodes.map(node => node.id));
  const parents = new Map(nodes.map(node => [node.id, node.parentNode]));
  const roots = getSelectionRoots(nodes, flow.getNodes.value);
  const ancestors = new Map<string, { node: GraphNode; parentNode: string | undefined }>();
  for (const root of roots) {
    const seen = new Set([root.id]);
    let parentId = root.parentNode;
    while (parentId) {
      if (seen.has(parentId)) throw new Error(translate("分组关系已变化，请重新创建副本"));
      seen.add(parentId);
      if (ancestors.has(parentId)) break;
      const parent = flow.findNode(parentId);
      if (!parent) throw new Error(translate("分组关系已变化，请重新创建副本"));
      ancestors.set(parentId, { node: parent, parentNode: parent.parentNode });
      parentId = parent.parentNode;
    }
  }
  function validateCopy() {
    signal.throwIfAborted();
    if (nodes.some(node => flow.findNode(node.id) !== node || node.parentNode !== parents.get(node.id))
      || [...ancestors].some(([id, saved]) => flow.findNode(id) !== saved.node || saved.node.parentNode !== saved.parentNode)) {
      throw new Error(translate("节点或分组关系已变化，请重新创建副本"));
    }
    const current = getSelectionTree(selection, flow.getNodes.value);
    if (current.length !== nodes.length || current.some(node => !nodeIds.has(node.id))) {
      throw new Error(translate("分组内容已变化，请重新创建副本"));
    }
    assertMutable(nodes);
  }
  await Promise.all(nodes.map(node => waitForNodeRuntime(flow, node.id, signal)));
  validateCopy();
  const rootsIds = new Set(roots.map(node => node.id));
  const bounds = getRectOfNodes(nodes);
  const ids = new Map(nodes.map(node => [node.id, crypto.randomUUID()]));
  const snapshot = flow.toObject();
  const savedNodes = new Map(snapshot.nodes.map(node => [node.id, node]));
  const incomingEdges = withEdges ? snapshot.edges.filter(edge => ids.has(edge.target)) : [];
  const copies = await Promise.all(nodes.map(async node => {
    const patch = await useNodeEvent(node.id, flow).emit("copy");
    signal.throwIfAborted();
    const saved = savedNodes.get(node.id)!;
    const copy = JSON.parse(JSON.stringify({ ...saved, data: { ...saved.data, ...patch } })) as Node;
    Reflect.deleteProperty(copy, "initialized");
    copy.id = ids.get(node.id)!;
    copy.parentNode = ids.get(saved.parentNode ?? "") ?? saved.parentNode;
    copy.position = positions ? { ...positions.get(node.id)! }
      : { x: saved.position.x + (rootsIds.has(node.id) ? bounds.width + 64 : 0), y: saved.position.y };
    copy.data = { ...copy.data, label: `${copy.data?.label || "未命名节点"} - 副本` };
    return copy;
  }));
  signal.throwIfAborted();
  if (nodes.some(node => flow.findNode(node.id) !== node)) throw new Error(translate("节点已变化，请重新创建副本"));
  const edges = incomingEdges.filter(edge => ids.has(edge.source) || flow.findNode(edge.source)).map(edge => ({
    ...JSON.parse(JSON.stringify(edge)),
    id: crypto.randomUUID(),
    source: ids.get(edge.source) ?? edge.source,
    target: ids.get(edge.target)!,
    selected: false,
  }));
  remapCopiedNodeReferences(copies, edges, ids, flow.getNodes.value, scope);
  // A callback can await file reads while the user edits this same graph.
  // Publish only against the captured tree and external parents, with no
  // asynchronous gap after this final check.
  validateCopy();
  flow.addNodes(copies);
  flow.addEdges(edges);
  return { ids, rootIds: roots.map(node => ids.get(node.id)!) };
}

function groupNodes(selection: GraphNode[], label = translate("分组")) {
  assertMutable(selection);
  const roots = getSelectionRoots(selection, flow.getNodes.value);
  if (!roots.length) return [];
  const rootIds = new Set(roots.map(node => node.id));
  if (roots.some(node => !node.dimensions.width || !node.dimensions.height)) throw new Error("节点尺寸尚未就绪，请稍后重试");
  const bounds = getRectOfNodes(roots);
  const parentNode = roots.every(node => node.parentNode === roots[0]!.parentNode) ? roots[0]!.parentNode : undefined;
  const parentPosition = flow.findNode(parentNode)?.computedPosition ?? { x: 0, y: 0 };
  const position = { x: bounds.x - 24, y: bounds.y - 40 };
  const id = crypto.randomUUID();
  const group: Node = {
    id,
    type: "canvasGroup",
    parentNode,
    position: { x: position.x - parentPosition.x, y: position.y - parentPosition.y },
    style: { width: `${bounds.width + 48}px`, height: `${bounds.height + 64}px` },
    connectable: false,
    expandParent: false,
    data: { label },
  };
  const nodes: Node[] = flow.getNodes.value.map(node => rootIds.has(node.id) ? {
    ...node,
    parentNode: id,
    position: { x: node.computedPosition.x - position.x, y: node.computedPosition.y - position.y },
    extent: undefined,
    expandParent: false,
  } : node);
  nodes.splice(nodes.findIndex(node => rootIds.has(node.id)), 0, group);
  flow.setNodes(nodes);
  return [id];
}

function ungroupNodes(selection: GraphNode[]) {
  assertMutable(selection);
  if (selection.some(node => node.type === "canvasGroup" && node.deletable === false)) throw new Error("分组不允许删除");
  const groups = new Map(selection.filter(node => node.type === "canvasGroup").map(node => [node.id, node]));
  const promoted: string[] = [];
  for (const node of flow.getNodes.value) {
    if (!node.parentNode || !groups.has(node.parentNode) || groups.has(node.id)) continue;
    const visited = new Set<string>();
    let parentNode: string | undefined = node.parentNode;
    while (parentNode && groups.has(parentNode) && !visited.has(parentNode)) {
      visited.add(parentNode);
      parentNode = groups.get(parentNode)!.parentNode;
    }
    if (parentNode && visited.has(parentNode)) parentNode = undefined;
    const parentPosition = flow.findNode(parentNode)?.computedPosition ?? { x: 0, y: 0 };
    flow.updateNode(node.id, {
      parentNode,
      position: { x: node.computedPosition.x - parentPosition.x, y: node.computedPosition.y - parentPosition.y },
      extent: undefined,
      expandParent: false,
    });
    promoted.push(node.id);
  }
  flow.removeNodes([...groups.keys()], true, false);
  return [...selection.filter(node => !groups.has(node.id)).map(node => node.id), ...promoted];
}

function mergeGroups(selection: GraphNode[]) {
  assertMutable(selection);
  const groups = getSelectionRoots(selection.filter(node => node.type === "canvasGroup"), flow.getNodes.value);
  if (groups.length < 2) throw new Error(translate("请至少选择两个分组"));
  if (groups.some(node => node.deletable === false)) throw new Error("分组不允许删除");
  const first = groups[0]!;
  const groupIds = new Set(groups.map(node => node.id));
  const bounds = getRectOfNodes(groups);
  const parentNode = groups.every(node => node.parentNode === first.parentNode) ? first.parentNode : undefined;
  const parentPosition = flow.findNode(parentNode)?.computedPosition ?? { x: 0, y: 0 };
  const style = typeof first.style === "function" ? first.style(first) : first.style;
  const merged: GraphNode = {
    ...first,
    parentNode,
    position: { x: bounds.x - parentPosition.x, y: bounds.y - parentPosition.y },
    dimensions: { width: bounds.width, height: bounds.height },
    style: { ...style, width: `${bounds.width}px`, height: `${bounds.height}px` },
  };
  const nodes: Node[] = flow.getNodes.value.flatMap(node => {
    if (groupIds.has(node.id)) return [];
    return node.parentNode && groupIds.has(node.parentNode) ? [{
      ...node,
      parentNode: first.id,
      position: { x: node.computedPosition.x - bounds.x, y: node.computedPosition.y - bounds.y },
      extent: undefined,
      expandParent: false,
    }] : [node];
  });
  const firstChild = nodes.findIndex(node => node.parentNode === first.id);
  nodes.splice(firstChild < 0 ? nodes.length : firstChild, 0, merged);
  flow.setNodes(nodes);
  return [first.id];
}

async function selectNodes(ids: string[], signal: AbortSignal, rootsOnly = true) {
  await nextTick();
  signal.throwIfAborted();
  flow.removeSelectedElements();
  const nodes = ids.flatMap(id => flow.findNode(id) ?? []);
  const roots = getSelectionRoots(nodes, flow.getNodes.value);
  flow.addSelectedNodes(rootsOnly ? roots : nodes);
  flow.nodesSelectionActive.value = roots.length > 1;
  flow.updateNodeInternals(ids);
}


  function reparentNodes(selection: GraphNode[], parentId: string | null) {
    assertMutable(selection);
    const parent = parentId ? flow.findNode(parentId) : undefined;
    if (parentId && parent?.type !== 'canvasGroup') throw new Error('目标必须是现有分组');
    const roots = getSelectionRoots(selection, flow.getNodes.value);
    const descendants = new Set(getSelectionTree(roots, flow.getNodes.value).map(node => node.id));
    if (parentId && descendants.has(parentId)) throw new Error('不能将分组移入自身或其子组');
    const position = parent?.computedPosition ?? { x: 0, y: 0 };
    const moves = roots.map(node => ({ node, position: { x: node.computedPosition.x - position.x, y: node.computedPosition.y - position.y } }));
    moves.forEach(({ node, position }) => flow.updateNode(node.id, { parentNode: parentId ?? undefined, position, extent: undefined, expandParent: false }));
    flow.setNodes(getSelectionTree(flow.getNodes.value, flow.getNodes.value));
    return roots.map(node => node.id);
  }
  return { duplicateNodes, groupNodes, ungroupNodes, mergeGroups, selectNodes, reparentNodes };
}

// Coordinates exposed to agents are absolute canvas coordinates, including nested groups.
export function absoluteNodePosition(node: Pick<GraphNode, 'id' | 'position' | 'parentNode'>, find: (id: string) => Pick<GraphNode, 'id' | 'position' | 'parentNode'> | undefined) {
  const position = { ...node.position };
  const visited = new Set([node.id]);
  let parentId = node.parentNode;
  while (parentId) {
    const parent = find(parentId);
    if (!parent || visited.has(parentId)) throw new Error(`节点 ${node.id} 的分组关系无效`);
    visited.add(parentId);
    position.x += parent.position.x; position.y += parent.position.y;
    parentId = parent.parentNode;
  }
  return position;
}

export function resizeGroup(flow: ReturnType<typeof useVueFlow>, node: GraphNode, position: XYPosition, width: number, height: number) {
  const dx = position.x - node.position.x, dy = position.y - node.position.y;
  for (const child of flow.getNodes.value) if (child.parentNode === node.id) {
    flow.updateNode(child.id, { position: { x: child.position.x - dx, y: child.position.y - dy } });
  }
  const style = typeof node.style === 'function' ? node.style(node) : node.style;
  flow.updateNode(node.id, { position, style: { ...style, width: `${width}px`, height: `${height}px` } });
  node.dimensions = { width, height };
}
