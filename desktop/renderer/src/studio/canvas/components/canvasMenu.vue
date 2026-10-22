<template>
  <panel class="canvasMenuPanel" position="top-left">
    <el-card class="canvasMenu" shadow="never" :bodyStyle="{ padding: '5px 10px' }">
      <div class="menuContent">
        <el-button v-if="exitWorkspace" class="homeButton" text :icon="IconHome" :title="translate('返回主界面')" :aria-label="translate('返回主界面')" @click="exitWorkspace" />
        <el-input v-model="projectNameDraft" class="workspaceNameInput" :style="{ '--workspaceName': JSON.stringify(projectNameDraft || ' ') }" size="small" :title="directory" :disabled="!workspaceStore.project" :aria-label="translate('项目名称')"
          @keydown.stop @keydown.enter="saveProjectName" @keydown.esc.prevent="projectNameDraft = workspaceName" @blur="saveProjectName" />
        <el-divider direction="vertical" />
        <el-popover v-model:visible="canvasListVisible" trigger="click" placement="bottom-start" :width="320" :showArrow="false" :disabled="!directory">
          <template #reference>
            <el-button class="canvasTrigger" text :loading="busy" :disabled="busy || !directory" :aria-label="translate('切换画布')" :aria-expanded="canvasListVisible">
              <span>{{ activeCanvasName }}</span><icon-chevron-down :size="14" />
            </el-button>
          </template>
          <div class="canvasPicker" @keydown.esc="canvasListVisible = false">
            <div class="pickerHeader">
              <span>{{ translate('画布') }}</span>
              <el-button class="iconButton" text :icon="IconPlus" :disabled="busy || editingId !== null" :aria-label="translate('新增画布')" @click="handleAddCanvas" />
            </div>
            <el-input v-model="canvasSearch" clearable :placeholder="translate('搜索画布')" :aria-label="translate('搜索画布')" @keydown.stop />
            <div class="folderActions"><el-select v-model="currentFolder" :aria-label="translate('画布文件夹')"><el-option :label="translate('全部画布')" value="*" /><el-option :label="translate('根目录')" value="" /><el-option v-for="folder in canvasFolders" :key="folder" :label="folder" :value="folder" /></el-select><el-button text :aria-label="translate('新建文件夹')" @click="createFolder">{{ translate('新建文件夹') }}</el-button></div>
            <el-scrollbar maxHeight="280px">
              <div v-for="canvas in filteredCanvases" :key="canvas.id" class="canvasItem">
                <el-input v-if="editingId === canvas.id" ref="nameInputs" v-model="canvasName" class="nameEditor" size="small" :disabled="busy" :maxlength="120" :aria-label="newCanvasId === canvas.id ? translate('新画布名称') : translate('画布名称')" @keydown.stop @keydown.enter="saveCanvas" @blur="saveCanvas" />
                <template v-else>
                  <button class="canvasChoice" type="button" :disabled="busy || editingId !== null" :aria-pressed="activeCanvasId === canvas.id" :title="canvas.id" @click="handleSwitchCanvas(canvas.id)">{{ canvas.name }}</button>
                  <div class="itemAction">
                    <el-button class="iconButton" text :icon="IconFolders" :disabled="busy || editingId !== null" :aria-label="translate('移动 {0}', { 0: canvas.name })" @click="moveCanvas(canvas)" />
                    <icon-check v-if="activeCanvasId === canvas.id" class="selectedIcon" :size="18" aria-hidden="true" />
                    <el-button class="iconButton renameButton" text :icon="IconEdit" :disabled="busy || editingId !== null" :aria-label="translate('编辑 {0}', { 0: canvas.name })" :title="translate('编辑')" @click="editCanvas(canvas)" />
                    <el-button class="iconButton deleteButton" text type="danger" :icon="IconTrash" :disabled="busy || editingId !== null || canvases.length <= 1" :aria-label="translate('删除 {0}', { 0: canvas.name })" :title="canvases.length <= 1 ? translate('至少保留一个画布') : translate('删除画布')" @click="removeCanvas(canvas)" />
                  </div>
                </template>
              </div>
            </el-scrollbar>
            <el-text v-if="renameError" type="danger" role="alert">{{ renameError }}</el-text>
          </div>
        </el-popover>
      </div>
    </el-card>
    <div class="menuExtension"><slot /></div>
  </panel>
</template>

