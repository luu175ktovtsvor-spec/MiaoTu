import { computed, nextTick, onScopeDispose, ref, watch } from "vue";
import { useVueFlow, type GraphNode } from "@vue-flow/core";
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

  async function create() {
    if (creating.value || options.disabled() || !options.hasImage()) return;
    const source = JSON.stringify(options.node.data.outputs?.image);
    const assertAvailable = () => {
      lifetime.signal.throwIfAborted();
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
      const { nodeId } = await createVariation({
        label: translate("图层分离"), prompt: "", model: JSON.stringify([model.providerId, model.modelId]),
        size, ratio: "auto", layerDecomposition: true,
      }, lifetime.signal, assertAvailable);
      lifetime.signal.throwIfAborted();
      const created = flow.findNode(nodeId);
      if (!created) return;
      flow.removeSelectedElements();
      flow.addSelectedNodes([created]);
      await nextTick();
      if (lifetime.signal.aborted || flow.findNode(nodeId) !== created) return;
      await flow.fitView({ nodes: [nodeId], padding: 0.4, maxZoom: 1, duration: 200 });
    } catch (error) {
      if (!lifetime.signal.aborted) options.onError(error);
    } finally { creating.value = false; }
  }
  return { available, creating, create };
}
