import { computed, inject, nextTick, onScopeDispose, reactive, watch, type Ref } from "vue";
import { useVueFlow, type GraphNode } from "@vue-flow/core";
import { translate } from "@miaoimg/i18n/vue";
import { assertWorkspaceScope, captureWorkspaceScope, subscribeWorkspaceScope } from "@/lib/workspaceRemote";
import { uploadNodeFile, useNodeFiles, type WorkspaceFiles } from "../../scaffold/workspaceFiles";
import { useCanvasToolRegistry } from "../../canvasToolRegistry";
import type { CanvasToolExtension } from "../../useMediaPaletteActions";
import { imageGeometryActions, isImageGeometry, type ImageGeometryId } from "./imageGeometryCatalogue";
import { assertGeometrySize, fitCrop, geometryPng, renderImageGeometry, validPixelRect, type ImageGeometry } from "./imageGeometry";

export function useImageGeometryActions(options: { node: GraphNode; disabled: () => boolean; onError: (error: unknown) => void }) {
  const flow = useVueFlow(), files = useNodeFiles(), registry = useCanvasToolRegistry();
  const active = inject<Ref<boolean> | undefined>("canvasUiActive", undefined);
  const canvasSignal = inject<(() => AbortSignal) | undefined>("canvasOperationSignal", undefined);
  const batch = inject<(action: () => Promise<void>) => Promise<void>>("batchCanvasHistory", action => action());
  const state = reactive({ visible: false, loading: false, saving: false, intent: "image:crop" as ImageGeometryId,
    width: 0, height: 0, preview: "", ratio: "free", crop: { x: 0, y: 0, width: 1, height: 1 }, turns: 0 as 0 | 1 | 2 | 3, flipX: false, flipY: false });
  let operation = new AbortController(), bitmap: ImageBitmap | undefined, disposed = false, revision = 0;
  let unwatchFile: (() => void) | undefined, unbindCanvasAbort: (() => void) | undefined;
  let workspace: WorkspaceFiles | undefined, assertCurrent: (() => void) | undefined;
  const source = () => options.node.data.outputs?.image;
  const usable = () => !disposed && active?.value !== false && !options.disabled() && flow.findNode(options.node.id) === options.node && source()?.dataType === "IMAGE" && Boolean(source()?.value.url);
  function release() { bitmap?.close(); bitmap = undefined; state.preview = ""; }
  function close() { unbindCanvasAbort?.(); unbindCanvasAbort = undefined; unwatchFile?.(); unwatchFile = undefined; revision++; operation.abort(); state.visible = false; state.loading = false; if (!state.saving) release(); }
  const stopScope = subscribeWorkspaceScope(close);
  // Synchronous invalidation also rejects A -> empty -> B -> A changes.
  watch(() => JSON.stringify(source()), close, { flush: "sync" });
  watch(() => active?.value, value => { if (value === false) close(); }, { flush: "sync" });
  watch(() => registry?.scope(), close, { flush: "sync" });
  onScopeDispose(() => { disposed = true; stopScope(); close(); });
  const settings = (): ImageGeometry => ({ crop: { ...state.crop }, turns: state.turns, flipX: state.flipX, flipY: state.flipY });
  const valid = computed(() => state.visible && !state.loading && validPixelRect(state.crop, state.width, state.height) && Boolean(bitmap));
  function refreshPreview() {
    if (!bitmap || !validPixelRect(state.crop, state.width, state.height)) return;
    const input = state.intent === "image:crop" ? { crop: fitCrop(state.width, state.height, 0), turns: 0 as const, flipX: false, flipY: false } : settings();
    const canvas = renderImageGeometry(bitmap, input, 1024);
    try { state.preview = canvas.toDataURL("image/png"); } finally { canvas.width = canvas.height = 0; }
  }
  watch(() => [state.turns, state.flipX, state.flipY], refreshPreview);
  function chooseRatio() {
    const [w, h] = state.ratio.split(":").map(Number);
    state.crop = fitCrop(state.width, state.height, w > 0 && h > 0 ? w / h : 0);
  }
  async function open(intent: string, assertBinding?: () => void) {
    if (!isImageGeometry(intent) || state.saving || state.loading || !usable()) return;
    close(); operation = new AbortController(); const controller = operation, current = ++revision;
    const signal = canvasSignal?.();
    if (signal?.aborted) return;
    signal?.addEventListener("abort", close, { once: true });
    unbindCanvasAbort = () => signal?.removeEventListener("abort", close);
    const scope = captureWorkspaceScope(), initial = JSON.stringify(source()), binding = registry?.scope();
    const check = () => { controller.signal.throwIfAborted(); signal?.throwIfAborted(); assertWorkspaceScope(scope); assertBinding?.();
      if (current !== revision || !usable() || JSON.stringify(source()) !== initial || registry && registry.scope() !== binding)
        throw new Error(translate("原图片已变化或正在处理，请重新操作")); };
    assertCurrent = check;
    state.intent = intent; state.visible = true; state.loading = true; state.ratio = "free"; state.turns = intent === "image:rotate" ? 1 : 0; state.flipX = intent === "image:mirror"; state.flipY = false;
    try {
      workspace = files.getWorkspaceFiles();
      const image = source()!.value;
      const metadata = await workspace.stat?.(image.url, controller.signal); check();
      if (!metadata || metadata.size <= 0 || metadata.size > 200 * 1024 * 1024) throw new Error(translate("无法读取有效原图片"));
      // stat establishes the first cached revision; only later changes retire this edit.
      unwatchFile = workspace.watchUrl?.(image.url, close);
      const dimensions = await workspace.readImageSize?.(image.url, controller.signal); check();
      if (!dimensions) throw new Error(translate("无法读取原图片尺寸"));
      assertGeometrySize(dimensions.width, dimensions.height);
      const raw = await workspace.read(image.url, controller.signal); check();
      const currentMetadata = await workspace.stat?.(image.url, controller.signal); check();
      if (currentMetadata?.revision !== metadata.revision) throw new Error(translate("原图片已变化或正在处理，请重新操作"));
      const blob = raw instanceof Blob ? raw : new Blob([raw], { type: image.mimeType });
      // Chromium applies EXIF once while decoding; all coordinates use the
      // oriented bitmap. Drawing keeps alpha, output is a newly encoded PNG.
      const decoded = await createImageBitmap(blob, { imageOrientation: "from-image" });
      try { check(); assertGeometrySize(decoded.width, decoded.height); }
      catch (error) { decoded.close(); throw error; }
      bitmap = decoded; state.width = decoded.width; state.height = decoded.height;
      state.crop = fitCrop(decoded.width, decoded.height, 0); refreshPreview();
    } catch (error) { if (current === revision && !operation.signal.aborted) { close(); options.onError(error); } }
    finally { if (current === revision) state.loading = false; }
  }
  async function save() {
    if (!valid.value || state.loading || state.saving || !bitmap || !workspace) return;
    state.saving = true; const operationSignal = operation.signal, original = bitmap, boundFiles = workspace;
    const nodeId = crypto.randomUUID(); let path = "", committed = false, uploadStarted = false;
    try {
      assertCurrent?.();
      if (!flow.nodeTypes.value?.["remote-imageNode"]) throw new Error(translate("请先启用图片节点插件"));
      const input = settings(), png = await geometryPng(original, input); assertCurrent?.();
      uploadStarted = true;
      path = await uploadNodeFile(boundFiles, nodeId, new File([png], "edited.png", { type: "image/png" }), undefined, operationSignal); assertCurrent?.();
      const width = input.turns % 2 ? input.crop.height : input.crop.width, height = input.turns % 2 ? input.crop.width : input.crop.height;
      await batch(async () => {
        assertCurrent?.();
        if (flow.findNode(nodeId)) throw new Error(translate("目标节点已存在，请重新操作"));
        const outputWidth = width / height * 360 + 2, outputHeight = 410;
        const x = options.node.computedPosition.x + Math.max(options.node.dimensions.width || 0, options.node.data.mediaExportSize?.width || state.width / state.height * 360 + 2) + 80;
        let y = options.node.computedPosition.y;
        for (const other of [...flow.getNodes.value].sort((a, b) => a.computedPosition.y - b.computedPosition.y)) {
          const pos = other.computedPosition, box = other.data.mediaExportSize || other.data.directorExportSize;
          const w = Math.max(other.dimensions.width || 0, box?.width || 320), h = Math.max(other.dimensions.height || 0, box?.height || 410);
          if (pos.x < x + outputWidth && pos.x + w > x && pos.y < y + outputHeight && pos.y + h > y) y = pos.y + h + 40;
        }
        flow.addNodes({ id: nodeId, type: "remote-imageNode", position: { x, y }, data: {
          label: `${options.node.data.label || translate("图片")} · ${translate(imageGeometryActions.find(item => item.id === state.intent)!.label)}`,
          mediaExportSize: { width: outputWidth, height: outputHeight }, outputs: { image: { dataType: "IMAGE", value: { url: path, mimeType: "image/png" } } },
        } });
        committed = true;
      });
      unbindCanvasAbort?.(); unbindCanvasAbort = undefined; unwatchFile?.(); unwatchFile = undefined;
      const created = flow.findNode(nodeId);
      if (created) { flow.removeSelectedElements(); flow.addSelectedNodes([created]); await nextTick();
        if (!operationSignal.aborted && flow.findNode(nodeId) === created) await flow.fitView({ nodes: [nodeId], padding: 0.4, maxZoom: 1, duration: 200 }); }
    } catch (error) { if (!operationSignal.aborted) options.onError(error); }
    finally {
      // The bound workspace refuses cleanup in a different account/project.
      // Never remove a path through a newly selected workspace.
      if (!committed && uploadStarted) await boundFiles.remove(`assets/${nodeId}`, true).catch(() => {});
      if (committed) state.visible = false;
      state.saving = false; if (!state.visible || operationSignal.aborted) release();
    }
  }
  const extension: CanvasToolExtension = { available: tool => isImageGeometry(tool) && usable(), ready: tool => isImageGeometry(tool) && usable(), run: (tool, context) => open(tool, context.assertCurrent) };
  return { state, extension, open, close, save, chooseRatio, get valid() { return valid.value; }, get busy() { return state.loading || state.saving; } };
}
