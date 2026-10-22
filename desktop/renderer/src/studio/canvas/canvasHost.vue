<template>
  <div class="canvasHost">
    <canvasPanel
      v-for="entry in entries"
      :key="entry.key"
      :ref="value => setInstance(entry.key, value)"
      class="canvasRuntime"
      :class="{ backgroundCanvas: entry.key !== activeKey }"
      :aria-hidden="entry.key !== activeKey"
      :inert="entry.key !== activeKey"
      :runtimeKey="entry.key"
      :initialCanvasId="entry.fileName"
      :active="active && entry.key === activeKey"
      :settingsVisible="settingsVisible"
      :workspaceSignal="lifetime.signal"
      :activateCanvas="activateCanvas"
      :resolveCanvasContext="resolveCanvasContext"
      :flushCanvases="flushSave" />
  </div>
</template>

<script setup lang="ts">
import { computed, onScopeDispose, provide, shallowReactive, shallowRef, ref, watch, type ComponentPublicInstance } from "vue";
import type { CanvasContext } from "@miaoimg/tool-canvas/runtime";
import type { NodeDocumentState } from "@miaoimg/nodes-scaffold/nodeDocument";
import { waitForControlValue } from "@/lib/mcpControl";
import canvasPanel from "./index.vue";
import { useWorkspaceContentFiles as useWorkspaceFiles } from "@/lib/workspaceFiles";
import { useWorkspaceStore } from "@/stores/workspace";
import { createCanvasMention, mentionNodeOutputs, queryMentionNodes, type MentionCanvasSource } from "./mentionSources";
import { translate } from "@miaoimg/i18n/vue";
import { remapWorkspacePath, type WorkspaceFileMutator } from "@/pages/workspace/canvasFiles";
import { getRetainedCanvasPaths, isCanvasFile, assertCanvasFilePath } from "@/pages/workspace/canvasFile";
import { assertOrganizableAssetPath } from "./saveCanvasAsset";
import { canvasFileReferences } from '../../../../../server/canvas-file-references';
import { DEFAULT_PROJECT, workspaceOwner, workspaceProject } from '@/lib/workspaceRemote';
import { captureWorkspaceSourceEntries, type WorkspaceSourceEntry } from '@/lib/workspaceFileSelection';

const props = withDefaults(defineProps<{ active?: boolean; settingsVisible?: boolean }>(), { active: true, settingsVisible: false });
type CanvasInstance = InstanceType<typeof canvasPanel>;
const entries = shallowRef<{ key: string; fileName?: string }[]>([{ key: crypto.randomUUID() }]);
const activeKey = ref(entries.value[0]!.key);
const instances = shallowReactive(new Map<string, CanvasInstance>());
const activeInstance = computed(() => instances.get(activeKey.value));
const canvasId = computed(() => activeInstance.value?.canvasId ?? "");
const canvasReady = computed(() => activeInstance.value?.canvasReady ?? false);
const lifetime = new AbortController();
const workspaceStore = useWorkspaceStore();
const referenceScope = () => ({ owner: workspaceOwner(workspaceStore.project?.directory || ''), project: workspaceProject(), defaultProject: DEFAULT_PROJECT, origin: window.location.origin });
// 只由前台宿主记住当前画布；已缓存实例再次激活时其 canvasId 不变，不能靠实例初始化记录。
watch([canvasId, () => workspaceStore.project?.directory], ([id, directory]) => {
  if (!id || !directory) return;
  try { localStorage.setItem(`miaoimg.canvas.active.${directory}`, id); } catch { /* 隐私模式下仍可切换 */ }
}, { flush: "post" });
const canvases = shallowRef<{ id: string; name: string }[]>([]);
provide("canvasList", canvases);
provide("canvasAssetNodes", (id: string) => [...instances.values()].find(panel => panel.canvasId === id)?.getRetainedNodes() ?? []);
watch(canvases, (current, previous) => {
  const currentIds = new Set(current.map(canvas => canvas.id));
  const removed = new Set(previous.filter(canvas => !currentIds.has(canvas.id)).map(canvas => canvas.id));
  if (!removed.size) return;
  entries.value = entries.value.filter(entry => {
    const panel = instances.get(entry.key);
    if (!removed.has(panel?.canvasId || entry.fileName || "")) return true;
    // 卸载会刷新待保存内容，删除文件后必须先取消，避免重新创建 JSON。
    panel?.cancelSave();
    return false;
  });
  if (!entries.value.some(entry => entry.key === activeKey.value)) activeKey.value = entries.value[0]?.key ?? "";
  if (!entries.value.length && current[0]) {
    const entry = { key: crypto.randomUUID(), fileName: current[0].id };
    entries.value = [entry];
    activeKey.value = entry.key;
  }
}, { flush: "sync" });
onScopeDispose(() => lifetime.abort(new Error(translate("工作区已关闭"))));

