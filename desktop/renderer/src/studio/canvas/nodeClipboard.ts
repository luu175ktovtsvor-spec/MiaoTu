import type { Edge, GraphNode, Node, useVueFlow } from "@vue-flow/core";
import { isNodeOutput } from "@miaoimg/nodes-scaffold/values";
import { useNodeEvent } from "@miaoimg/nodes-scaffold/nodeEvent";
import { getSelectionTree } from "./selectionNodes";
import { writeClipboardText } from "@/lib/clipboard";
import { waitForNodeRuntime } from "./nodeRuntime";
import { captureCanvasCopyScope, cloneNodeGraph, remapCopiedNodeReferences } from "./nodeCopy";
import { workspaceFileReference } from '../../../../../server/workspace-path.ts';

export const nodeClipboardCommand = /^miaoimg:paste-node:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type ClipboardNode = { type: string; data: Record<string, unknown> };
type ClipboardEntry = { command: string; directory: string; node?: ClipboardNode; nodes?: Node[]; edges?: Edge[] };

async function openClipboardDatabase(signal?: AbortSignal) {
  signal?.throwIfAborted();
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("miaoimg.nodeClipboard", 1);
    const abort = () => reject(signal!.reason);
    const cleanup = () => signal?.removeEventListener('abort', abort);
    signal?.addEventListener('abort', abort, { once: true });
    request.onupgradeneeded = () => {
      if (signal?.aborted) request.transaction?.abort();
      else request.result.createObjectStore("nodes");
    };
    request.onsuccess = () => {
      cleanup();
      if (signal?.aborted) { request.result.close(); reject(signal.reason); }
      else resolve(request.result);
    };
    request.onerror = () => { cleanup(); reject(signal?.aborted ? signal.reason : request.error); };
  });
}

async function accessClipboard(entry?: ClipboardEntry, signal?: AbortSignal) {
  const database = await openClipboardDatabase(signal);
  try {
    signal?.throwIfAborted();
    return await new Promise<ClipboardEntry | undefined>((resolve, reject) => {
      const transaction = database.transaction("nodes", entry ? "readwrite" : "readonly");
      const abort = () => { try { transaction.abort(); } catch { /* A completed transaction cannot be rolled back. */ } };
      const cleanup = () => signal?.removeEventListener('abort', abort);
      signal?.addEventListener('abort', abort, { once: true });
      const store = transaction.objectStore("nodes");
      // ACT: 只保留最近一次快照；旧命令失效，不累计复制历史。
      const request = entry ? store.put(entry, "latest") : store.get("latest");
      transaction.oncomplete = () => { cleanup(); signal?.aborted ? reject(signal.reason) : resolve(entry ?? request.result); };
      transaction.onabort = () => { cleanup(); reject(signal?.aborted ? signal.reason : transaction.error ?? new Error("节点剪贴数据读写失败")); };
    });
  } finally {
    database.close();
  }
}

export function copyNodeToClipboard(node: Pick<Node, "type" | "data"> & Partial<Node>, directory: string, signal?: AbortSignal) {
  // A single-node clipboard entry is a root, even when copied out of a group.
  return copyNodesToClipboard([{ ...node, id: node.id || crypto.randomUUID(), position: { x: 0, y: 0 }, parentNode: undefined, extent: undefined, expandParent: false }], [], directory, true, signal);
}

export async function copyNodesToClipboard(nodes: Node[], edges: Edge[], directory: string, writeSystemClipboard = true, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!directory) throw new Error("请先打开项目");
  if (!nodes.length || nodes.some(node => !node.type)) throw new Error("节点类型无效");
  const command = `miaoimg:paste-node:${crypto.randomUUID()}`;
  const snapshot = cloneNodeGraph(nodes, edges);
  await accessClipboard({ command, directory, ...snapshot }, signal);
  signal?.throwIfAborted();
  if (writeSystemClipboard) await writeClipboardText(command);
  return command;
}