<script setup lang="ts">
import { hasCanvasMarker, normalizeCanvasDocument } from '../../../../../../server/canvas-document.ts';
import axios from "axios";
import { translate } from "@miaoimg/i18n/vue";
import { computed, inject, nextTick, ref, shallowRef, watch, type ShallowRef } from "vue";
import { Panel, useVueFlow, type FlowExportObject } from "@vue-flow/core";
import { ElMessage, ElMessageBox, type InputInstance } from "element-plus";
import { IconEdit, IconCheck, IconChevronDown, IconPlus, IconTrash, IconFolders, IconHome } from "@tabler/icons-vue";
import { useWorkspaceStore } from "@/stores/workspace";
import useWorkspaceFiles from "@/lib/workspaceFiles";
import { DEFAULT_PROJECT, workspaceOwner, workspaceProject } from '@/lib/workspaceRemote';
import { getCanvasAssetDirectories, getCanvasMarkdownReferences, getRetainedCanvasPaths, isCanvasFile, normalizeCanvasName, normalizeCanvasFolder } from "@/pages/workspace/canvasFile";
import { remapWorkspacePath, type WorkspaceFileChange, type WorkspaceFileCoordinator } from "@/pages/workspace/canvasFiles";
import { migrateNodeTypes } from "../nodes/migrateNodeTypes";
import { captureWorkspaceSourceEntries, workspaceSourceRevision, type WorkspaceSourceEntry } from '@/lib/workspaceFileSelection';

const props = defineProps<{
  directory?: string;
  initialCanvasId?: string;
  activateCanvas?: (id: string, signal?: AbortSignal) => Promise<void>;
  flushSave: (action?: () => Promise<void>) => Promise<void>;
}>();
const emit = defineEmits<{ loaded: [snapshot: { canvas: any; revision: string | null }] }>();
const exitWorkspace = inject<() => Promise<void>>("exitWorkspace", undefined);
const workspaceStore = useWorkspaceStore();
const workspaceName = computed(() => workspaceStore.project?.name || translate("未命名工作区"));
const projectNameDraft = ref("");
watch([() => workspaceStore.project?.directory, workspaceName], () => {
  projectNameDraft.value = workspaceName.value;
}, { immediate: true });

function saveProjectName(event: Event) {
  if (event instanceof KeyboardEvent && event.isComposing) return;
  const project = workspaceStore.project;
  if (project) workspaceStore.renameProject(project.directory, projectNameDraft.value);
  projectNameDraft.value = workspaceName.value;
}

type Canvas = { id: string; name: string; flow?: Pick<FlowExportObject, "nodes" | "edges" | "viewport"> };
const canvases = inject<ShallowRef<Canvas[]>>("canvasList", shallowRef<Canvas[]>([]));
const getRetainedNodes = inject<(id: string) => { id: string; data?: unknown }[]>("canvasAssetNodes", () => []);
const coordinateFiles = inject<WorkspaceFileCoordinator>("coordinateWorkspaceFiles", (_directory, _change, commit) => commit());
const adoptCanvasMutationEntries = inject<(directory: string, entries: readonly WorkspaceSourceEntry[]) => WorkspaceSourceEntry[]>("adoptCanvasMutationEntries", (_directory, entries) => entries.map(entry => ({ ...entry })));
const boundCanvas = shallowRef<Canvas>();
const activeCanvasId = defineModel<string>("canvasId", { default: "" });
watch(canvases, () => {
  if (boundCanvas.value) {
    boundCanvas.value = canvases.value.find(canvas => canvas.id === boundCanvas.value?.id);
    activeCanvasId.value = boundCanvas.value?.id ?? "";
  }
}, { flush: "sync" });
const canvasListVisible = ref(false);
const canvasSearch = ref(''), currentFolder = ref('*'), storedFolders = ref<string[]>([]);
const parentFolder = (id: string) => id.slice(0, Math.max(0, id.lastIndexOf('/')));
function listCanvasFolders(entries: readonly { type: string; path: string }[]) {
  return entries.filter(entry => entry.type === "directory" && !/^(agent|assets|settings|skills)(\/|$)/.test(entry.path)).map(entry => entry.path);
}
function acceptFolderChange({ path, target }: WorkspaceFileChange, folders = storedFolders.value) {
  const affected = (folder: string) => folder === path || folder.startsWith(`${path}/`);
  if (target === undefined) {
    storedFolders.value = folders.filter(folder => !affected(folder));
    if (affected(currentFolder.value)) currentFolder.value = "*";
  } else {
    storedFolders.value = [...new Set(folders.map(folder => remapWorkspacePath(folder, path, target)))];
    currentFolder.value = remapWorkspacePath(currentFolder.value, path, target);
  }
}
const canvasFolders = computed(() => [...new Set([...storedFolders.value, ...canvases.value.map(canvas => parentFolder(canvas.id)).filter(Boolean)])].sort());
const filteredCanvases = computed(() => canvases.value.filter(canvas => (currentFolder.value === '*' || parentFolder(canvas.id) === currentFolder.value) && `${canvas.name} ${canvas.id}`.toLowerCase().includes(canvasSearch.value.trim().toLowerCase())));
async function createCanvasFolder(folder: string, signal?: AbortSignal) {
  const directory = getCanvasDirectory(signal);
  folder = normalizeCanvasFolder(folder);
  if (!folder) throw new Error('请输入文件夹名称');
  busy.value = true;
  try {
    await useWorkspaceFiles(directory).mkdir(folder);
    checkCanvasDirectory(directory);
    storedFolders.value = [...new Set([...storedFolders.value, folder])];
    currentFolder.value = folder;
    signal?.throwIfAborted();
    return { folder };
  } finally { if (props.directory === directory) busy.value = false; }
}
async function createFolder() {
  if (!props.directory || busy.value) return;
  try {
    const { value } = await ElMessageBox.prompt(translate('输入文件夹名称'), translate('新建文件夹'));
    await createCanvasFolder(value);
  } catch (error) { if (error !== 'cancel' && error !== 'close') ElMessage.error(errorMessage(error, translate('新建文件夹失败'))); }
}
async function moveCanvasFile(id: string, folder: string, signal?: AbortSignal, sourceEntries?: readonly WorkspaceSourceEntry[]) {
  const directory = getCanvasDirectory(signal);
  folder = normalizeCanvasFolder(folder);
  const canvas = canvases.value.find(canvas => canvas.id === id);
  if (!canvas) throw new Error('画布不存在，请重新获取画布列表');
  const target = `${folder ? folder + '/' : ''}${canvas.name}.json`;
  if (target === id) return target;
  busy.value = true;
  try {
    await commitWorkspaceFileChange(directory, { path: id, target, sourceEntries }, signal);
    currentFolder.value = folder;
    return target;
  } finally { if (props.directory === directory) busy.value = false; }
}
async function moveCanvas(canvas: Canvas) {
  if (!props.directory || busy.value) return;
  const directory = props.directory;
  try {
    const selection = await captureChange(directory, { path: canvas.id });
    const { value } = await ElMessageBox.prompt(translate('输入目标文件夹，留空移到根目录'), translate('移动画布'), { inputValue: parentFolder(canvas.id) });
    checkCanvasDirectory(directory);
    await moveCanvasFile(canvas.id, value, undefined, selection.sourceEntries);
  } catch (error) { if (error !== 'cancel' && error !== 'close') ElMessage.error(errorMessage(error, translate('移动画布失败'))); }
}
const activeCanvasName = computed(() => canvases.value.find(canvas => canvas.id === activeCanvasId.value)?.name || translate("选择画布"));
const busy = ref(false);
const loadError = ref("");
const editingId = ref<string | null>(null);
const newCanvasId = ref<string | null>(null);
const nameInputs = ref<InputInstance[]>([]);
const canvasName = ref("");
const renameError = ref("");
const { toObject, setNodes, setEdges, setViewport } = useVueFlow();

