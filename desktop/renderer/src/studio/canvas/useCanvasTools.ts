import { nextTick, watch, type Ref } from "vue";
import { useVueFlow, type XYPosition } from "@vue-flow/core";
import { useNodeEvent, useNodeToolsContext, validateConnection } from "@miaoimg/nodes-scaffold/runtime";
import { canvasSchemas, type CanvasContext, type CanvasToolCall } from "@miaoimg/tool-canvas/runtime";
import { createCanvasSelectionOperations, absoluteNodePosition, resizeGroup } from "./canvasSelectionOperations";
import { deleteCanvasNodes } from "./canvasNodeDeletion";
import { getSelectionTree } from "./selectionNodes";
import { arrangeSelection } from "./arrangeSelection";
import { copyCanvasNodes, pasteCanvasNodes } from "./nodeClipboard";
import { readWorkspaceControl } from "@/lib/mcpControl";
import { readClipboardText } from "@/lib/clipboard";
import useWorkspaceFiles from "@/lib/workspaceFiles";
import { importWorkspaceCanvasAssets } from './canvasDrop';
import { createAssetFolder } from "./saveCanvasAsset";
import { waitForNodeRuntime } from './nodeRuntime';
import { arrangeCanvas } from "./arrangeCanvas";
import { canvasEdgeSummary, canvasNodeSummary, createCanvasQueries, isCanvasRead } from "./canvasQueries";
import { captureWorkspaceScope, assertWorkspaceScope } from "@/lib/workspaceRemote";

// Agent, child tasks and MCP share one execution lane per workspace. The lease
// ends after the actual operation and save settle, including cancellation.
const workspaceExecutions = new Map<string, Promise<void>>();
const contextExecutors = new WeakMap<CanvasContext, CanvasContext["call"]>();
function serializeCanvas(scope: ReturnType<typeof captureWorkspaceScope>, task: () => Promise<unknown>) {
  const key = JSON.stringify([scope.owner, scope.project]);
  const previous = workspaceExecutions.get(key) ?? Promise.resolve();
  const result = previous.then(() => { assertWorkspaceScope(scope); return task(); });
  const settled = result.then(() => {}, () => {});
  workspaceExecutions.set(key, settled);
  void settled.then(() => { if (workspaceExecutions.get(key) === settled) workspaceExecutions.delete(key); });
  return result;
}

