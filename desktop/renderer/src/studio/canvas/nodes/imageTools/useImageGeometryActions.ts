import { computed, inject, nextTick, onScopeDispose, reactive, watch, type Ref } from "vue";
import { useVueFlow, type GraphNode } from "@vue-flow/core";
import { translate } from "@miaoimg/i18n/vue";
import { assertWorkspaceScope, captureWorkspaceScope, subscribeWorkspaceScope } from "@/lib/workspaceRemote";
import { uploadNodeFile, useNodeFiles, type WorkspaceFiles } from "../../scaffold/workspaceFiles";
import { useCanvasToolRegistry } from "../../canvasToolRegistry";
import type { CanvasToolExtension } from "../../useMediaPaletteActions";
import { nodeTools, z } from "@miaoimg/nodes-scaffold/runtime";
import { imageGeometryActions, isImageGeometry, type ImageGeometryId } from "./imageGeometryCatalogue";
import { assertGeometrySize, fitCrop, geometryPng, renderImageGeometry, validPixelRect, type ImageGeometry, type PixelRect } from "./imageGeometry";

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
  async function publishGeometry(original: ImageBitmap, input: ImageGeometry, label: string, operationSignal: AbortSignal, boundFiles: WorkspaceFiles, check: () => void) {
    check();
    if (!flow.nodeTypes.value?.["remote-imageNode"]) throw new Error(translate("请先启用图片节点插件"));
    const nodeId = crypto.randomUUID();
    let uploadStarted = false, committed = false;
    try {
      const png = await geometryPng(original, input); check();
      uploadStarted = true;
      const path = await uploadNodeFile(boundFiles, nodeId, new File([png], "edited.png", { type: "image/png" }), undefined, operationSignal); check();
      const width = input.turns % 2 ? input.crop.height : input.crop.width, height = input.turns % 2 ? input.crop.width : input.crop.height;
      await batch(async () => {
        check();
        if (flow.findNode(nodeId)) throw new Error(translate("目标节点已存在，请重新操作"));
        const outputWidth = width / height * 360 + 2, outputHeight = 410;
        const x = options.node.computedPosition.x + Math.max(options.node.dimensions.width || 0, options.node.data.mediaExportSize?.width || original.width / original.height * 360 + 2) + 80;
        let y = options.node.computedPosition.y;
        for (const other of [...flow.getNodes.value].sort((a, b) => a.computedPosition.y - b.computedPosition.y)) {
          const pos = other.computedPosition, box = other.data.mediaExportSize || other.data.directorExportSize;
          const w = Math.max(other.dimensions.width || 0, box?.width || 320), h = Math.max(other.dimensions.height || 0, box?.height || 410);
          if (pos.x < x + outputWidth && pos.x + w > x && pos.y < y + outputHeight && pos.y + h > y) y = pos.y + h + 40;
        }
        flow.addNodes({ id: nodeId, type: "remote-imageNode", position: { x, y }, data: {
          label: `${options.node.data.label || translate("图片")} · ${label}`,
          mediaExportSize: { width: outputWidth, height: outputHeight }, outputs: { image: { dataType: "IMAGE", value: { url: path, mimeType: "image/png" } } },
        } });
        committed = true;
      });
      return nodeId;
    } catch (error) {
      if (!committed && uploadStarted) await boundFiles.remove(`assets/${nodeId}`, true).catch(() => {});
      throw error;
    }
  }
  async function save() {
    if (!valid.value || state.loading || state.saving || !bitmap || !workspace) return;
    state.saving = true; const operationSignal = operation.signal, original = bitmap, boundFiles = workspace;
    let committed = false;
    try {
      const nodeId = await publishGeometry(original, settings(), translate(imageGeometryActions.find(item => item.id === state.intent)!.label), operationSignal, boundFiles, () => { assertCurrent?.(); });
      committed = true;
      unbindCanvasAbort?.(); unbindCanvasAbort = undefined; unwatchFile?.(); unwatchFile = undefined;
      const created = flow.findNode(nodeId);
      if (created) { flow.removeSelectedElements(); flow.addSelectedNodes([created]); await nextTick();
        if (!operationSignal.aborted && flow.findNode(nodeId) === created) await flow.fitView({ nodes: [nodeId], padding: 0.4, maxZoom: 1, duration: 200 }); }
    } catch (error) { if (!operationSignal.aborted) options.onError(error); }
    finally {
      if (committed) state.visible = false;
      state.saving = false; if (!state.visible || operationSignal.aborted) release();
    }
  }
  async function loadOrientedBitmap(operationSignal: AbortSignal, check: () => void) {
    const workspace = files.getWorkspaceFiles();
    const image = source()!.value;
    const metadata = await workspace.stat?.(image.url, operationSignal); check();
    if (!metadata || metadata.size <= 0 || metadata.size > 200 * 1024 * 1024) throw new Error(translate("无法读取有效原图片"));
    const dimensions = await workspace.readImageSize?.(image.url, operationSignal); check();
    if (!dimensions) throw new Error(translate("无法读取原图片尺寸"));
    assertGeometrySize(dimensions.width, dimensions.height);
    const raw = await workspace.read(image.url, operationSignal); check();
    const currentMetadata = await workspace.stat?.(image.url, operationSignal); check();
    if (currentMetadata?.revision !== metadata.revision) throw new Error(translate("原图片已变化或正在处理，请重新操作"));
    const blob = raw instanceof Blob ? raw : new Blob([raw], { type: image.mimeType });
    const decoded = await createImageBitmap(blob, { imageOrientation: "from-image" });
    try { check(); assertGeometrySize(decoded.width, decoded.height); }
    catch (error) { decoded.close(); throw error; }
    return { decoded, workspace };
  }
  async function applyHeadless(args: { crop?: PixelRect; turns?: 0 | 1 | 2 | 3; flipX?: boolean; flipY?: boolean }, signal?: AbortSignal) {
    if (state.visible || state.loading || state.saving) throw new Error(translate("图片处理中，请稍后重试"));
    if (!usable()) throw new Error(translate("原图片已变化或正在处理，请重新操作"));
    state.saving = true;
    const canvas = canvasSignal?.();
    const linked = [signal, canvas].filter((item): item is AbortSignal => Boolean(item));
    const operationSignal = linked.length ? AbortSignal.any(linked) : new AbortController().signal;
    const scope = captureWorkspaceScope(), initial = JSON.stringify(source()), binding = registry?.scope();
    const check = () => {
      operationSignal.throwIfAborted(); assertWorkspaceScope(scope);
      if (!usable() || JSON.stringify(source()) !== initial || registry && registry.scope() !== binding) throw new Error(translate("原图片已变化或正在处理，请重新操作"));
    };
    let decoded: ImageBitmap | undefined;
    try {
      const loaded = await loadOrientedBitmap(operationSignal, check);
      decoded = loaded.decoded;
      const crop = args.crop ?? fitCrop(decoded.width, decoded.height, 0);
      if (!validPixelRect(crop, decoded.width, decoded.height)) throw new Error(translate("请设置有效裁剪范围"));
      const input: ImageGeometry = { crop, turns: args.turns ?? 0, flipX: Boolean(args.flipX), flipY: Boolean(args.flipY) };
      const label = translate(input.flipX || input.flipY ? "镜像图片" : input.turns ? "旋转图片" : "裁剪图片");
      const nodeId = await publishGeometry(decoded, input, label, operationSignal, loaded.workspace, check);
      const created = flow.findNode(nodeId);
      if (created) { flow.removeSelectedElements(); flow.addSelectedNodes([created]); await nextTick();
        if (!operationSignal.aborted && flow.findNode(nodeId) === created) await flow.fitView({ nodes: [nodeId], padding: 0.4, maxZoom: 1, duration: 200 }).catch(() => {}); }
      return { nodeId, prepared: true, generationStarted: false };
    } finally { decoded?.close(); state.saving = false; }
  }
  nodeTools.register({
    name: "applyImageGeometry",
    description: "按像素裁剪、顺时针旋转或镜像，把结果存成新的 PNG 图片节点。不打开对话框，不调用生成模型。crop 是定向后原图上的整数像素矩形，省略表示整幅；turns 为 0–3，每档 90 度。只处理本地图片，最长边 8192、最多 3600 万像素。返回 nodeId。",
    parameters: z.strictObject({
      crop: z.strictObject({ x: z.number().int().nonnegative(), y: z.number().int().nonnegative(), width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
      turns: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
      flipX: z.boolean().optional(),
      flipY: z.boolean().optional(),
    }),
    async execute(args, { signal }) { signal?.throwIfAborted(); return applyHeadless(args, signal); },
  });
  const extension: CanvasToolExtension = { available: tool => isImageGeometry(tool) && usable(), ready: tool => isImageGeometry(tool) && usable(), run: (tool, context) => open(tool, context.assertCurrent) };
  return { state, extension, open, close, save, chooseRatio, get valid() { return valid.value; }, get busy() { return state.loading || state.saving; } };
}