const activeCanvasStorageKey = (directory: string) => `miaoimg.canvas.active.${directory}`;
function readRememberedCanvas(directory: string) {
  try { return localStorage.getItem(activeCanvasStorageKey(directory)) || ""; } catch { return ""; }
}


watch(() => props.directory, async (directory, _previous, onCleanup) => {
  let cancelled = false;
  onCleanup(() => { cancelled = true; });
  busy.value = true;
  loadError.value = "";
  boundCanvas.value = undefined;
  activeCanvasId.value = "";
  try {
    if (!props.initialCanvasId) canvases.value = [];
    newCanvasId.value = null;
    editingId.value = null;
    renameError.value = "";
    if (!directory) return;
    if (props.initialCanvasId) {
      await applyCanvas(props.initialCanvasId, directory);
      return;
    }
    let loaded = await listCanvases(directory);
    if (cancelled) return;
    if (!loaded.length) {
      try {
        loaded = [await createCanvasFile(directory, "画布1")];
      } catch (err) {
        if (!axios.isAxiosError<{ data?: { code?: string } }>(err) || err.response?.status !== 409 || err.response.data.data?.code !== "EEXIST") throw err;
        // 同时打开工作区时，读取另一请求刚创建的默认画布，不覆盖同名文件。
        const refreshed = await listCanvases(directory);
        // 画布1.json 若被其他 JSON 占用，则使用下一个空闲名称，保留原文件。
        loaded = refreshed.length ? refreshed : [await createCanvasFile(directory)];
      }
    }
    if (cancelled) return;
    canvases.value = loaded;
    // 从灵感库返回时回到上次打开的那张画布，而不是永远回到第一张。
    const remembered = readRememberedCanvas(directory);
    const initial = canvases.value.find(canvas => canvas.id === remembered) || canvases.value[0];
    if (initial) await applyCanvas(initial.id, directory);
  } catch (err) {
    if (!cancelled) {
      loadError.value = errorMessage(err, translate("读取画布失败"));
      if (!props.initialCanvasId) ElMessage.error(loadError.value);
    }
  } finally {
    if (!cancelled) busy.value = false;
  }
}, { immediate: true });

