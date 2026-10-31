import { computed, inject, nextTick, onScopeDispose, reactive, watch, type Ref } from "vue";
import { useVueFlow, type GraphNode } from "@vue-flow/core";
import { translate } from "@miaoimg/i18n/vue";
import { assertWorkspaceScope, captureWorkspaceScope } from "@/lib/workspaceRemote";
import type { NodeInpaintInput, NodeMediaModel } from "../../scaffold/nodeAi";
import type { CanvasToolExtension } from "../../useMediaPaletteActions";
import { useCanvasToolRegistry } from "../../canvasToolRegistry";
import { imageIntent, imageIntents, imageIntentModels, type ImageIntentId } from "./imageIntentCatalogue";
import { useImageVariationNode } from "./useImageVariationNode";
import { useNodeFiles } from "../../scaffold/workspaceFiles";
import { fitsCustomSize } from "../../scaffold/nodeAi";
import { imageRedrawOutput } from "./imageRedrawOutput";

const key = (model: NodeMediaModel) => JSON.stringify([model.providerId, model.modelId]);

export function useImageIntentActions(options: {
  node: GraphNode; hasImage: () => boolean; disabled: () => boolean;
  loadModels: () => Promise<NodeMediaModel[]>;
  prepareErase: (input: NodeInpaintInput, signal: AbortSignal) => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const flow = useVueFlow(), registry = useCanvasToolRegistry();
  const active = inject<Ref<boolean> | undefined>("canvasUiActive", undefined);
  const createVariation = useImageVariationNode();
  const files = useNodeFiles();
  const canvasSignal = inject<(() => AbortSignal) | undefined>("canvasOperationSignal", undefined);
  const lifetime = new AbortController();
  let operation = new AbortController(), operationSignal: AbortSignal = operation.signal, opening = 0;
  let unbindCanvasAbort: (() => void) | undefined;
  let assertSource: (() => void) | undefined;
  const state = reactive({ visible: false, loading: false, preparing: false, models: [] as NodeMediaModel[],
    intent: "image:edit-element" as ImageIntentId, model: "", prompt: "", size: "", ratio: "", quality: "", sourceWidth: 0, sourceHeight: 0 });
  const choices = computed(() => imageIntentModels(state.intent, state.models));
  const choice = computed(() => choices.value.find(model => key(model) === state.model));
  const busy = computed(() => state.loading || state.preparing);
  const usable = () => !lifetime.signal.aborted && active?.value !== false && options.hasImage()
    && !options.disabled() && flow.findNode(options.node.id) === options.node;
  function close() { unbindCanvasAbort?.(); unbindCanvasAbort = undefined; state.visible = false; state.loading = false; opening++; operation.abort(); }
  onScopeDispose(() => { lifetime.abort(); close(); });
  watch(() => active?.value, value => { if (value === false) close(); });
  watch(() => options.hasImage() && options.node.selected && active?.value !== false, async selected => {
    if (!selected) return;
    const scope = captureWorkspaceScope();
    try { const models = await options.loadModels(); assertWorkspaceScope(scope); if (usable()) state.models = models; }
    catch { if (!lifetime.signal.aborted) state.models = []; }
  }, { immediate: true });

  function chooseModel() {
    const model = choice.value;
    if (!model) return;
    const sizes = model.imageSizes || [], ratios = model.imageRatios || [];
    if (state.intent === "image:ai-redraw") {
      const output = imageRedrawOutput(model, state.sourceWidth, state.sourceHeight); state.size = output.size; state.ratio = output.ratio;
    } else {
      state.size = sizes.includes(String(options.node.data.size)) ? String(options.node.data.size) : sizes[0] || "";
      state.ratio = ratios.includes(String(options.node.data.ratio)) ? String(options.node.data.ratio) : ratios.includes("auto") ? "auto" : ratios[0] || "";
    }
    state.quality = state.intent === "image:ai-redraw"
      ? model.quality?.includes("high") ? "high" : model.quality?.includes("auto") ? "auto" : ""
      : "";
  }
  async function open(id: string, assertBinding?: () => void) {
    const definition = imageIntent(id);
    if (!definition || busy.value || !usable()) return;
    operation.abort(); operation = new AbortController();
    unbindCanvasAbort?.();
    const canvas = canvasSignal?.();
    const signal = operationSignal = AbortSignal.any([operation.signal, lifetime.signal, ...(canvas ? [canvas] : [])]);
    if (signal.aborted) return;
    canvas?.addEventListener("abort", close, { once: true });
    unbindCanvasAbort = () => canvas?.removeEventListener("abort", close);
    const revision = ++opening, scope = captureWorkspaceScope(), binding = registry?.scope();
    const source = JSON.stringify(options.node.data.outputs?.image);
    assertSource = () => {
      signal.throwIfAborted(); assertWorkspaceScope(scope); assertBinding?.();
      if (!usable() || registry && registry.scope() !== binding || JSON.stringify(options.node.data.outputs?.image) !== source)
        throw new Error(translate("原图片已变化或正在处理，请重新操作"));
    };
    state.intent = definition.id; state.prompt = definition.prompt ? translate(definition.prompt) : "";
    state.visible = true; state.loading = true;
    state.sourceWidth = state.sourceHeight = 0;
    try {
      const models = await options.loadModels();
      if (revision !== opening) return;
      assertSource(); state.models = models;
      if (id === "image:ai-redraw") {
        try {
          const dimensions = await files.getWorkspaceFiles().readImageSize?.(options.node.data.outputs!.image.value.url, operation.signal);
          assertSource();
          if (dimensions && Number.isSafeInteger(dimensions.width) && Number.isSafeInteger(dimensions.height) && dimensions.width > 0 && dimensions.height > 0) {
            state.sourceWidth = dimensions.width; state.sourceHeight = dimensions.height;
          }
        } catch { assertSource(); }
      }
      const selected = choices.value.find(model => key(model) === options.node.data.model) || choices.value[0];
      if (!selected) throw new Error(translate("暂无支持此图片操作的可用模型"));
      state.model = key(selected); chooseModel();
    } catch (error) { if (revision === opening && !operationSignal.aborted) { state.visible = false; options.onError(error); } }
    finally { if (revision === opening) state.loading = false; }
  }
  async function prepare() {
    if (busy.value || !state.prompt.trim()) return;
    state.preparing = true;
    const signal = operationSignal;
    try {
      assertSource?.();
      // Revalidate the exact visible choice; revocation must not switch models.
      state.models = await options.loadModels(); assertSource?.();
      const model = choice.value;
      if (!model || !(model.imageSizes?.includes(state.size) || state.intent === "image:ai-redraw" && model.customSize && fitsCustomSize(model.sizeRule, state.size)) || state.ratio && !model.imageRatios?.includes(state.ratio)
        || state.quality && !model.quality?.includes(state.quality)) throw new Error(translate("暂无支持此图片操作的可用模型"));
      const input = { providerId: model.providerId, modelId: model.modelId, prompt: state.prompt.trim(), size: state.size, ratio: state.ratio };
      if (state.intent === "image:erase-object") {
        // The existing panel owns mask/annotation drawing and its explicit Generate button.
        await options.prepareErase(input, signal);
      } else {
        const definition = imageIntent(state.intent)!;
        const result = await createVariation({ label: translate(definition.label), prompt: input.prompt, model: key(model), size: state.size, ratio: state.ratio,
          ...(state.intent === "image:remove-background" ? { background: "transparent", format: "png" } : {}),
          ...(state.quality ? { quality: state.quality } : {}),
        }, signal, assertSource);
        const created = flow.findNode(result.nodeId);
        if (created) { flow.removeSelectedElements(); flow.addSelectedNodes([created]); await nextTick();
          if (!signal.aborted && flow.findNode(result.nodeId) === created) await flow.fitView({ nodes: [result.nodeId], padding: 0.4, maxZoom: 1, duration: 200 }); }
      }
      state.visible = false;
    } catch (error) { if (!operationSignal.aborted && !lifetime.signal.aborted) options.onError(error); }
    finally { state.preparing = false; }
  }
  const extension: CanvasToolExtension = {
    available: tool => Boolean(imageIntent(tool) && usable() && imageIntentModels(tool, registry?.models.value.length ? registry.models.value : state.models).length),
    ready: tool => Boolean(imageIntent(tool) && usable()),
    run: (tool, context) => open(tool, context.assertCurrent),
  };
  return { state, extension, open, close, prepare, chooseModel,
    get canPrepare() { const model = choice.value; return Boolean(model && state.prompt.trim() && (model.imageSizes?.includes(state.size) || state.intent === "image:ai-redraw" && model.customSize && fitsCustomSize(model.sizeRule, state.size))); },
    get busy() { return busy.value; }, get choice() { return choice.value; }, get choices() { return choices.value; },
    get definition() { return imageIntent(state.intent)!; },
    get tools() { return options.hasImage() ? imageIntents.filter(item => imageIntentModels(item.id, state.models).length) : []; },
  };
}