function setInstance(key: string, value: Element | ComponentPublicInstance | null) {
  if (value) instances.set(key, value as CanvasInstance);
  else instances.delete(key);
}

async function ensureCanvas(fileName: string, signal?: AbortSignal, activate = false) {
  const callSignal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(120000), ...(signal ? [signal] : [])]);
  callSignal.throwIfAborted();
  const previousKey = activeKey.value;
  let entry = entries.value.find(item => instances.get(item.key)?.canvasId === fileName || (!instances.get(item.key)?.canvasId && item.fileName === fileName));
  if (!entry) {
    // ACT: 已打开的画布保留至退出工作区，避免卸载后台节点任务；大量画布时可按任务引用回收空闲实例。
    entry = { key: crypto.randomUUID(), fileName };
    entries.value = [...entries.value, entry];
  }
  if (activate) activeKey.value = entry.key;
  const key = entry.key;
  try {
    const ready = instances.get(key);
    if (ready?.canvasReady) return ready;
    const panel = await waitForControlValue(() => {
      const instance = instances.get(key);
      return instance?.canvasReady || instance?.loadError ? instance : undefined;
    }, callSignal);
    if (panel.loadError) throw new Error(panel.loadError);
    return panel;
  } catch (error) {
    if (activate && activeKey.value === key) activeKey.value = previousKey;
    if (!instances.get(key)?.canvasId) entries.value = entries.value.filter(item => item.key !== key);
    throw error;
  }
}

async function activateCanvas(fileName: string, signal?: AbortSignal) {
  await ensureCanvas(fileName, signal, true);
}

function resolveCanvasContext(fileName: string): CanvasContext | undefined {
  return [...instances.values()].find(instance => instance.canvasId === fileName)?.getCanvasContext();
}

function getCanvasContext() {
  return activeInstance.value?.getCanvasContext();
}

function checkDocumentDirectory(directory: string) {
  lifetime.signal.throwIfAborted();
  if (!directory || workspaceStore.project?.directory !== directory) throw new Error(translate("工作目录已切换，请重新打开节点"));
}

// 画布节点的文档视图：把节点在画布里的界面投射到文档面板，并把节点状态回传给面板。
async function mountDocumentNode(directory: string, canvasPath: string, nodeId: string, target: HTMLElement) {
  checkDocumentDirectory(directory);
  const panel = await ensureCanvas(canvasPath);
  checkDocumentDirectory(directory);
  return panel.mountDocumentNode(directory, panel.canvasId ?? canvasPath, nodeId, target);
}

async function observeDocumentNode(directory: string, canvasPath: string, nodeId: string, onState: (state: NodeDocumentState) => void) {
  checkDocumentDirectory(directory);
  const panel = await ensureCanvas(canvasPath);
  checkDocumentDirectory(directory);
  return panel.observeDocumentNode(directory, panel.canvasId ?? canvasPath, nodeId, onState);
}

async function flushSave(action?: () => Promise<void>) {
  const panels = entries.value.map(entry => instances.get(entry.key)).filter((panel): panel is CanvasInstance => !!panel);
  if (!action) {
    await Promise.all(panels.map(panel => panel.flushSave()));
    return;
  }
  // 重命名文件期间暂停所有实例自动保存，目标实例同步新路径后再恢复。
  const run = (index: number): Promise<void> => index < panels.length ? panels[index]!.flushSave(() => run(index + 1)) : action();
  await run(0);
}

function adoptCanvasMutationEntries(directory: string, entries: readonly WorkspaceSourceEntry[]): WorkspaceSourceEntry[] {
  checkDocumentDirectory(directory);
  return [...instances.values()].reduce((current, panel) => panel.adoptMutationEntries(current), entries.map(entry => ({ ...entry })));
}
provide("adoptCanvasMutationEntries", adoptCanvasMutationEntries);