function errorMessage(err: unknown, fallback: string) {
  return axios.isAxiosError<{ message?: string }>(err) ? err.response?.data.message || fallback : err instanceof Error ? err.message : fallback;
}

function getCanvases() {
  return canvases.value.map(({ id, name }) => ({ id, name }));
}

function getCanvasDirectory(signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!props.directory) throw new Error(translate("请先选择工作目录"));
  if (busy.value || editingId.value !== null) throw new Error(translate("画布正在加载或编辑，请稍后重试"));
  return props.directory;
}

function checkCanvasDirectory(directory: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (props.directory !== directory) throw new Error(translate("工作目录已切换，本次画布操作已停止"));
}

async function applyCanvas(canvasId: string, directory: string, signal?: AbortSignal) {
  checkCanvasDirectory(directory, signal);
  const nextCanvas = canvases.value.find(canvas => canvas.id === canvasId);
  const currentCanvas = canvases.value.find(canvas => canvas.id === activeCanvasId.value);
  if (!nextCanvas) throw new Error(translate("画布不存在，请重新获取画布列表"));
  if (nextCanvas === currentCanvas) return;
  if (currentCanvas && props.activateCanvas) {
    await props.activateCanvas(canvasId, signal);
    checkCanvasDirectory(directory, signal);
    return;
  }
  const snapshot = await useWorkspaceFiles(directory).readSnapshot<any>(nextCanvas.id);
  checkCanvasDirectory(directory, signal);
  const data = normalizeCanvasDocument(snapshot?.canvas);
  for (const node of migrateNodeTypes(data.nodes)) if (node.data) delete (node.data as { exportProgress?: unknown }).exportProgress;
  nextCanvas.flow = { nodes: data.nodes, edges: data.edges, viewport: data.viewport };
  // 新实例没有旧画布要替换；后台画布继续自行保存，无须阻塞新画布读取。
  if (currentCanvas) await props.flushSave();
  checkCanvasDirectory(directory, signal);
  if (currentCanvas) currentCanvas.flow = toObject();
  // 应用画布数据时暂时清空文件名，避免初始化触发自动保存。
  activeCanvasId.value = "";
  emit("loaded", { canvas: data, revision: snapshot!.revision });
  setNodes(nextCanvas.flow.nodes);
  // 命中宽度由画布统一配置，不使用旧文件中的覆盖值。
  setEdges(nextCanvas.flow.edges.map(({ interactionWidth, ...edge }) => edge));
  await setViewport(nextCanvas.flow.viewport);
  await nextTick();
  checkCanvasDirectory(directory);
  boundCanvas.value = nextCanvas;
  activeCanvasId.value = nextCanvas.id;
  signal?.throwIfAborted();
}

async function switchCanvas(canvasId: string, signal?: AbortSignal) {
  const directory = getCanvasDirectory(signal);
  canvasListVisible.value = false;
  busy.value = true;
  try {
    if (props.activateCanvas) await props.activateCanvas(canvasId, signal);
    else await applyCanvas(canvasId, directory, signal);
    checkCanvasDirectory(directory, signal);
  } finally {
    if (props.directory === directory) busy.value = false;
  }
}

async function handleSwitchCanvas(canvasId: string) {
  const directory = props.directory;
  try {
    await switchCanvas(canvasId);
  } catch (err) {
    if (props.directory === directory) ElMessage.error(errorMessage(err, translate("切换画布失败")));
  }
}

async function deleteCanvas(id: string, signal?: AbortSignal, sourceEntries?: readonly WorkspaceSourceEntry[]) {
  const directory = getCanvasDirectory(signal);
  const canvas = canvases.value.find(canvas => canvas.id === id);
  if (!canvas) throw new Error('画布不存在，请重新获取画布列表');
  if (canvases.value.length <= 1) throw new Error(translate('至少保留一个画布'));
  busy.value = true;
  canvasListVisible.value = false;
  try {
    checkCanvasDirectory(directory, signal);
    const selection = await captureChange(directory, { path: id, sourceEntries }, signal);
    const nextCanvas = canvases.value.find(item => item.id !== id);
    if (!nextCanvas) throw new Error(translate("至少保留一个画布"));
    const deletingCurrentCanvas = activeCanvasId.value === id;
    if (deletingCurrentCanvas) await applyCanvas(nextCanvas.id, directory, signal);
    await commitWorkspaceFileChange(directory, selection, signal);
    signal?.throwIfAborted();
    return deletingCurrentCanvas ? nextCanvas.id : activeCanvasId.value;
  } finally { if (props.directory === directory) busy.value = false; }
}
async function removeCanvas(canvas: Canvas) {
  if (busy.value || editingId.value !== null || !props.directory || canvases.value.length <= 1) return;
  const directory = props.directory;
  try {
    const selection = await captureChange(directory, { path: canvas.id });
    await ElMessageBox.confirm(translate("确定删除“{0}”？对应的 {1} 文件及独占的节点素材也会被删除，其他画布及 Markdown 文档仍在引用的素材会保留。此操作不可撤销。", { 0: canvas.name, 1: canvas.id }), translate('删除画布'), { type: 'warning', confirmButtonText: translate('删除'), cancelButtonText: translate('取消'), closeOnClickModal: false });
    checkCanvasDirectory(directory);
    await deleteCanvas(canvas.id, undefined, selection.sourceEntries);
    ElMessage.success(translate('画布已删除'));
  } catch (error) { if (error !== 'cancel' && error !== 'close') ElMessage.error(errorMessage(error, translate('删除画布失败'))); }
}