export function useCanvasTools(options: {
  availableNodes: Ref<{ type: string; label: string }[]>;
  flushSave(): Promise<void>;
  directory(): string;
  history: { batch(action: () => Promise<void>): Promise<void>; undo(): Promise<void>; redo(): Promise<void>; canUndo: Ref<boolean>; canRedo: Ref<boolean> };
  view(): Record<string, boolean>;
  setView(args: Record<string, unknown>): void;
  interactionBusy(): boolean;
  menu(): {
    getCanvases(): { id: string; name: string }[];
    addCanvas(name?: string, signal?: AbortSignal): Promise<string>;
    switchCanvas(canvasId: string, signal?: AbortSignal): Promise<void>;
    renameCanvas(canvasId: string, name: string, signal?: AbortSignal): Promise<string>;
    getFolders(): string[];
    createCanvasFolder(folder: string, signal?: AbortSignal): Promise<unknown>;
    moveCanvasFile(canvasId: string, folder: string, signal?: AbortSignal): Promise<string>;
    deleteCanvas(canvasId: string, signal?: AbortSignal): Promise<string>;
  };
  getCanvasBinding(): { id: string; signal: AbortSignal };
  resolveCanvasContext?(id: string): CanvasContext | undefined;
  copyCanvasFiles(directory: string, path: string, target: string, signal: AbortSignal): Promise<void>;
}) {
  const flow = useVueFlow();
  const workspaceScope = captureWorkspaceScope();
  const getNodeTools = useNodeToolsContext();
  const selection = createCanvasSelectionOperations(flow);
  const structural = new Set(['addNode', 'deleteNodes', 'moveNodes', 'renameNodes', 'connectNodes', 'deleteEdges', 'duplicateNodes', 'groupNodes', 'ungroupNodes', 'mergeGroups', 'reparentNodes', 'resizeGroups', 'arrangeNodes', 'arrangeCanvas', 'pasteNodes', 'importCanvasAssets']);
  let nodeRevision = 0;
  let edgeRevision = 0;
  // 只跟踪列表结构，不深读节点 data；批量更新合并到同一 tick。
  watch(flow.nodes, () => nodeRevision++, { deep: 1 });
  watch(flow.edges, () => edgeRevision++, { deep: 1 });
  const readCanvas = createCanvasQueries({
    nodes: () => flow.nodes.value,
    edges: () => flow.edges.value,
    findNode: flow.findNode,
    viewport: () => flow.viewport.value,
    selectedCount: () => flow.getSelectedNodes.value.length,
    nodeRevision: () => nodeRevision,
    edgeRevision: () => edgeRevision,
    canvases: () => options.menu().getCanvases(),
    nodeTypes: () => [...options.availableNodes.value, { type: "canvasGroup", label: "分组" }],
    folders: () => options.menu().getFolders(),
    nodeTools: getNodeTools,
  });

  function findNode(nodeId: string) {
    const node = flow.findNode(nodeId);
    if (!node) throw new Error(`节点不存在：${nodeId}`);
    return node;
  }

  function nodeInfo(nodeId: string) {
    const node = findNode(nodeId);
    return { node: { ...canvasNodeSummary(node), position: absoluteNodePosition(node, flow.findNode) } };
  }

  function nodePosition(position: XYPosition) {
    if (!flow.snapToGrid.value) return position;
    const [x, y] = flow.snapGrid.value;
    return { x: Math.round(position.x / x) * x, y: Math.round(position.y / y) * y };
  }

  return function createContext(id: string, canvasSignal: AbortSignal, workspaceSignal: AbortSignal): CanvasContext {
    let redirected: CanvasContext | undefined;
    const context: CanvasContext = {
      get id() { return redirected?.id ?? options.getCanvasBinding().id; },
      // 函数定义通过 getNodeTools 按需发现，初始化消息不携带节点清单。
      tools: [],
      fork() {
        return redirected?.fork?.() ?? createContext(id, canvasSignal, workspaceSignal);
      },
      getNodeLabel(nodeId) {
        if (redirected) return redirected.getNodeLabel?.(nodeId);
        const node = flow.findNode(nodeId);
        const label = node?.data.label ?? node?.label;
        return typeof label === "string" && label.trim() ? label : undefined;
      },
      call(request, signal) {
        return serializeCanvas(workspaceScope, () => perform(request, signal));
      },
    };
    async function perform(request: CanvasToolCall, signal?: AbortSignal): Promise<unknown> {
      if (redirected) return contextExecutors.get(redirected)!(request, signal);
      canvasSignal.throwIfAborted();
      id = options.getCanvasBinding().id;
      const changesCanvas = ["addCanvas", "switchCanvas", "renameCanvas", "moveCanvas", "deleteCanvas"].includes(request.name);
      const callSignal = AbortSignal.any([workspaceSignal, ...(changesCanvas ? [] : [canvasSignal]), ...(signal ? [signal] : [])]);
      callSignal.throwIfAborted();
      try {
        if (!isCanvasRead(request.name) && options.interactionBusy()) throw new Error('画布正在进行手动操作，请结束拖动或编辑后重试');
        let result: unknown;
        if (structural.has(request.name)) await options.history.batch(async () => { result = await execute(request, callSignal, id); });
        else result = await execute(request, callSignal, id);
        callSignal.throwIfAborted();
        if (changesCanvas) {
          const nextContext = options.resolveCanvasContext?.(String(result));
          if (nextContext) {
            redirected = nextContext;
            return contextExecutors.get(nextContext)!({ name: "getCanvas", args: {} }, callSignal);
          }
          const binding = options.getCanvasBinding();
          if (binding.id !== result) throw new Error("画布已再次切换，请重新发送消息");
          binding.signal.throwIfAborted();
          id = binding.id;
          canvasSignal = binding.signal;
          result = await execute({ name: "getCanvas", args: {} }, callSignal, id);
        }
        callSignal.throwIfAborted();
        canvasSignal.throwIfAborted();
        return result;
      } finally {
        // 删除入口已等待所有画布保存，并卸载目标实例；不能再调用已取消的旧实例保存。
        if (!isCanvasRead(request.name) && request.name !== "selectNodes" && request.name !== "deleteCanvas") await options.flushSave();
        callSignal.throwIfAborted();
      }
    }
    contextExecutors.set(context, perform);
    return context;
  };

  async function execute(request: CanvasToolCall, signal: AbortSignal, canvasId: string): Promise<unknown> {
    signal.throwIfAborted();
    if (isCanvasRead(request.name)) {
      await nextTick();
      if (request.name === 'getNodeTools') {
        const { nodeIds } = canvasSchemas.getNodeTools.parse(request.args);
        await Promise.all(nodeIds.map(id => waitForNodeRuntime(flow, id, signal)));
      }
      signal.throwIfAborted();
      const result = await readCanvas(request, canvasId, signal);
      return request.name === 'getCanvas' ? { ...result, view: options.view(), history: { canUndo: options.history.canUndo.value, canRedo: options.history.canRedo.value } } : result;
    }
    if (['groupNodes','mergeGroups','duplicateNodes','arrangeNodes','arrangeCanvas','resizeGroups'].includes(request.name) && !document.hidden && flow.vueFlowRef.value?.getClientRects().length) {
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      signal.throwIfAborted();
    }
    switch (request.name) {
      case "duplicateCanvas": {
        const { canvasId: source = canvasId, target } = canvasSchemas.duplicateCanvas.parse(request.args);
        if (!options.menu().getCanvases().some(canvas => canvas.id === source)) throw new Error("画布不存在，请重新获取画布列表");
        await options.copyCanvasFiles(options.directory(), source, target, signal);
        return { canvasId: target };
      }
      case "addCanvas": {
        const { name } = canvasSchemas.addCanvas.parse(request.args);
        return options.menu().addCanvas(name, signal);
      }
      case "switchCanvas": {
        const { canvasId: targetId } = canvasSchemas.switchCanvas.parse(request.args);
        await options.menu().switchCanvas(targetId, signal);
        return targetId;
      }
      case "renameCanvas": {
        const { canvasId: targetId = canvasId, name } = canvasSchemas.renameCanvas.parse(request.args);
        const renamedId = await options.menu().renameCanvas(targetId, name, signal);
        return targetId === canvasId ? renamedId : canvasId;
      }
      case "addNode": {
        const args = canvasSchemas.addNode.parse(request.args);
        const type = [...options.availableNodes.value, { type: "canvasGroup", label: "分组" }].find(node => node.type === args.type);
        if (!type) throw new Error('节点类型未启用或尚未加载，请先用 getCanvas({include:["nodeTypes"]}) 查询可用类型');
        const id = crypto.randomUUID();
        flow.addNodes({ id, type: type.type, position: nodePosition(args.position), data: { label: args.label ?? type.label }, ...(type.type === "canvasGroup" ? { style: { width: "400px", height: "300px" }, connectable: false, expandParent: false } : {}) });
        await nextTick();
        await waitForNodeRuntime(flow, id, signal);
        signal.throwIfAborted();
        return nodeInfo(id);
      }
      case "deleteNodes": {
        const { nodeIds } = canvasSchemas.deleteNodes.parse(request.args);
        const removed = await deleteCanvasNodes(flow, nodeIds.map(findNode), signal);
        await nextTick();
        return { nodeIds: removed.nodeIds, removedEdgeIds: removed.edgeIds.slice(0, 100), removedEdgeCount: removed.edgeIds.length, truncated: removed.edgeIds.length > 100 };
      }
      case "moveNodes": {
        const { moves } = canvasSchemas.moveNodes.parse(request.args);
        if (new Set(moves.map(move => move.nodeId)).size !== moves.length) throw new Error('nodeId 不能重复');
        moves.forEach(move => { if (findNode(move.nodeId).draggable === false) throw new Error(`节点不允许移动：${move.nodeId}`); });
        const targets = new Map(moves.map(move => [move.nodeId, nodePosition(move.position)]));
        function futurePosition(id: string, seen = new Set<string>()): XYPosition {
          if (seen.has(id)) throw new Error("分组关系存在循环");
          seen.add(id);
          const target = targets.get(id);
          if (target) return target;
          const node = findNode(id);
          const parent = node.parentNode ? futurePosition(node.parentNode, seen) : { x: 0, y: 0 };
          return { x: parent.x + node.position.x, y: parent.y + node.position.y };
        }
        const positions = moves.map(move => {
          const node = findNode(move.nodeId), target = targets.get(move.nodeId)!;
          const parent = node.parentNode ? futurePosition(node.parentNode) : { x: 0, y: 0 };
          return { node, position: { x: target.x - parent.x, y: target.y - parent.y } };
        });
        positions.forEach(({ node, position }) => flow.updateNode(node.id, { position }));
        await nextTick();
        return { nodes: moves.map(move => nodeInfo(move.nodeId)) };
      }
      case "renameNodes": {
        const { renames } = canvasSchemas.renameNodes.parse(request.args);
        renames.forEach(rename => findNode(rename.nodeId));
        renames.forEach(rename => flow.updateNodeData(rename.nodeId, { label: rename.label }));
        await nextTick();
        return { nodes: renames.map(rename => nodeInfo(rename.nodeId)) };
      }
      case "connectNodes": {
        const { connections } = canvasSchemas.connectNodes.parse(request.args);
        const edges = [...flow.getEdges.value];
        const entries = connections.map(connection => {
          const sourceNode = findNode(connection.source);
          const targetNode = findNode(connection.target);
          if (!flow.nodesConnectable.value || sourceNode.connectable === false || targetNode.connectable === false) {
            throw new Error(`节点不允许连接：${connection.source} -> ${connection.target}`);
          }
          const existing = edges.find(edge => edge.source === connection.source && edge.target === connection.target
            && edge.sourceHandle === connection.sourceHandle && edge.targetHandle === connection.targetHandle);
          if (existing) return { id: existing.id, connection, isNew: false };
          if (!validateConnection(connection, { sourceNode, targetNode, nodes: flow.getNodes.value, edges })) {
            throw new Error(`连接无效：${connection.source} -> ${connection.target}，请检查端口方向、数据类型以及目标节点的连接规则`);
          }
          const id = crypto.randomUUID();
          // ACT: 候选边只参与本批校验，全部通过后再一次提交画布。
          edges.push({
            ...connection, id, type: "default", selected: false, data: {}, events: {}, sourceNode, targetNode,
            sourceX: sourceNode.computedPosition.x, sourceY: sourceNode.computedPosition.y,
            targetX: targetNode.computedPosition.x, targetY: targetNode.computedPosition.y,
          });
          return { id, connection, isNew: true };
        });
        flow.addEdges(entries.filter(entry => entry.isNew).map(entry => ({ id: entry.id, ...entry.connection })));
        await nextTick();
        return { edges: entries.map(entry => canvasEdgeSummary(flow.findEdge(entry.id)!)) };
      }
      case "deleteEdges": {
        const { edgeIds } = canvasSchemas.deleteEdges.parse(request.args);
        edgeIds.forEach(edgeId => {
          const edge = flow.findEdge(edgeId);
          if (!edge) throw new Error(`连线不存在：${edgeId}`);
          if (edge.deletable === false) throw new Error(`连线不允许删除：${edgeId}`);
        });
        const nodeIds = [...new Set(edgeIds.flatMap(id => {
          const edge = flow.findEdge(id)!;
          return [edge.source, edge.target];
        }))];
        flow.removeEdges(edgeIds);
        await nextTick();
        return { edgeIds, nodes: nodeIds.map(id => nodeInfo(id)) };
      }
      case "selectNodes": {
        const { nodeIds } = canvasSchemas.selectNodes.parse(request.args);
        const nodes = nodeIds.map(findNode);
        if (nodes.some(node => node.selectable === false)) throw new Error("节点不允许选择");
        await selection.selectNodes(nodeIds, signal, false);
        await nextTick();
        const selected = flow.getSelectedNodes.value;
        return { selectedNodeIds: selected.slice(0, 100).map(node => node.id), selectedCount: selected.length, truncated: selected.length > 100 };
      }
      case "arrangeCanvas": {
        canvasSchemas.arrangeCanvas.parse(request.args);
        const { arrangedNodeIds, viewport } = await arrangeCanvas(flow, signal);
        return { arrangedNodeIds: arrangedNodeIds.slice(0, 100), arrangedCount: arrangedNodeIds.length, truncated: arrangedNodeIds.length > 100, viewport };
      }
      case "fitCanvas": {
        const { nodeIds } = canvasSchemas.fitCanvas.parse(request.args);
        nodeIds?.forEach(findNode);
        await nextTick();
        signal.throwIfAborted();
        flow.updateNodeInternals(nodeIds ?? flow.getNodes.value.map(node => node.id));
        const fitted = await flow.fitView({ nodes: nodeIds, padding: 0.2, duration: 0 });
        signal.throwIfAborted();
        return { fitted, nodeIds: nodeIds?.slice(0, 100), nodeCount: nodeIds?.length ?? flow.nodes.value.length, truncated: (nodeIds?.length ?? 0) > 100, viewport: { ...flow.viewport.value } };
      }
      case 'duplicateNodes': {
        const args = canvasSchemas.duplicateNodes.parse(request.args);
        const result = await selection.duplicateNodes(args.nodeIds.map(findNode), signal, args.withEdges);
        await selection.selectNodes(result.rootIds, signal);
        return { rootIds: result.rootIds, idMap: Object.fromEntries([...result.ids].slice(0, 100)), nodeCount: result.ids.size, truncated: result.ids.size > 100 };
      }
      case 'groupNodes': {
        const args = canvasSchemas.groupNodes.parse(request.args);
        const [groupId] = selection.groupNodes(args.nodeIds.map(findNode), args.label);
        await selection.selectNodes([groupId!], signal);
        return { groupId, nodeIds: args.nodeIds, ...nodeInfo(groupId!) };
      }
      case 'ungroupNodes': {
        const args = canvasSchemas.ungroupNodes.parse(request.args);
        const nodes = args.nodeIds.map(findNode);
        if (nodes.some(node => node.type !== 'canvasGroup')) throw new Error('解组目标必须是 canvasGroup');
        const nodeIds = selection.ungroupNodes(nodes);
        await selection.selectNodes(nodeIds, signal);
        return { removedGroupIds: args.nodeIds, nodeIds: nodeIds.slice(0, 100), nodeCount: nodeIds.length, truncated: nodeIds.length > 100 };
      }
      case 'mergeGroups': {
        const args = canvasSchemas.mergeGroups.parse(request.args);
        const nodes = args.nodeIds.map(findNode);
        if (nodes.some(node => node.type !== 'canvasGroup')) throw new Error('合并目标必须是 canvasGroup');
        const [groupId] = selection.mergeGroups(nodes);
        if (args.label) flow.updateNodeData(groupId!, { label: args.label });
        await selection.selectNodes([groupId!], signal);
        return { groupId, ...nodeInfo(groupId!) };
      }
      case 'reparentNodes': {
        const args = canvasSchemas.reparentNodes.parse(request.args);
        const nodeIds = selection.reparentNodes(args.nodeIds.map(findNode), args.parentId);
        await nextTick();
        return { nodeIds, parentId: args.parentId };
      }
      case 'resizeGroups': {
        const args = canvasSchemas.resizeGroups.parse(request.args);
        const sizes = args.sizes.map(size => ({ ...size, node: findNode(size.nodeId) }));
        if (new Set(sizes.map(size => size.nodeId)).size !== sizes.length) throw new Error('nodeId 不能重复');
        if (sizes.some(size => size.node.type !== 'canvasGroup' || size.node.draggable === false)) throw new Error('只能调整允许移动的分组框');
        for (const size of sizes) {
          const parent = size.node.parentNode ? absoluteNodePosition(findNode(size.node.parentNode), flow.findNode) : { x: 0, y: 0 };
          const position = size.position ? { x: size.position.x - parent.x, y: size.position.y - parent.y } : size.node.position;
          resizeGroup(flow, size.node, position, size.width, size.height);
        }
        await nextTick();
        return { nodes: sizes.map(size => ({ ...nodeInfo(size.nodeId).node, width: size.width, height: size.height })) };
      }
      case 'arrangeNodes': {
        const args = canvasSchemas.arrangeNodes.parse(request.args);
        arrangeSelection(flow, args.nodeIds.map(findNode), args.mode);
        await nextTick();
        return { nodes: args.nodeIds.map(id => nodeInfo(id).node), mode: args.mode };
      }
      case 'estimateGroup': {
        const { groupId } = canvasSchemas.estimateGroup.parse(request.args);
        if (findNode(groupId).type !== 'canvasGroup') throw new Error('目标必须是 canvasGroup 分组');
        // 组内全部节点（含嵌套分组），与「整组生成」相同的阅读顺序。
        const ids = new Set([groupId]);
        const members = [];
        for (let added = true; added;) {
          added = false;
          for (const node of flow.getNodes.value) {
            if (!ids.has(node.id) && node.parentNode && ids.has(node.parentNode)) { ids.add(node.id); members.push(node); added = true; }
          }
        }
        members.sort((a, b) => a.computedPosition.y - b.computedPosition.y || a.computedPosition.x - b.computedPosition.x);
        const tools = getNodeTools();
        const targets = [...tools.list(members.map(node => node.id), ['node:generateImage', 'node:generateVideo'])];
        const nodes = [];
        let points = 0;
        for (const target of targets) {
          signal.throwIfAborted();
          const config = await tools.call({ nodeId: target.nodeId, name: 'node:getConfig', args: {} }, signal) as { estimate?: { points?: number } | null } | null;
          const value = typeof config?.estimate?.points === 'number' ? config.estimate.points : null;
          if (value !== null) points += value;
          nodes.push({ nodeId: target.nodeId, label: target.nodeLabel, generate: target.name, points: value });
        }
        return { groupId, nodeCount: nodes.length, totalPoints: Math.round(points * 100) / 100, unquoted: nodes.filter(node => node.points === null).length, nodes, generationStarted: false };
      }
      case 'undoCanvas': case 'redoCanvas': {
        canvasSchemas[request.name].parse(request.args);
        const undo = request.name === 'undoCanvas';
        if (!(undo ? options.history.canUndo : options.history.canRedo).value) throw new Error(undo ? '没有可撤销的操作' : '没有可重做的操作');
        await options.history[undo ? 'undo' : 'redo']();
        return { canUndo: options.history.canUndo.value, canRedo: options.history.canRedo.value, nodeCount: flow.nodes.value.length, edgeCount: flow.edges.value.length };
      }
      case 'setCanvasView': {
        const args = canvasSchemas.setCanvasView.parse(request.args);
        options.setView(args);
        if (args.viewport) await flow.setViewport(args.viewport, { duration: 0 });
        return { viewport: { ...flow.viewport.value }, view: options.view() };
      }
      case 'copyNodes': {
        const args = canvasSchemas.copyNodes.parse(request.args);
        return copyCanvasNodes(flow, args.nodeIds.map(findNode), options.directory(), signal, args.writeSystemClipboard);
      }
      case 'pasteNodes': {
        const args = canvasSchemas.pasteNodes.parse(request.args);
        const command = args.command ?? await readClipboardText();
        signal.throwIfAborted();
        return pasteCanvasNodes(flow, options.directory(), command, args.position, options.availableNodes.value, signal);
      }
      case 'importCanvasAssets': {
        const args = canvasSchemas.importCanvasAssets.parse(request.args);
        const ids = await importWorkspaceCanvasAssets(args.paths, args.position, { directory: options.directory(), availableNodes: options.availableNodes.value, signal, flow });
        await nextTick();
        return { nodes: ids.map(id => nodeInfo(id).node) };
      }
      case 'createAssetFolder': {
        const args = canvasSchemas.createAssetFolder.parse(request.args);
        return createAssetFolder(useWorkspaceFiles(options.directory()), args.folder, signal);
      }
      case 'createCanvasFolder': {
        const args = canvasSchemas.createCanvasFolder.parse(request.args);
        return options.menu().createCanvasFolder(args.folder, signal);
      }
      case 'moveCanvas': {
        const args = canvasSchemas.moveCanvas.parse(request.args);
        const targetId = args.canvasId ?? canvasId;
        const moved = await options.menu().moveCanvasFile(targetId, args.folder, signal);
        return targetId === canvasId ? moved : canvasId;
      }
      case 'deleteCanvas': {
        const args = canvasSchemas.deleteCanvas.parse(request.args);
        return options.menu().deleteCanvas(args.canvasId, signal);
      }
      case 'switchPanel': case 'getDocument': case 'openDocument': case 'writeDocument': case 'closeDocument': case 'moveDocument': {
        const args = canvasSchemas[request.name].parse(request.args);
        const control = readWorkspaceControl();
        if (!control) throw new Error('工作台尚未就绪');
        return control.call({ type: 'call', callId: crypto.randomUUID(), name: request.name, args }, signal);
      }
      case "nodeTools": {
        const args = canvasSchemas.nodeTools.parse(request.args);
        await waitForNodeRuntime(flow, args.nodeId, signal);
        return getNodeTools().call(args, signal);
      }
      default: throw new Error(`未知画布操作：${request.name}`);
    }
  }
}
