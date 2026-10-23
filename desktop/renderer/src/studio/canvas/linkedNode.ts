import { inject, nextTick } from "vue";
import { useVueFlow, type GraphNode } from "@vue-flow/core";
import { isTypeCompatible, validateConnection, type NodeHandle } from "@miaoimg/nodes-scaffold/runtime";

// 节点标题像 LibTV 一样带序号（「图片生成 3」）：取画布上已有标题末尾数字的最大值加一，删掉节点也不会重号。
export function numberedNodeLabel(nodes: GraphNode[], base: string) {
  const used = nodes.map(node => Number(/\s(\d+)$/.exec(String(node.data?.label ?? ""))?.[1] ?? 0));
  return `${base} ${Math.max(0, ...used) + 1}`;
}

// 空节点的「尝试：」里有「文生视频」这类入口：在右边建一个下游节点并连上，和单击节点右侧「+」的结果一样。
export function useLinkedNode() {
  const flow = useVueFlow();
  const batchHistory = inject<((action: () => Promise<void>) => Promise<void>) | undefined>("batchCanvasHistory", undefined);
  const typeHandles = (type: string) => (flow.nodeTypes?.value?.[type] as { handles?: NodeHandle[] } | undefined)?.handles ?? [];
  const sourceHandles = (node: GraphNode) => ((node.data.handles as NodeHandle[] | undefined) ?? []).filter(handle => handle.type === "source");

  function canLink(source: GraphNode, type: string) {
    if (!flow.nodeTypes?.value?.[type]) return false;
    const inputs = typeHandles(type).filter(handle => handle.type === "target");
    return sourceHandles(source).some(output => inputs.some(input => isTypeCompatible(output.dataType, input.dataType)));
  }

  async function createLinked(source: GraphNode, type: string, label: string) {
    let created: GraphNode | undefined;
    const run = async () => {
      const id = crypto.randomUUID();
      const width = source.dimensions.width || 600;
      flow.addNodes({ id, type, position: { x: source.position.x + width + 120, y: source.position.y }, parentNode: source.parentNode, data: { label: numberedNodeLabel(flow.getNodes.value, label) } });
      // 远端节点挂载后才注册端口，和节点菜单一样等一拍再连线。
      await nextTick();
      created = flow.findNode(id);
      if (!created || flow.findNode(source.id) !== source) return;
      const inputs = ((created.data.handles as NodeHandle[] | undefined) ?? []).filter(handle => handle.type === "target");
      const connection = sourceHandles(source)
        .flatMap(output => inputs.filter(input => isTypeCompatible(output.dataType, input.dataType))
          .map(input => ({ source: source.id, target: id, sourceHandle: output.id, targetHandle: input.id })))
        .find(item => validateConnection(item, { sourceNode: source, targetNode: created!, nodes: flow.getNodes.value, edges: flow.getEdges.value }));
      if (connection) flow.addEdges(connection);
      flow.removeSelectedElements();
      flow.addSelectedNodes([created]);
    };
    if (batchHistory) await batchHistory(run);
    else await run();
    return created;
  }

  return { canLink, createLinked };
}