async function createCanvasFile(directory: string, name?: string, signal?: AbortSignal) {
  if (name !== undefined) name = normalizeCanvasName(name);
  const files = useWorkspaceFiles(directory);
  const flow = { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
  const known = new Set((await files.list()).entries.map(entry => entry.path));
  for (let number = 1; ; number++) {
    checkCanvasDirectory(directory, signal);
    const canvasName = name ?? `画布${number}`;
    const folder = currentFolder.value === "*" ? "" : currentFolder.value;
    const id = `${folder ? folder + "/" : ""}${canvasName}.json`;
    if (known.has(id)) {
      if (name === undefined) continue;
      throw new Error(translate("同名画布已存在，请换个名称后重试"));
    }
    try {
      await files.writeJson(id, normalizeCanvasDocument({ miaoimgCanvas: true, ...flow }), true);
      return { id, name: canvasName, flow };
    } catch (err) {
      if (name !== undefined || !axios.isAxiosError<{ data?: { code?: string } }>(err) || err.response?.status !== 409 || err.response.data.data?.code !== "EEXIST") throw err;
    }
  }
}

async function listCanvases(directory: string, signal?: AbortSignal, inventory?: readonly { type: string; path: string; name: string }[]): Promise<Canvas[]> {
  const files = useWorkspaceFiles(directory);
  const entries = inventory ?? (await files.list(undefined, signal)).entries;
  storedFolders.value = listCanvasFolders(entries);
  const loaded = await Promise.all(entries.filter(entry => entry.type === "file" && /\.json$/i.test(entry.name) && !/^(agent|assets)\//.test(entry.path)).map(async entry => {
    if (!(await isCanvasFile(files, entry.path, signal))) return null;
    return { id: entry.path, name: entry.name.slice(0, -5) };
  }));
  return loaded.filter(canvas => canvas !== null).sort((left, right) => left.name.localeCompare(right.name, "zh-CN", { numeric: true }));
}

// All organizer entry points share the canvas save barrier. Update the shared
// records before resuming any mounted canvas, including canvases inside folders.
async function captureChange(directory: string, change: WorkspaceFileChange, signal?: AbortSignal) {
  checkCanvasDirectory(directory, signal);
  const sourceEntries = change.sourceEntries ?? captureWorkspaceSourceEntries((await useWorkspaceFiles(directory).list(undefined, signal)).entries, change.path);
  checkCanvasDirectory(directory, signal);
  return { ...change, sourceEntries: sourceEntries.map(entry => ({ ...entry })) };
}

async function commitWorkspaceFileChange(directory: string, requested: WorkspaceFileChange, signal?: AbortSignal) {
  const change = await captureChange(directory, requested, signal);
  if (change.path === change.target) return;
  return coordinateFiles(directory, change, () => commitCanvasFileChange(directory, change, signal), signal);
}

