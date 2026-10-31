import { computed, nextTick, onScopeDispose, ref, watch } from "vue";
import { useVueFlow, type GraphNode } from "@vue-flow/core";
import { nodeTools, z } from "@miaoimg/nodes-scaffold/runtime";
import type { NodeMediaModel } from "../../scaffold/nodeAi";
import { translate } from "@miaoimg/i18n/vue";
import { useImageVariationNode } from "./useImageVariationNode";

export function useImageLayerEntry(options: {
  node: GraphNode;
  hasImage: () => boolean;
  disabled: () => boolean;
  loadModels: () => Promise<NodeMediaModel[]>;
  onError: (error: unknown) => void;
}) {
  const flow = useVueFlow();
  const createVariation = useImageVariationNode();
  const models = ref<NodeMediaModel[]>([]);
  const creating = ref(false);
  const lifetime = new AbortController();
  const layerModels = (items: NodeMediaModel[]) => items.filter(model => model.type === "image"
    && model.supportsLayerDecomposition && model.layerSizes?.some(size => model.imageSizes?.includes(size)));
  const available = computed(() => options.hasImage() && layerModels(models.value).length > 0);
  onScopeDispose(() => lifetime.abort());
  watch(() => options.hasImage() && options.node.selected, async hasImage => {
    if (!hasImage) return;
    try {
      const result = await options.loadModels();
      if (!lifetime.signal.aborted) models.value = result;
    } catch { if (!lifetime.signal.aborted) models.value = []; }
  }, { immediate: true });

  async function createPrepared(signal?: AbortSignal) {
    if (creating.value || options.disabled() || !options.hasImage()) throw new Error(translate("原图片已变化或正在处理，请重新操作"));
    const operation = signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal;
    const source = JSON.stringify(options.node.data.outputs?.image);
    const assertAvailable = () => {
      operation.throwIfAborted();
      if (options.disabled() || !options.hasImage() || JSON.stringify(options.node.data.outputs?.image) !== source)
        throw new Error(translate("原图片已变化或正在处理，请重新操作"));
    };
    creating.value = true;
    try {
      models.value = await options.loadModels();
      assertAvailable();
      const choices = layerModels(models.value);
      const model = choices.find(item => JSON.stringify([item.providerId, item.modelId]) === options.node.data.model) || choices[0];
      if (!model) throw new Error(translate("当前模型不支持图层拆分"));
      const sizes = model.layerSizes!.filter(size => model.imageSizes?.includes(size));
      const size = sizes.includes(String(options.node.data.size)) ? String(options.node.data.size) : sizes[0]!;
      const { nodeId, edgeId } = await createVariation({
        label: translate("图层分离"), prompt: "", model: JSON.stringify([model.providerId, model.modelId]),
        size, ratio: "auto", layerDecomposition: true,
      }, operation, assertAvailable);
      operation.throwIfAborted();
      const created = flow.findNode(nodeId);
      if (!created || flow.findNode(nodeId) !== created) throw new Error(translate("目标节点已变化，请重新操作"));
      flow.removeSelectedElements();
      flow.addSelectedNodes([created]);
      await nextTick();
      if (operation.aborted || flow.findNode(nodeId) !== created) throw new Error(translate("目标节点已变化，请重新操作"));
      await flow.fitView({ nodes: [nodeId], padding: 0.4, maxZoom: 1, duration: 200 }).catch(() => {});
      return { nodeId, edgeId, prepared: true, generationStarted: false };
    } finally { creating.value = false; }
  }
  async function create() {
    if (creating.value || options.disabled() || !options.hasImage()) return;
    try { await createPrepared(); }
    catch (error) { if (!lifetime.signal.aborted) options.onError(error); }
  }
  nodeTools.register({
    name: "prepareImageLayers",
    description: "按当前图片创建图层分离的图片生成节点并连接原图。不打开面板，不提交生成。返回 nodeId。用户确认费用后再对新节点调用 generateImage。",
    parameters: z.strictObject({}),
    async execute(_args, { signal }) { signal?.throwIfAborted(); return createPrepared(signal); },
  });
  return { available, creating, create };
}