async function copyWorkspaceFiles(directory: string, path: string, target: string, signal?: AbortSignal, sourceEntries?: readonly WorkspaceSourceEntry[]) {
  checkDocumentDirectory(directory);
  assertOrganizableAssetPath(target);
  const selectedEntries = sourceEntries?.map(entry => ({ ...entry }));
  const callSignal = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]);
  callSignal.throwIfAborted();
  const files = useWorkspaceFiles(directory);
  const affected = (id: string) => id === path || id.startsWith(`${path}/`);
  const initial = (await files.list(undefined, callSignal)).entries.filter(entry => affected(entry.path));
  const selected = selectedEntries ?? captureWorkspaceSourceEntries(initial, path);
  const candidates = initial.filter(entry => entry.type === "file" && /\.json$/i.test(entry.path));
  const kinds = await Promise.all(candidates.map(entry => isCanvasFile(files, entry.path, callSignal)));
  const sources = candidates.filter((_entry, index) => kinds[index]);
  if (!sources.length) {
    await files.copy(path, target, callSignal, { allowLegacy: true, sourceEntries: selected });
    return;
  }
  for (const source of sources) assertCanvasFilePath(remapWorkspacePath(source.path, path, target));
  if (sources.some(source => !canvases.value.some(canvas => canvas.id === source.path))) await activeInstance.value?.refreshCanvases();
  const panels = [];
  for (const source of sources) panels.push(await ensureCanvas(source.path, callSignal));
  // 节点与文件夹普通文件在同一原生事务中发布；失败不留下沿用旧编号的中间副本。
  await flushSave(async () => {
    const canvasCopies = [];
    for (const panel of panels) canvasCopies.push(await panel.createCanvasCopy(callSignal));
    const sourceEntries = adoptCanvasMutationEntries(directory, selected);
    const current = (await files.list(undefined, callSignal)).entries.filter(entry => affected(entry.path));
    const known = new Map(sourceEntries.map(entry => [entry.path, entry.revision]));
    if (current.length !== sourceEntries.length || current.some(entry => !known.has(entry.path)
      || known.get(entry.path) !== entry.revision)) throw new Error(translate("复制来源已变化，请重新复制"));
    checkDocumentDirectory(directory);
    if (!(await files.copy(path, target, callSignal, { canvasCopies, sourceEntries }))) throw new Error(translate("当前服务尚不支持独立复制画布，复制已停止"));
    // 收到提交回执即登记新画布，取消等待不能把已提交副本隐藏到下一次目录轮询。
    checkDocumentDirectory(directory);
    canvases.value = [...canvases.value, ...sources.map(source => {
      const id = remapWorkspacePath(source.path, path, target);
      return { id, name: id.split("/").at(-1)!.slice(0, -5) };
    })];
  });
}

function documentInstance(canvasPath: string) {
  const instance = [...instances.values()].find(panel => panel.canvasId === canvasPath) ?? activeInstance.value;
  if (!instance) throw new Error(translate("画布尚未就绪"));
  return instance;
}

function readDocumentNode(...args: Parameters<CanvasInstance["readDocumentNode"]>) {
  return documentInstance(args[1]).readDocumentNode(...args);
}

function reloadDocumentNode(...args: Parameters<CanvasInstance["reloadDocumentNode"]>) {
  return documentInstance(args[1]).reloadDocumentNode(...args);
}

function saveDocumentNode(...args: Parameters<CanvasInstance["saveDocumentNode"]>) {
  return documentInstance(args[1]).saveDocumentNode(...args);
}

async function deleteDocumentNode(directory: string, canvasPath: string, nodeId: string, signal?: AbortSignal) {
  checkDocumentDirectory(directory);
  const callSignal = signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal;
  const panel = await ensureCanvas(canvasPath, callSignal);
  callSignal.throwIfAborted();
  checkDocumentDirectory(directory);
  await panel.readDocumentNode(directory, canvasPath, nodeId);
  callSignal.throwIfAborted();
  checkDocumentDirectory(directory);
  const context = panel.getCanvasContext();
  if (!context) throw new Error(translate("画布尚未就绪"));
  await (context.fork?.() ?? context).call({ name: "deleteNodes", args: { nodeIds: [nodeId] } }, callSignal);
}