export async function readClipboardNodes(command: string, directory: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!nodeClipboardCommand.test(command)) return;
  const entry = await accessClipboard(undefined, signal);
  if (!entry || entry.command !== command) throw new Error("节点剪贴数据已失效，请重新复制");
  const nodes = entry.nodes ?? (entry.node ? [{ ...entry.node, id: "clipboardNode", position: { x: 0, y: 0 } }] : undefined);
  const edges = entry.edges ?? [];
  if (!Array.isArray(nodes) || !nodes.length || !Array.isArray(edges) || nodes.some(node => !node
    || typeof node.id !== "string" || !node.id || typeof node.type !== "string" || !node.type
    || !node.data || typeof node.data !== "object" || Array.isArray(node.data)
    || !node.position || !Number.isFinite(node.position.x) || !Number.isFinite(node.position.y)
    || (node.parentNode !== undefined && (typeof node.parentNode !== "string" || node.parentNode === node.id)))) {
    throw new Error("节点剪贴数据格式错误，请重新复制");
  }
  const ids = new Set(nodes.map(node => node.id));
  if (ids.size !== nodes.length || nodes.some(node => node.parentNode !== undefined && !ids.has(node.parentNode))
    || edges.some(edge => !edge || typeof edge.id !== "string" || !edge.id || !ids.has(edge.source) || !ids.has(edge.target)
      || (edge.sourceHandle != null && typeof edge.sourceHandle !== "string")
      || (edge.targetHandle != null && typeof edge.targetHandle !== "string"))
    || new Set(edges.map(edge => edge.id)).size !== edges.length) {
    throw new Error("节点剪贴数据格式错误，请重新复制");
  }
  const parents = new Map(nodes.map(node => [node.id, node.parentNode]));
  const checked = new Set<string>();
  for (const node of nodes) {
    const path = new Set<string>();
    let id: string | undefined = node.id;
    while (id && !checked.has(id)) {
      if (path.has(id)) throw new Error("节点剪贴数据格式错误，请重新复制");
      path.add(id);
      id = parents.get(id);
    }
    path.forEach(id => checked.add(id));
  }
  let hasWorkspaceFile = nodes.some(node => { const panorama = node.data.panorama as { url?: unknown } | undefined; return typeof panorama?.url === 'string' && Boolean(workspaceFileReference(panorama.url)); }) || nodes.some(node => Object.values(node.data.outputs ?? {}).some(output => isNodeOutput(output)
    && typeof output.value === "object" && (workspaceFileReference(output.value.url)
      || !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(output.value.url))));
  if (!hasWorkspaceFile && entry.directory !== directory) {
    const { getMarkdownFileReferences } = await import('../../../../../server/markdown-file-references.ts');
    signal?.throwIfAborted();
    hasWorkspaceFile = nodes.some(node => {
      const data = node.data;
      const path = typeof data.textSnapshotPath === 'string' ? data.textSnapshotPath : `assets/${node.id}/content.md`;
      const texts = [data.textSnapshot, ...Object.values(data.outputs ?? {}).flatMap(output => isNodeOutput(output) && output.dataType === 'STRING' ? [output.value] : [])];
      return texts.some(text => typeof text === 'string' && getMarkdownFileReferences(text, path).length > 0);
    });
  }
  if (hasWorkspaceFile && entry.directory !== directory) {
    throw new Error(entry.directory ? "此节点引用工作区文件，不能跨项目粘贴" : "节点剪贴数据缺少工作目录，请重新复制");
  }
  return { nodes, edges };
}

async function snapshotCanvasNodes(flow: ReturnType<typeof useVueFlow>, selection: GraphNode[], signal: AbortSignal) {
  const nodes = getSelectionTree(selection, flow.getNodes.value);
  if (!nodes.length) throw new Error('请选择要复制的节点');
  await Promise.all(nodes.map(node => waitForNodeRuntime(flow, node.id, signal)));
  signal.throwIfAborted();
  if (nodes.some(node => flow.findNode(node.id) !== node)) throw new Error('节点已变化，请重新复制');
  const ids = new Set(nodes.map(node => node.id));
  const snapshot = flow.toObject();
  const savedNodes = new Map(snapshot.nodes.map(node => [node.id, node]));
  const copies = await Promise.all(nodes.map(async node => {
    const patch = await useNodeEvent(node.id, flow).emit('copy');
    signal.throwIfAborted();
    const saved = savedNodes.get(node.id)!;
    const parentNode = ids.has(saved.parentNode ?? '') ? saved.parentNode : undefined;
    return { ...saved, data: { ...saved.data, ...patch }, parentNode,
      ...(saved.parentNode && !parentNode ? { extent: undefined, expandParent: false } : {}),
      position: parentNode ? { ...saved.position } : { x: node.computedPosition.x, y: node.computedPosition.y } };
  }));
  signal.throwIfAborted();
  if (nodes.some(node => flow.findNode(node.id) !== node)) throw new Error('节点已变化，请重新复制');
  return { nodes: copies, edges: snapshot.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)), viewport: snapshot.viewport };
}

