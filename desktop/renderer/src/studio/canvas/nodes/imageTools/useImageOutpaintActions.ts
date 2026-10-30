import { computed, inject, nextTick, onScopeDispose, reactive, watch, type Ref } from "vue";
import { useVueFlow, type GraphNode } from "@vue-flow/core";
import { translate } from "@miaoimg/i18n/vue";
import { captureWorkspaceScope, assertWorkspaceScope, subscribeWorkspaceScope } from "@/lib/workspaceRemote";
import { useCanvasToolRegistry } from "../../canvasToolRegistry";
import type { CanvasToolExtension } from "../../useMediaPaletteActions";
import { uploadNodeFile, useNodeFiles, type WorkspaceFiles } from "../../scaffold/workspaceFiles";
import type { NodeMediaModel } from "../../scaffold/nodeAi";
import { assertGeometrySize } from "./imageGeometry";
import { outpaintModel, outpaintGeometry, outpaintSize, assertOutpaintBytes, renderOutpaintFiles, type PreparedOutpaint } from "./imageOutpaintContract";

export function useImageOutpaintActions(options: {
  node: GraphNode; disabled: () => boolean; loadModels: () => Promise<NodeMediaModel[]>; onError: (error: unknown) => void;
}) {
  const flow = useVueFlow(), files = useNodeFiles(), registry = useCanvasToolRegistry();
  const active = inject<Ref<boolean> | undefined>("canvasUiActive", undefined);
  const getCanvasSignal = inject<(() => AbortSignal) | undefined>("canvasOperationSignal", undefined);
  const batch = inject<(action: () => Promise<void>) => Promise<void>>("batchCanvasHistory", action => action());
  const state = reactive({ visible: false, loading: false, saving: false, cancelling: false, models: [] as NodeMediaModel[], model: "",
    prompt: "", width: 0, height: 0, preview: "", left: 25, right: 25, top: 25, bottom: 25, ratio: "free", anchorX: .5, anchorY: .5 });
  let bitmap: ImageBitmap | undefined, operation = new AbortController(), disposed = false, revision = 0;
  let workspace: WorkspaceFiles | undefined, check: (() => void) | undefined, unwatchFile: (() => void) | undefined, unwatchCanvas: (() => void) | undefined;
  const source = () => options.node.data.outputs?.image;
  const key = (model: NodeMediaModel) => JSON.stringify([model.providerId, model.modelId]);
  const usable = () => !disposed && active?.value === true && Boolean(registry?.active() && registry.scope()) && !options.disabled()
    && flow.findNode(options.node.id) === options.node && source()?.dataType === "IMAGE" && Boolean(source()?.value.url);
  const choices = computed(() => state.models.filter(model => Boolean(outpaintModel(model))));
  const choice = computed(() => choices.value.find(model => key(model) === state.model));
  const calculation = computed(() => {
    if (!choice.value || !state.width || !state.height) return {} as { geometry?: ReturnType<typeof outpaintGeometry>; size?: string; error?: string };
    try { const geometry = outpaintGeometry(state.width, state.height, state, choice.value.sizeRule?.multipleOf);
      try { return { geometry, size: outpaintSize(choice.value, geometry) }; }
      catch (error) { return { geometry, error: error instanceof Error ? error.message : translate("扩图画布或蒙版无效，请重新准备") }; } }
    catch (error) { return { error: error instanceof Error ? error.message : translate("扩图画布或蒙版无效，请重新准备") }; }
  });
  function release() { bitmap?.close(); bitmap = undefined; state.preview = ""; }
  function close() { revision++; operation.abort(); unwatchFile?.(); unwatchFile = undefined; unwatchCanvas?.(); unwatchCanvas = undefined; state.visible = state.loading = false; if (!state.saving) release(); }
  function cancel() { if (state.saving) { state.cancelling = true; operation.abort(); } else close(); }
  const stopScope = subscribeWorkspaceScope(close);
  watch(() => registry?.scope(), close, { flush: "sync" });
  watch(() => active?.value, value => { if (value !== true) close(); }, { flush: "sync" });
  watch(() => JSON.stringify(source()), close, { flush: "sync" });
  onScopeDispose(() => { disposed = true; stopScope(); close(); });
  watch(() => Boolean(source()?.value.url) && options.node.selected && active?.value === true, async selected => {
    if (!selected) return;
    try { const models = await options.loadModels(); if (!disposed && active?.value === true) state.models = models; }
    catch { if (!disposed) state.models = []; }
  }, { immediate: true });

  async function open(assertBinding?: () => void) {
    if (state.saving || state.loading || !usable()) return;
    close(); operation = new AbortController(); const controller = operation, current = ++revision;
    const scope = captureWorkspaceScope(), initial = JSON.stringify(source()), canvasSignal = getCanvasSignal?.();
    const abort = () => close(); canvasSignal?.addEventListener("abort", abort, { once: true });
    unwatchCanvas = () => canvasSignal?.removeEventListener("abort", abort);
    check = () => {
      controller.signal.throwIfAborted(); canvasSignal?.throwIfAborted(); assertWorkspaceScope(scope); assertBinding?.();
      if (current !== revision || !usable() || JSON.stringify(source()) !== initial) throw new Error(translate("原图片已变化或正在处理，请重新操作"));
    };
    state.visible = state.loading = true;
    state.left = state.right = state.top = state.bottom = 25; state.ratio = "free"; state.anchorX = state.anchorY = .5;
    state.prompt = translate("自然延展画面的环境、光线与纹理，衔接原图边缘，尽可能保留原图内容，不添加无关主体。");
    try {
      workspace = files.getWorkspaceFiles(); const image = source()!.value;
      const metadata = await workspace.stat?.(image.url, controller.signal); check();
      if (!metadata || metadata.size <= 0 || metadata.size > 200 * 1024 * 1024) throw new Error(translate("无法读取有效原图片"));
      unwatchFile = workspace.watchUrl?.(image.url, close);
      const dimensions = await workspace.readImageSize?.(image.url, controller.signal); check();
      if (!dimensions) throw new Error(translate("无法读取原图片尺寸"));
      assertGeometrySize(dimensions.width, dimensions.height);
      const raw = await workspace.read(image.url, controller.signal); check();
      const latest = await workspace.stat?.(image.url, controller.signal); check();
      if (latest?.revision !== metadata.revision) throw new Error(translate("原图片已变化或正在处理，请重新操作"));
      const decoded = await createImageBitmap(raw instanceof Blob ? raw : new Blob([raw], { type: image.mimeType }), { imageOrientation: "from-image" });
      try { check(); assertGeometrySize(decoded.width, decoded.height); } catch (error) { decoded.close(); throw error; }
      bitmap = decoded; state.width = decoded.width; state.height = decoded.height;
      const preview = document.createElement("canvas");
      try { const scale = Math.min(1, 900 / Math.max(decoded.width, decoded.height)); preview.width = Math.round(decoded.width * scale); preview.height = Math.round(decoded.height * scale);
        preview.getContext("2d")!.drawImage(decoded, 0, 0, preview.width, preview.height); state.preview = preview.toDataURL("image/png"); }
      finally { preview.width = preview.height = 0; }
      await registry?.refresh(); check(); state.models = await options.loadModels(); check();
      const selected = choices.value.find(model => key(model) === options.node.data.model) || choices.value[0];
      if (!selected) throw new Error(translate("暂无支持蒙版扩图的可用模型"));
      state.model = key(selected);
    } catch (error) { if (current === revision && !controller.signal.aborted) { close(); options.onError(error); } }
    finally { if (current === revision) state.loading = false; }
  }

  async function prepare() {
    if (state.loading || state.saving || !bitmap || !workspace || !calculation.value.geometry || calculation.value.error || state.prompt.trim().length < 2 || state.prompt.length > 10_000) return;
    state.saving = true; state.cancelling = false;
    const signal = operation.signal, original = bitmap, boundFiles = workspace, nodeId = crypto.randomUUID();
    let uploadStarted = false, committed = false;
    try {
      check?.();
      if (!flow.nodeTypes.value?.["remote-imageNode"]) throw new Error(translate("请先启用图片节点插件"));
      await registry?.refresh(); check?.(); state.models = await options.loadModels(); check?.();
      const model = choice.value, geometry = calculation.value.geometry;
      if (!model || !geometry) throw new Error(translate("暂无支持蒙版扩图的可用模型"));
      const size = outpaintSize(model, geometry);
      const encoded = await renderOutpaintFiles(original, geometry, signal); check?.();
      assertOutpaintBytes(model, encoded.image.size, encoded.mask.size);
      uploadStarted = true;
      const imagePath = await uploadNodeFile(boundFiles, nodeId, encoded.image, undefined, signal); check?.();
      const maskPath = await uploadNodeFile(boundFiles, nodeId, encoded.mask, undefined, signal); check?.();
      const imageMeta = await boundFiles.stat?.(imagePath, signal), maskMeta = await boundFiles.stat?.(maskPath, signal); check?.();
      if (!imageMeta?.revision || !maskMeta?.revision) throw new Error(translate("扩图画布或蒙版无效，请重新准备"));
      const prepared: PreparedOutpaint = { version: 1, imagePath, maskPath, sourcePath: source()!.value.url,
        imageRevision: imageMeta.revision, maskRevision: maskMeta.revision, geometry: { ...geometry },
        imageBytes: encoded.image.size, maskBytes: encoded.mask.size,
        config: { providerId: model.providerId, modelId: model.modelId, prompt: state.prompt.trim(), size, ratio: model.imageRatios?.includes("auto") ? "auto" : "" } };
      await batch(async () => {
        check?.(); if (flow.findNode(nodeId)) throw new Error(translate("目标节点已存在，请重新操作"));
        const width = Math.max(240, Math.min(640, geometry.width / geometry.height * 360)), height = 410;
        const x = options.node.computedPosition.x + Math.max(options.node.dimensions.width || 0, options.node.data.mediaExportSize?.width || 362) + 80;
        let y = options.node.computedPosition.y;
        for (const other of [...flow.getNodes.value].sort((a, b) => a.computedPosition.y - b.computedPosition.y)) {
          const pos = other.computedPosition, box = other.data.mediaExportSize || other.data.directorExportSize;
          if (pos.x < x + width && pos.x + Math.max(other.dimensions.width || 0, box?.width || 320) > x && pos.y < y + height && pos.y + Math.max(other.dimensions.height || 0, box?.height || 410) > y)
            y = pos.y + Math.max(other.dimensions.height || 0, box?.height || 410) + 40;
        }
        flow.addNodes({ id: nodeId, type: "remote-imageNode", position: { x, y }, data: {
          label: `${options.node.data.label || translate("图片")} · ${translate("扩图")}`, preparedOutpaint: prepared,
          mediaExportSize: { width, height }, outputs: { image: { dataType: "IMAGE", value: { url: imagePath, mimeType: "image/png" } } },
        } }); committed = true;
      });
      state.visible = false; unwatchFile?.(); unwatchFile = undefined; unwatchCanvas?.(); unwatchCanvas = undefined;
      const created = flow.findNode(nodeId);
      if (created) { flow.removeSelectedElements(); flow.addSelectedNodes([created]); await nextTick();
        if (!signal.aborted && flow.findNode(nodeId) === created) await flow.fitView({ nodes: [nodeId], padding: .4, maxZoom: 1, duration: 200 }); }
    } catch (error) { if (!signal.aborted) options.onError(error); }
    finally {
      if (!committed && uploadStarted) await boundFiles.remove(`assets/${nodeId}`, true).catch(() => {});
      state.saving = state.cancelling = false; if (signal.aborted) state.visible = false; if (!state.visible || signal.aborted) release();
    }
  }
  const extension: CanvasToolExtension = {
    available: tool => tool === "image:outpaint" && usable() && (registry?.models.value.length ? registry.models.value : state.models).some(model => Boolean(outpaintModel(model))),
    ready: tool => tool === "image:outpaint" && usable(), run: (_tool, context) => open(context.assertCurrent),
  };
  return { state, extension, open, close, cancel, prepare, get choice() { return choice.value; }, get choices() { return choices.value; },
    get calculation() { return calculation.value; }, get available() { return extension.available("image:outpaint"); },
    get busy() { return state.loading || state.saving; } };
}
