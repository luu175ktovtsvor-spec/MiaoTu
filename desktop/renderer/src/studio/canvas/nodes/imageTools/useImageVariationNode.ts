import { inject, nextTick, onScopeDispose, watch } from "vue";
import { useNode, useVueFlow } from "@vue-flow/core";
import { translate } from "@miaoimg/i18n/vue";
import { useNodeFiles } from "../../scaffold/workspaceFiles";

export function useImageVariationNode() {
  const { id, node } = useNode();
  const { addNodes, addEdges, removeNodes, findNode, getNodes, nodeTypes } = useVueFlow();
  const batchHistory = inject<(action: () => Promise<void>) => Promise<void>>("batchCanvasHistory", action => action());
  const canvasSignal = inject<(() => AbortSignal) | undefined>("canvasOperationSignal", undefined);
  const files = useNodeFiles();
  const lifetime = new AbortController();
  let disposed = false;
  onScopeDispose(() => { disposed = true; lifetime.abort(); });

  return async function createVariation(input: { label: string; prompt: string; model: string; size: string; ratio: string; nodeId?: string; layerDecomposition?: boolean; format?: string; background?: string; quality?: string; sourceRole?: string }, signal?: AbortSignal, assertAvailable?: () => void) {
    const type = "remote-imageGenerationNode";
    const currentCanvasSignal = canvasSignal?.();
    const operation = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : []), ...(currentCanvasSignal ? [currentCanvasSignal] : [])]);
    operation.throwIfAborted();
    const source = JSON.stringify(node.data.outputs?.image);
    const assertSource = () => {
      if (disposed || findNode(id) !== node || JSON.stringify(node.data.outputs?.image) !== source) throw new Error(translate("原节点已变化，请重新操作"));
      if (!nodeTypes?.value?.[type]) throw new Error(translate("请先启用图片生成节点插件"));
      assertAvailable?.();
    };
    assertSource();
    const image = node.data.outputs?.image;
    if (image?.dataType !== "IMAGE" || !image.value?.url) throw new Error(translate("请先设置有效原图"));
    const workspace = files.getWorkspaceFiles();
    let dimensions: { width: number; height: number } | undefined;
    if (workspace.readImageSize) {
      const changed = new AbortController();
      const stop = watch(() => JSON.stringify(node.data.outputs?.image), () => changed.abort(new Error(translate("原节点已变化，请重新操作"))), { flush: "sync" });
      try { dimensions = await workspace.readImageSize(image.value.url, AbortSignal.any([operation, changed.signal])); }
      finally { stop(); }
    }
    operation.throwIfAborted();
    assertSource();
    if (dimensions && (!Number.isFinite(dimensions.width) || dimensions.width <= 0 || !Number.isFinite(dimensions.height) || dimensions.height <= 0)) throw new Error(translate("无法读取原图片尺寸"));
    const sourceWidth = dimensions ? 360 * dimensions.width / dimensions.height + 2 : Math.max(node.dimensions.width || 0, node.data.mediaExportSize?.width || 0);
    if (!Number.isFinite(sourceWidth) || sourceWidth <= 0) throw new Error(translate("无法读取原图片尺寸"));
    const nodeId = input.nodeId ?? crypto.randomUUID();
    const edgeId = crypto.randomUUID();
    const { label, prompt, model, size, ratio } = input;
    const [ratioWidth = 0, ratioHeight = 0] = ratio.split(":").map(Number);
    const outputWidth = Number.isFinite(ratioWidth / ratioHeight) && ratioWidth > 0 && ratioHeight > 0 ? Math.max(320, 360 * ratioWidth / ratioHeight + 2) : 320;
    const outputHeight = 410;
    await batchHistory(async () => {
      operation.throwIfAborted();
      assertSource();
      if (findNode(nodeId)) throw new Error(translate("目标节点已存在，请重新操作"));
      // Recompute against the latest graph after waiting for the history lease.
      const x = node.computedPosition.x + Math.max(node.dimensions.width || 0, sourceWidth) + 80;
      let y = node.computedPosition.y;
      for (const other of [...getNodes.value].sort((left, right) => left.computedPosition.y - right.computedPosition.y)) {
        const position = other.computedPosition;
        const reserved = other.data.mediaExportSize || other.data.directorExportSize;
        const width = Math.max(other.dimensions.width || 0, reserved?.width || 320);
        const height = Math.max(other.dimensions.height || 0, reserved?.height || outputHeight);
        if (position.x < x + outputWidth && position.x + width > x && position.y < y + outputHeight && position.y + height > y) y = position.y + height + 40;
      }
      try {
        addNodes({ id: nodeId, type, position: { x, y }, data: { label: `${node.data.label || "图片"} · ${label}`, mediaExportSize: { width: outputWidth, height: outputHeight }, model, size, ratio, prompt, promptModel: prompt.split("\n").map(text => [{ type: "Write", text }]), ...(input.layerDecomposition ? { layerDecomposition: true } : {}),
          ...(input.format ? { format: input.format } : {}), ...(input.background ? { background: input.background } : {}), ...(input.quality ? { quality: input.quality } : {}),
          ...(input.sourceRole ? { imageReferenceRoles: { [encodeURIComponent(JSON.stringify([id, "image"]))]: input.sourceRole } } : {}),
        } });
        addEdges({ id: edgeId, source: id, sourceHandle: "image", target: nodeId, targetHandle: "in" });
      } catch (error) {
        removeNodes(nodeId, true, false);
        throw error;
      }
      await nextTick();
    });
    return { nodeId, edgeId };
  };
}