export async function copyCanvasNodes(flow: ReturnType<typeof useVueFlow>, selection: GraphNode[], directory: string, signal: AbortSignal, writeSystemClipboard = true) {
  const snapshot = await snapshotCanvasNodes(flow, selection, signal);
  const command = await copyNodesToClipboard(snapshot.nodes, snapshot.edges, directory, writeSystemClipboard, signal);
  return { command, nodeCount: snapshot.nodes.length };
}

// 整张画布复用节点的 copy 回调，不触碰用户剪贴板；新图保留布局，媒体继续引用原片。
export async function cloneCanvasSnapshot(flow: ReturnType<typeof useVueFlow>, signal: AbortSignal) {
  const scope = captureCanvasCopyScope();
  const nodes = [...flow.getNodes.value];
  signal.throwIfAborted();
  const snapshot = nodes.length ? await snapshotCanvasNodes(flow, nodes, signal) : flow.toObject();
  if (nodes.length !== flow.getNodes.value.length || nodes.some(node => flow.findNode(node.id) !== node)) throw new Error('节点已变化，请重新复制');
  const graph = cloneNodeGraph(snapshot.nodes, snapshot.edges);
  const ids = new Map(graph.nodes.map(node => [node.id, crypto.randomUUID()]));
  const edges = graph.edges.map(edge => ({ ...edge, id: crypto.randomUUID(), source: ids.get(edge.source)!, target: ids.get(edge.target)! }));
  const copies = graph.nodes.map(node => ({ ...node, id: ids.get(node.id)!, parentNode: ids.get(node.parentNode ?? "") }));
  return {
    miaoimgCanvas: true,
    viewport: { ...snapshot.viewport },
    nodes: remapCopiedNodeReferences(copies, edges, ids, [], scope),
    edges,
  };
}

export async function pasteCanvasNodes(flow: ReturnType<typeof useVueFlow>, directory: string, command: string, position: { x: number; y: number }, availableNodes: { type: string }[], signal: AbortSignal) {
  const scope = captureCanvasCopyScope();
  const snapshot = await readClipboardNodes(command, directory, signal);
  signal.throwIfAborted();
  if (!snapshot) throw new Error('剪贴板中没有妙图节点');
  if (snapshot.nodes.some(node => node.type !== 'canvasGroup' && !availableNodes.some(item => item.type === node.type))) throw new Error('请先安装并启用对应的节点插件');
  const ids = new Map(snapshot.nodes.map(node => [node.id, crypto.randomUUID()]));
  const roots = snapshot.nodes.filter(node => !node.parentNode);
  const left = Math.min(...roots.map(node => node.position.x)), top = Math.min(...roots.map(node => node.position.y));
  const edges = snapshot.edges.map(edge => ({ ...edge, id: crypto.randomUUID(), source: ids.get(edge.source)!, target: ids.get(edge.target)! }));
  const copies = snapshot.nodes.map(node => ({ ...node, id: ids.get(node.id)!, parentNode: ids.get(node.parentNode ?? ''), selected: true,
    position: node.parentNode ? node.position : { x: position.x + node.position.x - left, y: position.y + node.position.y - top } }));
  remapCopiedNodeReferences(copies, edges, ids, [], scope);
  flow.removeSelectedElements();
  flow.addNodes(copies);
  flow.addEdges(edges);
  flow.nodesSelectionActive.value = roots.length > 1;
  return { nodeIds: [...ids.values()].slice(0, 100), rootIds: roots.map(node => ids.get(node.id)!).slice(0, 100), nodeCount: ids.size, truncated: ids.size > 100 };
}