async function commitCanvasFileChange(directory: string, change: WorkspaceFileChange, signal?: AbortSignal) {
  const { path, target } = change;
  if (path === target) return;
  const affected = (id: string) => id === path || id.startsWith(`${path}/`);
  const files = useWorkspaceFiles(directory);
  let canvasRemoval: { directories: string[]; filesRevision: string; revision: string | null; recursive?: boolean } | undefined;
  const commit = async () => {
    checkCanvasDirectory(directory, signal);
    const sourceEntries = adoptCanvasMutationEntries(directory, change.sourceEntries!);
    if (target === undefined && canvasRemoval) await files.removeCanvas(path, { ...canvasRemoval, sourceEntries, revision: workspaceSourceRevision(sourceEntries, path) }, signal);
    else if (target === undefined) await files.remove(path, change.recursive, signal, sourceEntries);
    else await files.rename(path, target, signal, sourceEntries);
    checkCanvasDirectory(directory);
  };
  if (!canvases.value.some(canvas => affected(canvas.id))) {
    checkCanvasDirectory(directory, signal);
    const { entries } = await files.list(undefined, signal);
    const candidates = entries.filter(entry => entry.type === "file" && affected(entry.path)
      && /\.json$/i.test(entry.path) && !/^(agent|assets)\//.test(entry.path));
    const canvasFiles = await Promise.all(candidates.map(entry => isCanvasFile(files, entry.path, signal)));
    checkCanvasDirectory(directory, signal);
    if (!canvasFiles.some(Boolean)) {
      // Ordinary files do not change any canvas binding. Keep editor flushing
      // in the coordinator, without saving nodes or reading unrelated canvases.
      await commit();
      acceptFolderChange(change, listCanvasFolders(entries));
      return;
    }
  }
  await props.flushSave(async () => {
    checkCanvasDirectory(directory, signal);
    const inventory = await files.list(undefined, signal);
    const known = new Map(canvases.value.map(canvas => [canvas.id, canvas]));
    const current = (await listCanvases(directory, signal, inventory.entries)).map(canvas => known.get(canvas.id) ?? canvas);
    const changing = current.filter(canvas => affected(canvas.id));
    if (target === undefined && changing.length && changing.length === current.length) throw new Error(translate("至少保留一个画布"));
    if (target !== undefined) for (const canvas of changing) {
      const next = remapWorkspacePath(canvas.id, path, target);
      if (!/\.json$/i.test(next)) throw new Error(translate("画布文件须保留 .json 后缀"));
      normalizeCanvasName(next.split("/").at(-1)!.slice(0, -5));
      normalizeCanvasFolder(parentFolder(next));
    }
    let assetDirectories: string[] = [];
    if (target === undefined && changing.length) {
      if (!inventory?.guardedCanvasRemove || !inventory.filesRevision) throw new Error(translate('当前服务尚不支持安全删除画布，请更新后重试'));
      const stored = await Promise.all(current.map(async canvas => {
        const data = await files.readJson<{ nodes?: { id: string; data?: unknown }[] }>(canvas.id, signal);
        if (!hasCanvasMarker(data) || !Array.isArray(data.nodes) || data.nodes.some(node => !node || typeof node.id !== "string")) {
          throw new Error(translate("无法确认 {0} 的素材引用，已停止删除", { 0: canvas.id }));
        }
        return { id: canvas.id, nodes: [...data.nodes, ...getRetainedNodes(canvas.id)] };
      }));
      const removedNodes = stored.filter(canvas => affected(canvas.id)).flatMap(canvas => canvas.nodes);
      const retainedNodes = stored.filter(canvas => !affected(canvas.id)).flatMap(canvas => canvas.nodes);
      const scope = { owner: workspaceOwner(directory), project: workspaceProject(), defaultProject: DEFAULT_PROJECT, origin: window.location.origin };
      // A retained node can address its original through a file API URL too.
      // Resolve it in this project before deciding the source directory is unused.
      const retainedPaths = getRetainedCanvasPaths(retainedNodes, scope);
      assetDirectories = getCanvasAssetDirectories(removedNodes, retainedNodes, retainedPaths);
      if (assetDirectories.length) {
        const references = await getCanvasMarkdownReferences(files, inventory.entries, retainedNodes, assetDirectories, { signal, removedPath: path,
          scope });
        checkCanvasDirectory(directory, signal);
        assetDirectories = getCanvasAssetDirectories(removedNodes, retainedNodes, [...retainedPaths, ...references]);
      }
      canvasRemoval = { directories: assetDirectories, filesRevision: inventory.filesRevision, revision: inventory.entries.find(entry => entry.path === path)?.revision ?? null, recursive: change.recursive };
    }
    let interrupted: { error: unknown } | undefined;
    try { await commit(); }
    catch (error) {
      // A disconnect can hide a committed mutation. Confirm moved canvases by
      // their unchanged versions, never by a destination filename alone. Keep
      // every mounted instance paused until its binding has been reconciled.
      let committed = false;
      try {
        checkCanvasDirectory(directory);
        const observed = await files.list(undefined, AbortSignal.timeout(10000));
        checkCanvasDirectory(directory);
        if (target === undefined) committed = !observed.entries.some(entry => affected(entry.path));
        else {
          const before = new Map(inventory.entries.map(entry => [entry.path, entry.revision]));
          const after = new Map(observed.entries.map(entry => [entry.path, entry.revision]));
          committed = changing.length > 0 && changing.every(canvas => {
            const revision = before.get(canvas.id);
            return !!revision && !after.has(canvas.id) && after.get(remapWorkspacePath(canvas.id, path, target)) === revision;
          });
        }
      } catch { /* Preserve the original error when the outcome is unknown. */ }
      if (!committed) throw error;
      interrupted = { error };
    }
    // A committed rename must change save targets even if cancellation arrives
    // with its receipt. Canvas records retain their identity for every instance.
    checkCanvasDirectory(directory);
    if (target === undefined) {
      canvases.value = current.filter(canvas => !affected(canvas.id));
    } else {
      for (const canvas of changing) {
        canvas.id = remapWorkspacePath(canvas.id, path, target);
        canvas.name = canvas.id.split("/").at(-1)!.slice(0, -5);
      }
      for (const value of [newCanvasId, editingId]) if (value.value) value.value = remapWorkspacePath(value.value, path, target);
      canvases.value = current;
    }
    acceptFolderChange(change);
    // Removed instances cancel their saving before the barrier is released.
    await nextTick();
    if (!props.activateCanvas && !activeCanvasId.value && canvases.value[0]) await applyCanvas(canvases.value[0].id, directory);
    if (interrupted) throw interrupted.error;
  });
}

async function mutateWorkspaceFiles(change: WorkspaceFileChange, signal?: AbortSignal) {
  const directory = getCanvasDirectory(signal);
  busy.value = true;
  try { await commitWorkspaceFileChange(directory, change, signal); }
  finally { if (props.directory === directory) busy.value = false; }
}

async function refreshCanvases() {
  const directory = props.directory;
  if (!directory || busy.value || editingId.value !== null) return;
  const files = useWorkspaceFiles(directory);
  const known = new Set(canvases.value.map(canvas => canvas.id));
  const entries = (await files.list()).entries.filter(entry => entry.type === "file" && /\.json$/i.test(entry.path) && !/^(agent|assets)\//.test(entry.path) && !known.has(entry.path));
  const additions: Canvas[] = [];
  for (const entry of entries) if (await isCanvasFile(files, entry.path)) additions.push({ id: entry.path, name: entry.name.slice(0, -5) });
  if (props.directory === directory && additions.length) canvases.value = [...canvases.value, ...additions].sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true }));
}

