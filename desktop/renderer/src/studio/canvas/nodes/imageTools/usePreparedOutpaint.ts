import { computed, watch, type Ref } from "vue";
import type { GraphNode } from "@vue-flow/core";
import { translate } from "@miaoimg/i18n/vue";
import { isInternalAssetPath, isWorkspacePath, isProtectedWorkspacePath } from "../../../../../../../server/workspace-path";
import type { NodeImageRequest, NodeInpaintInput, NodeMediaModel } from "../../scaffold/nodeAi";
import type { NodeOutputs } from "../../scaffold/values";
import type { WorkspaceFiles } from "../../scaffold/workspaceFiles";
import { useCanvasToolRegistry } from "../../canvasToolRegistry";
import { subscribeWorkspaceScope } from "@/lib/workspaceRemote";
import { assertOutpaintGeometry, assertPreparedPng, assertOutpaintBytes, outpaintSize, type PreparedOutpaint } from "./imageOutpaintContract";

function validManifest(value: unknown): value is PreparedOutpaint {
  if (!value || typeof value !== "object") return false;
  const item = value as PreparedOutpaint;
  return item.version === 1 && isInternalAssetPath(item.imagePath) && isInternalAssetPath(item.maskPath)
    && isWorkspacePath(item.sourcePath) && !isProtectedWorkspacePath(item.sourcePath) && Boolean(item.config && item.geometry);
}
function dataUrl(blob: Blob, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader(), abort = () => { reader.abort(); reject(signal.reason); };
    reader.onload = () => { signal.removeEventListener("abort", abort); signal.aborted ? reject(signal.reason) : resolve(String(reader.result)); };
    reader.onerror = () => { signal.removeEventListener("abort", abort); reject(new Error(translate("扩图画布或蒙版无效，请重新准备"))); };
    signal.addEventListener("abort", abort, { once: true }); reader.readAsDataURL(blob);
  });
}

export function usePreparedOutpaint(options: {
  node: GraphNode; outputs: Ref<NodeOutputs>; files: { getWorkspaceFiles: () => WorkspaceFiles };
  loadModels: () => Promise<NodeMediaModel[]>;
}) {
  const registry = useCanvasToolRegistry();
  const manifest = computed(() => validManifest(options.node.data.preparedOutpaint) ? options.node.data.preparedOutpaint : undefined);
  const active = computed(() => Boolean(manifest.value && options.outputs.value.image?.dataType === "IMAGE"
    && options.outputs.value.image.value.url === manifest.value.imagePath));
  const initialConfig = computed(() => manifest.value?.config);
  const fixedSize = computed(() => manifest.value ? `${manifest.value.geometry.width}x${manifest.value.geometry.height}` : "");
  function allows(model: NodeMediaModel) {
    const data = manifest.value; if (!data) return false;
    try { outpaintSize(model, data.geometry); assertOutpaintBytes(model, data.imageBytes, data.maskBytes); return true; }
    catch { return false; }
  }
  function updateConfig(input: NodeInpaintInput) {
    if (!active.value || !manifest.value) return;
    manifest.value.config = { ...input, size: fixedSize.value, ratio: "" };
  }
  async function prepare(input: NodeInpaintInput, signal: AbortSignal): Promise<NodeImageRequest> {
    signal.throwIfAborted();
    const data = manifest.value, binding = registry?.scope(), version = registry?.bindingVersion();
    if (!active.value || !data || !registry?.active() || !binding) throw new Error(translate("扩图画布或蒙版无效，请重新准备"));
    let invalidated = false;
    const stopScope = subscribeWorkspaceScope(() => { invalidated = true; });
    const stopActive = watch(() => registry.active(), value => { if (!value) invalidated = true; }, { flush: "sync" });
    try {
    const check = () => {
      signal.throwIfAborted();
      if (invalidated || !active.value || manifest.value !== data || registry.scope() !== binding || registry.bindingVersion() !== version || !registry.active()) throw new Error(translate("原节点已变化，请重新操作"));
    };
    assertOutpaintGeometry(data.geometry);
    const workspace = options.files.getWorkspaceFiles();
    await registry.refresh(); check();
    const models = await options.loadModels(); check();
    const model = models.find(item => item.providerId === input.providerId && item.modelId === input.modelId);
    if (!model || !allows(model) || input.size !== fixedSize.value || input.prompt.trim().length < 2 || input.prompt.length > 10_000) throw new Error(translate("暂无支持蒙版扩图的可用模型"));
    const image = await workspace.stat?.(data.imagePath, signal), mask = await workspace.stat?.(data.maskPath, signal); check();
    if (!image || !mask || image.mime !== "image/png" || mask.mime !== "image/png" || image.revision !== data.imageRevision || mask.revision !== data.maskRevision)
      throw new Error(translate("扩图画布或蒙版已变化，请重新准备"));
    assertOutpaintBytes(model, image.size, mask.size);
    const content = await workspace.read(data.maskPath, signal); check();
    const blob = new Blob([content], { type: "image/png" });
    assertPreparedPng(new Uint8Array(await blob.arrayBuffer()), data.geometry, true); check();
    const dimensions = await workspace.readImageSize?.(data.imagePath, signal); check();
    if (dimensions?.width !== data.geometry.width || dimensions.height !== data.geometry.height) throw new Error(translate("扩图画布或蒙版已变化，请重新准备"));
    const latestImage = await workspace.stat?.(data.imagePath, signal), latestMask = await workspace.stat?.(data.maskPath, signal); check();
    if (latestImage?.revision !== image.revision || latestMask?.revision !== mask.revision) throw new Error(translate("扩图画布或蒙版已变化，请重新准备"));
    const { directory } = await workspace.list(); check();
    const encodedMask = await dataUrl(blob, signal); check();
    return { ...input, prompt: input.prompt.trim(), size: fixedSize.value, ratio: "", directory, count: 1, format: "png", background: "opaque",
      outputDirectory: `assets/${options.node.id}`, images: [{ path: data.imagePath, mimeType: "image/png" }], edit: { mask: encodedMask } };
    } finally { stopScope(); stopActive(); }
  }
  return { get active() { return active.value; }, get initialConfig() { return initialConfig.value; }, get fixedSize() { return fixedSize.value; }, allows, prepare, updateConfig };
}