const mutateWorkspaceFiles: WorkspaceFileMutator = async (directory, change, signal) => {
  checkDocumentDirectory(directory);
  assertOrganizableAssetPath(change.path);
  if (change.target !== undefined) assertOrganizableAssetPath(change.target);
  const callSignal = signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal;
  const panel = activeInstance.value;
  if (!panel) throw new Error(translate("画布尚未就绪"));
  // History-only nodes are absent from saved JSON but still own their originals.
  // Copy/Save-as uses a separate path and remains available for these files.
  for (const instance of instances.values()) {
    if (change.target === undefined && (instance.canvasId === change.path || instance.canvasId?.startsWith(change.path + '/'))) continue;
    if (canvasFileReferences(instance.getRetainedNodes(), referenceScope()).some(reference => reference.path === change.path || reference.path.startsWith(change.path + '/'))) {
      throw new Error(translate('该文件仍被画布或撤销记录作为原件使用，请保持原位，另存副本后整理'));
    }
  }
  await panel.mutateWorkspaceFiles(change, callSignal);
  checkDocumentDirectory(directory);
  const fileName = canvasId.value || entries.value.find(entry => entry.key === activeKey.value)?.fileName;
  if (fileName) await ensureCanvas(fileName, callSignal);
};
provide("mutateWorkspaceFiles", mutateWorkspaceFiles);

function cancelSave() {
  for (const panel of instances.values()) panel.cancelSave();
}

function mentionInstance(canvasId: string) {
  return [...instances.values()].find(panel => panel.canvasId === canvasId);
}

const mentionSource: MentionCanvasSource = {
  currentCanvasId: () => canvasId.value,
  canvases: () => canvases.value.map(canvas => ({ id: canvas.id, name: canvas.id.replace(/\.json$/i, "") })),
  nodes(canvasId, options) {
    const panel = mentionInstance(canvasId);
    if (!panel) return;
    const nodes = panel.getMentionNodes();
    return queryMentionNodes(nodes, `${workspaceStore.project?.directory}:${canvasId}:${nodes.length}`, options);
  },
  outputs(canvasId, nodeId) {
    const panel = mentionInstance(canvasId);
    if (!panel) return;
    const node = panel.findMentionNode(nodeId);
    if (!node) throw new Error(translate("节点已删除，请重新选择"));
    return mentionNodeOutputs(node);
  },
  selectCanvas(canvasId, nodeId, outputId) {
    const panel = mentionInstance(canvasId);
    if (!panel) return;
    const node = panel.findMentionNode(nodeId);
    if (!node) throw new Error(translate("节点已删除，请重新选择"));
    const directory = workspaceStore.project?.directory;
    if (!directory) throw new Error(translate("请先打开工作区"));
    return createCanvasMention(node, canvasId, outputId, async path => {
      const text = await useWorkspaceFiles(directory).readText(path, 400001);
      if (text.length > 100000) throw new Error(translate("文本引用最多支持 100000 个字符，请缩小内容后重试"));
      return text;
    });
  },
};

defineExpose({ async agentCanvas(fileName: string, signal: AbortSignal) { const panel = await ensureCanvas(fileName, signal); const context = panel.getCanvasContext(); if (!context) throw new Error(translate("画布尚未就绪")); return context.fork?.() ?? context; }, canvasId, canvasReady, getCanvasContext, readDocumentNode, reloadDocumentNode, saveDocumentNode, deleteDocumentNode, mutateWorkspaceFiles, mountDocumentNode, observeDocumentNode, flushSave, cancelSave,
  mentionSource, copyWorkspaceFiles, adoptCanvasMutationEntries,
  getRetainedPaths: () => [...new Set([
    ...entries.value.map(entry => instances.get(entry.key)?.canvasId || entry.fileName).filter((path): path is string => !!path),
    ...getRetainedCanvasPaths([...instances.values()].flatMap(panel => panel.getRetainedNodes()), referenceScope()),
  ])],
  get saveBusy() { return [...instances.values()].some(panel => panel.saveBusy); },
});
</script>

<style scoped lang="scss">
.canvasHost {
  position: relative;
  width: 100%;
  height: 100%;

  .canvasRuntime {
    position: absolute;
    inset: 0;

    &.backgroundCanvas {
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
    }
  }
}
</style>