async function addCanvas(name?: string, signal?: AbortSignal): Promise<string> {
  const directory = getCanvasDirectory(signal);
  busy.value = true;
  try {
    const canvas = await createCanvasFile(directory, name, signal);
    checkCanvasDirectory(directory);
    canvases.value = [...canvases.value, canvas];
    signal?.throwIfAborted();
    await applyCanvas(canvas.id, directory, signal);
    canvasListVisible.value = false;
    return canvas.id;
  } finally {
    if (props.directory === directory) busy.value = false;
  }
}

async function handleAddCanvas() {
  if (busy.value || editingId.value !== null || !props.directory) return;
  const directory = props.directory;
  busy.value = true;
  try {
    const canvas = await createCanvasFile(directory);
    checkCanvasDirectory(directory);
    canvases.value = [...canvases.value, canvas];
    newCanvasId.value = canvas.id;
    // 新画布必须可见，否则保留的搜索条件会隐藏名称输入框。
    canvasSearch.value = "";
    busy.value = false;
    await editCanvas(canvas);
  } catch (err) {
    if (props.directory === directory) ElMessage.error(errorMessage(err, translate("新增画布失败")));
  } finally {
    if (props.directory === directory) busy.value = false;
  }
}

let editingSelection: { directory: string; path: string; sourceEntries: readonly WorkspaceSourceEntry[] } | undefined;
async function editCanvas(canvas: { id: string; name: string }) {
  if (busy.value || editingId.value !== null) return;
  const directory = props.directory;
  try {
    if (!directory) return;
    const selection = await captureChange(directory, { path: canvas.id });
    if (busy.value || editingId.value !== null) return;
    editingSelection = { directory, path: canvas.id, sourceEntries: selection.sourceEntries };
    editingId.value = canvas.id;
    canvasName.value = canvas.name;
    renameError.value = "";
    await nextTick();
    nameInputs.value[0]?.focus();
    nameInputs.value[0]?.select();
  } catch (error) {
    if (props.directory === directory) ElMessage.error(errorMessage(error, translate("读取画布版本失败")));
  }
}

async function finishEdit() {
  if (busy.value) return;
  editingId.value = null;
  editingSelection = undefined;
  renameError.value = "";
  const createdId = newCanvasId.value;
  newCanvasId.value = null;
  if (createdId) await handleSwitchCanvas(createdId);
}

async function renameCanvasFile(id: string, name: string, directory: string, signal?: AbortSignal) {
  checkCanvasDirectory(directory, signal);
  const canvas = canvases.value.find(item => item.id === id);
  if (!canvas) throw new Error(translate("画布不存在，请重新获取画布列表"));
  name = normalizeCanvasName(name);
  if (name === canvas.name) return id;
  const target = id.slice(0, id.lastIndexOf("/") + 1) + `${name}.json`;
  const sourceEntries = editingSelection?.directory === directory && editingSelection.path === id ? editingSelection.sourceEntries : undefined;
  await commitWorkspaceFileChange(directory, { path: id, target, sourceEntries }, signal);
  checkCanvasDirectory(directory, signal);
  return canvas.id;
}

async function renameCanvas(canvasId: string, name: string, signal?: AbortSignal) {
  const directory = getCanvasDirectory(signal);
  busy.value = true;
  try {
    return await renameCanvasFile(canvasId, name, directory, signal);
  } finally {
    if (props.directory === directory) busy.value = false;
  }
}

async function saveCanvas(event?: Event) {
  if (event instanceof KeyboardEvent && event.isComposing) return;
  const id = editingId.value;
  if (busy.value || !props.directory || id === null) return;
  const directory = props.directory;
  const canvas = canvases.value.find(item => item.id === id);
  if (!canvasName.value.trim() || canvasName.value.trim() === canvas?.name) {
    await finishEdit();
    return;
  }
  busy.value = true;
  renameError.value = "";
  try {
    await renameCanvasFile(id, canvasName.value, directory);
    busy.value = false;
    await finishEdit();
  } catch (err) {
    if (props.directory === directory) {
      renameError.value = errorMessage(err, translate("重命名画布失败"));
      canvasListVisible.value = true;
    }
  } finally {
    if (props.directory === directory) busy.value = false;
  }
}

function syncDocumentNode(canvasId: string, nodeId: string, handleId: string, text: string, inline: boolean) {
  const node = canvases.value.find(canvas => canvas.id === canvasId)?.flow?.nodes.find(node => node.id === nodeId);
  if (!node) return;
  const data = node.data ??= {};
  const output = data.outputs?.[handleId];
  if (output?.dataType === "STRING") output.value = text;
  else if (inline) (data.outputs ??= {})[handleId] = { dataType: "STRING", value: text };
}

defineExpose({ getCanvases, getFolders: () => canvasFolders.value, createCanvasFolder, moveCanvasFile, deleteCanvas, addCanvas, switchCanvas, renameCanvas, syncDocumentNode, refreshCanvases, mutateWorkspaceFiles, loadError });
</script>

<style lang="scss" scoped>
.canvasMenuPanel.vue-flow__panel {
  left: 0;
}

.canvasPicker {
  .iconButton { width: 28px; height: 28px; padding: 0; margin: 0; }

  .pickerHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 4px 8px 8px;
    font-size: 12px;
    color: var(--el-text-color-secondary);
  }

  .canvasItem {
    display: flex;
    align-items: center;
    border-radius: var(--el-border-radius-base);

    .nameEditor {
      width: 100%;
      padding: 2px 0;
    }

    &:hover, &:focus-within {
      background: var(--el-fill-color);
      .itemAction {
        .renameButton, .deleteButton { opacity: 1; }
        .selectedIcon { visibility: hidden; }
      }
    }

    .canvasChoice {
      flex: 1;
      min-width: 0;
      padding: 6px 8px;
      border: 0;
      background: transparent;
      color: var(--el-text-color-primary);
      font: inherit;
      text-align: left;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      cursor: pointer;

      &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: -2px; border-radius: inherit; }
    }

    .itemAction {
      position: relative;
      display: flex;
      flex-shrink: 0;
      width: 56px;
      height: 28px;
      margin-right: 2px;

      .selectedIcon { position: absolute; top: 5px; left: 5px; pointer-events: none; }
      .renameButton, .deleteButton { opacity: 0; }
    }
  }

  @media (hover: none) {
    .canvasItem .itemAction {
      display: flex;
      width: auto;
      align-items: center;
      .selectedIcon { position: static; visibility: visible; }
      .renameButton, .deleteButton { opacity: 1; }
    }
  }
}

.menuExtension {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
}

.canvasMenu {
  margin-left: 138px;
  // 给居中的面板切换器留出固定呼吸空间；项目名再长也只在输入框内收缩。
  max-width: calc(50vw - 254px);

  .menuContent {
    display: flex;
    align-items: center;
    min-width: 0;
    gap: 10px;

    .homeButton {
      width: 28px;
      height: 28px;
      flex: none;
      margin: 0;
      padding: 0;
    }

    .workspaceNameInput {
      flex: 1 1 auto;
      width: auto;
      min-width: 2em;
      max-width: 100%;

      &::after {
        content: var(--workspaceName);
        padding: 0 7px;
        white-space: pre;
        visibility: hidden;
      }

      :deep(.el-input__wrapper) {
        position: absolute;
        inset: 0;
        box-shadow: none;
      }

      :deep(.el-input__inner) {
        font-family: inherit;
        font-weight: inherit;
        letter-spacing: inherit;
        text-overflow: ellipsis;
      }
    }

    .canvasTrigger {
      padding: 0 4px;
      :deep(> span) { display: flex; align-items: center; gap: 6px; }
      span { max-width: 160px; overflow: hidden; text-overflow: ellipsis; }
    }

  }
}
</style>

<style scoped>
.folderActions { display: flex; align-items: center; gap: 6px; margin: 10px 0; }
.folderActions .el-select { flex: 1; min-width: 0; }
</style>
