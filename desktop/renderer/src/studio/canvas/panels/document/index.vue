<template>
  <section class="documentPanel" :aria-label="translate('文档工作区')">
    <div class="treePane">
      <fileTree
        ref="fileTreeRef"
        :directory="directory"
        :activeSelection="activeSelection"
        :fileAction="fileAction"
        @open="(selection, preview) => void openSelection(selection, lifetime.signal, false, undefined, preview).catch(reportError)"
        @quickOpen="quickOpenRef?.open()"
        @search="searchRef?.open()" />
    </div>
    <div class="editorSurface">
      <editorHost @ready="onEditorReady" />
    </div>
    <quickOpen ref="quickOpenRef" :directory="directory" @open="selection => void openSelection(selection).catch(reportError)" />
    <workspaceSearch ref="searchRef" :directory="directory" :active="active" :replaceFile="replaceSearchFile" @open="openSearchResult" />
    <openWithDialog ref="openWithRef" />
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, ref, shallowReactive, shallowRef, watch } from "vue";
import { ElMessage } from "element-plus";
import type { DockviewApi, DockviewReadyEvent } from "dockview-vue";
import { locale, translate } from "@miaoimg/i18n/vue";
import { useWorkspaceStore } from "@/stores/workspace";
import { settingsStorage } from "@/stores/settings";
import { useWorkspaceContentFiles as useWorkspaceFiles } from "@/lib/workspaceFiles";
import fileTree, { type FileAction, type FileTreeItem } from "./components/fileTree.vue";
import quickOpen from "./components/quickOpen.vue";
import workspaceSearch, { type WorkspaceSearchTarget } from "./components/workspaceSearch.vue";
import openWithDialog from "./components/openWithDialog.vue";
import editorHost from "./editorHost.vue";
import { createDocumentSession, documentError, type DocumentSelection, type DocumentSession, type EditorParams, type EditorView, type TabAction } from "./documentSession";
import { flushNodeDocumentSessions } from "./documentNodeSave";
import { extensionAssociations, extensionCandidates, listExtensions, resolveExtension, setExtensionAssociation, type ExtResource } from "../../ext";
import { captureWorkspaceScope, assertWorkspaceScope } from "@/lib/workspaceRemote";
import { assertOrganizableAssetPath } from "../../saveCanvasAsset";
import { remapWorkspacePath, type WorkspaceFileChange, type WorkspaceFileMutator, type WorkspaceFileCoordinator, type WorkspaceFileCopier } from "@/pages/workspace/canvasFiles";
import { isProtectedWorkspacePath } from "../../../../../../../server/workspace-path";
import { isCanvasFile } from "@/pages/workspace/canvasFile";
import type { WorkspaceSourceEntry } from '@/lib/workspaceFileSelection';

type TextOutput = { id: string; label: string; text: string; path?: string };
const props = defineProps<{
  readNode: (directory: string, canvasPath: string, nodeId: string) => Promise<{ label: string; outputs: TextOutput[] }>;
  reloadNode?: (directory: string, canvasPath: string, nodeId: string, handleId: string, savedText: string, draftText: string, signal?: AbortSignal) => Promise<{ label: string; outputs: TextOutput[] }>;
  saveNode: (directory: string, canvasPath: string, nodeId: string, handleId: string, text: string, expectedText?: string) => Promise<void>;
  deleteNode?: (directory: string, canvasPath: string, nodeId: string, signal?: AbortSignal) => Promise<void>;
  mutateFiles: WorkspaceFileMutator;
  copyFiles: WorkspaceFileCopier;
  mountNode?: (directory: string, canvasPath: string, nodeId: string, target: HTMLElement) => Promise<() => void>;
  observeNode?: (
    directory: string, canvasPath: string, nodeId: string,
    onState: (state: { dirty: boolean; error: string; deleted: boolean }) => void,
  ) => Promise<{ release(): void; flushSave(): Promise<void> }>;
}>();
const workspaceStore = useWorkspaceStore();
const directory = computed(() => workspaceStore.project?.directory);
const active = ref(true);
const fileTreeRef = ref<InstanceType<typeof fileTree>>();
const quickOpenRef = ref<InstanceType<typeof quickOpen>>();
const searchRef = ref<InstanceType<typeof workspaceSearch>>();
const openWithRef = ref<InstanceType<typeof openWithDialog>>();
const activeSelection = shallowRef<DocumentSelection>();
const editorApi = shallowRef<DockviewApi>();
const sessions = shallowReactive(new Map<string, DocumentSession>());
const views = new Map<string, EditorView>();
const sessionWatchers = new Map<DocumentSession, () => void>();
const documentTargets = new WeakMap<DocumentSession, { key: string; id: string }>();
const disposables: { dispose(): void }[] = [];
const uniqueSessions = () => [...new Set(sessions.values())];
const lifetime = new AbortController();
let openRevision = 0;
let opening: Promise<unknown> = Promise.resolve();
let layoutTimer: ReturnType<typeof setTimeout> | undefined;
let restoring = false;
let rebuilding = false;
const closedTabs: { selection: DocumentSelection; extensionId: string }[] = [];
const layoutKey = `miaoimg:documentLayout:${directory.value ?? ""}`;
type SavedTab = { id?: string; preview?: boolean; selection: DocumentSelection; extensionId: string };
type SavedLayout = { layout: ReturnType<DockviewApi["toJSON"]>; tabs: SavedTab[] };
let savedLayout: SavedLayout | undefined;
let layoutRestore: Promise<void> = Promise.resolve();
try {
  savedLayout = JSON.parse(settingsStorage.getItem(layoutKey) ?? "null") ?? undefined;
} catch {
  // 旧布局损坏时从空工作区开始。
}

function reportError(error: unknown) {
  ElMessage.error(documentError(error));
}

function editorParams(id: string, session: DocumentSession): EditorParams {
  return { session, view: views.get(id)!, close: () => closeEditor(id).catch(reportError), action: (action) => { void tabAction(id, action).catch(reportError); } };
}

// ── 资源与标签 ────────────────────────────────────────────────────────────────
function insideWorkspace(path: string) {
  const parts = path.replaceAll("\\", "/").split("/").filter((part) => part && part !== ".");
  if (!path || !parts.length || /^[\\/]/.test(path) || /^[a-z][a-z\d+.-]*:/i.test(path) || path.includes("\0") || parts.includes("..")) {
    throw new Error(translate("请选择工作区内的文件或节点"));
  }
  const result = parts.join("/");
  if (isProtectedWorkspacePath(result)) throw new Error(translate("供应商配置只能在设置中管理"));
  return result;
}

function toResource(currentDirectory: string, selection: DocumentSelection): ExtResource {
  return "filePath" in selection
    ? { kind: "file", directory: currentDirectory, path: insideWorkspace(selection.filePath), label: selection.label }
    : { kind: "canvasNode", directory: currentDirectory, path: insideWorkspace(selection.canvasPath), nodeId: selection.nodeId, label: selection.label };
}

function selectionOf(resource: ExtResource): DocumentSelection {
  return resource.kind === "file"
    ? { filePath: resource.path, label: resource.label }
    : { canvasPath: resource.path, nodeId: resource.nodeId, label: resource.label };
}

function resourceId(resource: ExtResource) {
  return JSON.stringify([resource.kind, resource.directory, resource.path, resource.kind === "canvasNode" ? resource.nodeId : ""]);
}

function sameResource(left: ExtResource, right: ExtResource) {
  return left.kind === right.kind && left.path === right.path
    && (left.kind !== "canvasNode" || right.kind === "canvasNode" && left.nodeId === right.nodeId);
}

// 同一份文档被拆成多个视图时，标签上补一段路径说明。
function updateTabDescriptions() {
  for (const [id, session] of sessions) {
    const resource = session.context.resource;
    const duplicate = uniqueSessions().some((other) => other !== session && other.context.resource.label === resource.label);
    views.get(id)!.description = duplicate ? (resource.kind === "canvasNode" ? resource.path : resource.path.split("/").slice(0, -1).join("/") || translate("工作区")) : "";
  }
}
watch(locale, updateTabDescriptions);

function keepOpen(id: string) {
  const view = views.get(id);
  if (view) view.preview = false;
  saveLayout();
}

function addView(id: string, session: DocumentSession, preview = false, position?: { referencePanel: string; direction: "right" | "below" }) {
  if (sessions.has(id) || editorApi.value?.getPanel(id)) throw new Error(translate("标签已打开，请重新选择"));
  sessions.set(id, session);
  views.set(id, shallowReactive({ preview, description: "" }));
  try {
    editorApi.value!.addPanel({ id, title: session.context.resource.label, component: "extView", tabComponent: "editorTab", params: editorParams(id, session), position });
    updateTabDescriptions();
  } catch (error) {
    if (sessions.get(id) === session) { sessions.delete(id); views.delete(id); }
    throw error;
  }
}

// ── 布局持久化 ────────────────────────────────────────────────────────────────
function saveLayout() {
  clearTimeout(layoutTimer);
  if (restoring || !editorApi.value) return;
  const layout = editorApi.value.toJSON();
  // 只保存布局与文件身份，不序列化运行中的组件、闭包或未保存正文。
  const panels = Object.fromEntries(Object.entries(layout.panels).map(([id, panel]) => [id, { ...panel, params: undefined }]));
  try {
    settingsStorage.setItem(layoutKey, JSON.stringify({
      layout: { ...layout, panels },
      tabs: [...sessions].map(([id, session]) => ({ id, preview: views.get(id)?.preview, selection: selectionOf(session.context.resource), extensionId: session.extension.id })),
    }));
  } catch {
    // 存储不可用时仍允许正常编辑。
  }
}

function scheduleLayoutSave() {
  clearTimeout(layoutTimer);
  layoutTimer = setTimeout(saveLayout, 250);
}

async function restoreLayout() {
  const saved = savedLayout;
  savedLayout = undefined;
  if (!saved || !Array.isArray(saved.tabs)) return;
  restoring = true;
  try {
    for (const tab of saved.tabs) {
      try {
        await openSelection(tab.selection, lifetime.signal, false, tab.extensionId, tab.preview, tab.id);
      } catch {
        // 已删除的文件或打不开的节点不阻止其余标签恢复。
      }
    }
    const api = editorApi.value!;
    if (saved.layout && Object.keys(saved.layout.panels).length === sessions.size && Object.keys(saved.layout.panels).every((id) => sessions.has(id))) {
      const panels = Object.fromEntries(Object.entries(saved.layout.panels).map(([id, panel]) => [id, { ...panel, title: sessions.get(id)!.context.resource.label, contentComponent: "extView", tabComponent: "editorTab", params: editorParams(id, sessions.get(id)!) }]));
      rebuilding = true;
      try {
        api.fromJSON({ ...saved.layout, panels });
      } finally {
        rebuilding = false;
      }
    }
  } catch (error) {
    reportError(error);
  } finally {
    restoring = false;
    saveLayout();
  }
}

function onEditorReady({ api }: DockviewReadyEvent) {
  editorApi.value = api;
  disposables.push(api.onDidActivePanelChange((panel) => {
    const session = panel.panel && sessions.get(panel.panel.id);
    activeSelection.value = session ? selectionOf(session.context.resource) : undefined;
  }));
  disposables.push(api.onDidRemovePanel((panel) => {
    if (rebuilding) return;
    const session = sessions.get(panel.id);
    sessions.delete(panel.id);
    views.delete(panel.id);
    if (session && !uniqueSessions().includes(session)) {
      session.cancelSave();
      sessionWatchers.get(session)?.();
      sessionWatchers.delete(session);
    }
    updateTabDescriptions();
    saveLayout();
  }));
  disposables.push(api.onDidLayoutChange(() => scheduleLayoutSave()));
  layoutRestore = restoreLayout();
}

// ── 打开与关闭 ────────────────────────────────────────────────────────────────
function associationKey(resource: ExtResource) {
  return resource.kind === "canvasNode" ? "canvasNode" : resource.path.split(".").at(-1)!.toLowerCase();
}

// 有默认关联或只有一个候选时直接打开；候选多于一个又没有关联时才问用户，并把选择记进默认关联。
async function chooseExtension(resource: ExtResource, forceChoice: boolean) {
  const candidates = await extensionCandidates(resource);
  if (!candidates.length) throw new Error(translate("没有能打开“{0}”的编辑器", { 0: resource.label }));
  const key = associationKey(resource);
  const defaultId = candidates.find((item) => item.id === extensionAssociations.value[key])?.id;
  if (!forceChoice && (defaultId || candidates.length === 1)) return resolveExtension(resource, defaultId ?? candidates[0]!.id);
  const choice = await openWithRef.value?.choose(resource.label, candidates.map((item) => ({ id: item.id, displayName: item.displayName, version: item.version })), defaultId);
  if (!choice) return undefined;
  if (choice.makeDefault) await setExtensionAssociation(key, choice.id);
  return resolveExtension(resource, choice.id);
}

// 指定的扩展被卸载或不再支持这个资源时回落到重新选择，而不是让整个打开失败。
async function resolveExtensionFor(resource: ExtResource, extensionId: string | undefined, forceChoice: boolean) {
  if (extensionId && !forceChoice) {
    try {
      return await resolveExtension(resource, extensionId);
    } catch {
      // 扩展被卸载或不再支持这个后缀，下面按候选重新解析。
    }
  }
  return chooseExtension(resource, forceChoice);
}

// dockview 实例由 ready 事件交出来，恢复布局与 MCP 打开都可能抢在它前面。
async function waitForEditor(signal: AbortSignal) {
  for (let attempt = 0; attempt < 200 && !editorApi.value; attempt++) {
    signal.throwIfAborted();
    await new Promise((done) => setTimeout(done, 20));
  }
  if (!editorApi.value) throw new Error(translate("文档编辑器尚未就绪"));
  return editorApi.value;
}

function openSelection(selection: DocumentSelection, signal = lifetime.signal, forceChoice = false, extensionId?: string, preview = false, restoredId?: string) {
  const request = ++openRevision;
  // 打开方式选择、关闭旧视图和登记新视图共用顺序队列，避免异步保存时重复登记同一资源。
  const result = opening.then(() => openSelectionNow(selection, signal, forceChoice, extensionId, preview, restoredId, request));
  opening = result.then(() => {}, () => {});
  return result;
}

async function openSelectionNow(selection: DocumentSelection, signal: AbortSignal, forceChoice: boolean, extensionId: string | undefined, preview: boolean, restoredId: string | undefined, request: number) {
  signal.throwIfAborted();
  const currentDirectory = directory.value;
  if (!currentDirectory) return undefined;
  const api = await waitForEditor(signal);
  const resource = toResource(currentDirectory, selection);
  const matching = [...sessions].filter(([, session]) => sameResource(session.context.resource, resource));
  const match = matching.find(([id]) => api.getPanel(id)?.group === api.activeGroup) ?? matching[0];
  const existing = match && api.getPanel(match[0]);
  if (existing) {
    if (preview && request !== openRevision) return undefined;
    // 恢复布局时同一份文件可能既有普通标签又有拆分视图，各用各的面板 id。
    if (restoredId && !sessions.has(restoredId) && resource.kind === "file") {
      addView(restoredId, match![1], preview);
      return match![1];
    }
    existing.api.setActive();
    if (!preview) keepOpen(existing.id);
    const session = match![1];
    try {
      await session.ready;
    } catch (error) {
      // A failed first open (for example before MCP creates the file) must
      // not leave this tab permanently attached to a rejected load promise.
      if (session.context.dirty) throw error;
      signal.throwIfAborted();
      session.ready = session.load();
      await session.ready;
    }
    signal.throwIfAborted();
    return session;
  }
  const extension = await resolveExtensionFor(resource, extensionId, forceChoice);
  if (!extension) return undefined;
  signal.throwIfAborted();
  if (directory.value !== currentDirectory) throw new Error(translate("工作目录已切换"));
  // 预览标签只占当前分组的一个位置：打开新的预览前先关掉本组里干净的旧预览。
  if (preview && !restoring && !restoredId) {
    for (const panel of [...(api.activeGroup?.panels ?? [])]) {
      if (!views.get(panel.id)?.preview) continue;
      const session = sessions.get(panel.id)!;
      if (session.context.dirty || session.context.error) { keepOpen(panel.id); continue; }
      await closeEditor(panel.id, false);
    }
  }
  if (preview && request !== openRevision) return undefined;
  const id = restoredId ?? resourceId(resource);
  const session = createDocumentSession(resource, extension, { readNode: props.readNode, reloadNode: props.reloadNode, saveNode: props.saveNode, mountNode: props.mountNode, observeNode: props.observeNode }, () => {
    // 会话确认可以关闭后，同一文档的分屏一起关闭；不再向已删除节点保存。
    for (const [viewId, current] of [...sessions]) {
      if (current === session) editorApi.value?.getPanel(viewId)?.api.close();
    }
    fileTreeRef.value?.refresh();
  });
  session.context.active = active.value;
  try {
    addView(id, session, preview);
    sessionWatchers.set(session, watch([() => session.context.dirty, () => session.context.resource.label], ([dirty, label], [, previousLabel]) => {
      if (dirty) for (const [viewId, current] of sessions) if (current === session) keepOpen(viewId);
      if (label !== previousLabel) {
        for (const [viewId, current] of sessions) if (current === session) editorApi.value?.getPanel(viewId)?.api.setTitle(label);
        if (currentSession() === session) activeSelection.value = selectionOf(session.context.resource);
        updateTabDescriptions();
        saveLayout();
      }
    }, { flush: "sync" }));
  } catch (error) {
    session.cancelSave();
    if (sessions.get(id) === session) sessions.delete(id);
    throw error;
  }
  await session.ready;
  signal.throwIfAborted();
  return session;
}

async function closeEditor(id: string, remember = true, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const session = sessions.get(id);
  if (!session) return;
  if (session.closing) throw new Error(translate("文档正在关闭，请稍后再试"));
  session.closing = true;
  try {
    // 保存失败就不关标签，避免把没落盘的内容丢掉。
    await session.context.flushSave();
    signal?.throwIfAborted();
    if (remember) {
      closedTabs.push({ selection: selectionOf(session.context.resource), extensionId: session.extension.id });
      if (closedTabs.length > 20) closedTabs.shift();
    }
    editorApi.value?.getPanel(id)?.api.close();
  } finally {
    session.closing = false;
  }
}

async function tabAction(id: string, action: TabAction) {
  const api = editorApi.value;
  if (!api) return;
  if (action === "reopen") {
    const tab = closedTabs.at(-1);
    if (tab) {
      await openSelection(tab.selection, lifetime.signal, false, tab.extensionId);
      closedTabs.pop();
    }
    return;
  }
  const panel = api.getPanel(id);
  if (!panel) return;
  if (action === "keepOpen") { keepOpen(id); return; }
  if (action === "splitRight" || action === "splitDown") {
    const session = sessions.get(id)!;
    keepOpen(id);
    if (session.context.resource.kind === "canvasNode") {
      // ACT: 画布节点保留唯一运行实例，分屏只移动，不能复制 Teleport 的挂载目标。
      if (panel.group.panels.length < 2) {
        ElMessage.info(translate("画布节点只有一个视图，请先打开另一标签再移动到分屏"));
        return;
      }
      panel.api.moveTo({ group: panel.group, position: action === "splitRight" ? "right" : "bottom" });
      return;
    }
    const viewId = `${id}:${crypto.randomUUID()}`;
    addView(viewId, session, false, { referencePanel: id, direction: action === "splitRight" ? "right" : "below" });
    return;
  }
  const ids = action === "closeAll" ? api.panels.map((item) => item.id)
    : action === "closeOthers" ? api.panels.filter((item) => item.id !== id).map((item) => item.id)
      : action === "closeRight" ? panel.group.panels.slice(panel.group.panels.indexOf(panel) + 1).map((item) => item.id) : [id];
  for (const viewId of ids) {
    try {
      await closeEditor(viewId);
    } catch (error) {
      reportError(error);
    }
  }
}

// ── 文件操作 ──────────────────────────────────────────────────────────────────
function affectedIdents(path: string) {
  const prefix = `${path}/`;
  return [...sessions.entries()].filter(([, session]) => {
    const current = session.context.resource.path;
    return current === path || current.startsWith(prefix);
  });
}

function remapSelection(selection: DocumentSelection, source: string, target: string): DocumentSelection {
  const move = (path: string) => remapWorkspacePath(path, source, target);
  return "filePath" in selection
    ? { filePath: move(selection.filePath), label: selection.filePath === source ? target.split("/").at(-1)! : selection.label }
    : { canvasPath: move(selection.canvasPath), nodeId: selection.nodeId, label: selection.label };
}

// 改动文件前先落盘并关掉受影响的视图：session 的写入目标固定在打开时的路径。
function adoptMutationEntries(entries: readonly WorkspaceSourceEntry[], editors = uniqueSessions()): WorkspaceSourceEntry[] {
  return entries.map(entry => {
    const session = editors.find(session => session.context.resource.kind === 'file' && session.context.resource.path === entry.path);
    return { ...entry, revision: session?.mutationRevision(entry.revision) || entry.revision };
  });
}

async function detachAffected(path: string, nodeId?: string, sourceEntries?: readonly WorkspaceSourceEntry[]) {
  const affected = affectedIdents(path).filter(([, session]) => !nodeId || session.context.resource.kind === "canvasNode" && session.context.resource.nodeId === nodeId);
  const detached = affected.map(([id, session]) => ({ id, selection: selectionOf(session.context.resource), extensionId: session.extension.id, preview: views.get(id)?.preview ?? false, wasActive: editorApi.value?.activePanel?.id === id }));
  await Promise.all(affected.map(([, session]) => session.context.flushSave()));
  const savedEntries = sourceEntries && adoptMutationEntries(sourceEntries, [...new Set(affected.map(([, session]) => session))]);
  const previousLayout = editorApi.value?.toJSON();
  for (const entry of detached) await closeEditor(entry.id, false);
  return { detached, previousLayout, sourceEntries: savedEntries };
}

let treeMutation = 0;
async function commitTreeMutation(currentDirectory: string, change: WorkspaceFileChange, signal: AbortSignal) {
  treeMutation++;
  try { await props.mutateFiles(currentDirectory, change, signal); }
  finally { treeMutation--; }
}

async function fileAction(action: FileAction, item: FileTreeItem, target?: string, signal?: AbortSignal, recursive = item.type === "directory") {
  const callSignal = signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal;
  callSignal.throwIfAborted();
  const currentDirectory = directory.value;
  if (!currentDirectory) throw new Error(translate("请先打开工作区"));
  const scope = captureWorkspaceScope();
  const assertActive = () => {
    callSignal.throwIfAborted();
    assertWorkspaceScope(scope);
    if (directory.value !== currentDirectory) throw new Error(translate("工作目录已切换"));
  };
  const files = useWorkspaceFiles(currentDirectory);
  const source = insideWorkspace(item.path);
  if (item.type === "node") {
    if (action !== "delete" || !item.nodeId || !props.deleteNode) throw new Error(translate("请在画布中操作该节点"));
    await detachAffected(source, item.nodeId);
    assertActive();
    await props.deleteNode(currentDirectory, source, item.nodeId, callSignal);
    return;
  }
  if (action !== "copy" && action !== "openWith") assertOrganizableAssetPath(source);
  if (action === "create") { await files.write(source, "", true, callSignal); return; }
  if (action === "mkdir") { await files.mkdir(source, callSignal); return; }
  if (action === "openWith") { await openSelection({ filePath: source, label: item.name }, callSignal, true); return; }
  if (action === "delete") {
    assertActive();
    await commitTreeMutation(currentDirectory, { path: source, recursive, sourceEntries: item.sourceEntries }, callSignal);
    return;
  }
  if (target === undefined) throw new Error(translate("缺少目标路径"));
  const destination = insideWorkspace(target);
  assertOrganizableAssetPath(destination);
  if (action === "copy") { await props.copyFiles(currentDirectory, source, destination, callSignal, item.sourceEntries); return; }
  assertActive();
  await commitTreeMutation(currentDirectory, { path: source, target: destination, sourceEntries: item.sourceEntries }, callSignal);
}

const coordinateWorkspaceFiles: WorkspaceFileCoordinator = async (currentDirectory, change, commit, signal) => {
  const scope = captureWorkspaceScope();
  const assertActive = () => {
    lifetime.signal.throwIfAborted();
    assertWorkspaceScope(scope);
    if (directory.value !== currentDirectory) throw new Error(translate("工作目录已切换"));
  };
  assertActive();
  signal?.throwIfAborted();
  const source = insideWorkspace(change.path);
  if (change.target === undefined) {
    const { detached, sourceEntries } = await detachAffected(source, undefined, change.sourceEntries);
    if (sourceEntries) change.sourceEntries = sourceEntries;
    assertActive();
    signal?.throwIfAborted();
    try { await commit(); }
    catch (error) {
      // A rejected deletion keeps its editors. A deletion whose later asset
      // cleanup failed must not reopen files that were actually removed.
      try {
        assertActive();
        const { entries } = await useWorkspaceFiles(currentDirectory).list(undefined, lifetime.signal);
        assertActive();
        const remaining = new Set(entries.filter(entry => entry.type === "file").map(entry => entry.path));
        for (const entry of detached) {
          const path = "filePath" in entry.selection ? entry.selection.filePath : entry.selection.canvasPath;
          if (remaining.has(path)) await openSelection(entry.selection, lifetime.signal, false, entry.extensionId, entry.preview).catch(reportError);
        }
      } catch { /* The original error remains the result when recovery is unavailable. */ }
      throw error;
    }
    assertActive();
    if (!treeMutation) fileTreeRef.value?.refresh();
    return;
  }
  const destination = insideWorkspace(change.target);
  const { detached, previousLayout, sourceEntries } = await detachAffected(source, undefined, change.sourceEntries);
  if (sourceEntries) change.sourceEntries = sourceEntries;
  try {
    assertActive();
    signal?.throwIfAborted();
    await commit();
  } catch (error) {
    try {
      assertActive();
      // A lost receipt does not undo a committed rename. Reopen only an
      // existing resource, using the destination when the source is gone.
      const { entries } = await useWorkspaceFiles(currentDirectory).list(undefined, lifetime.signal);
      assertActive();
      const remaining = new Set(entries.filter(entry => entry.type === "file").map(entry => entry.path));
      for (const entry of detached) {
        const path = "filePath" in entry.selection ? entry.selection.filePath : entry.selection.canvasPath;
        const selection = remaining.has(path) ? entry.selection
          : remaining.has(remapWorkspacePath(path, source, destination)) ? remapSelection(entry.selection, source, destination) : undefined;
        if (selection) await openSelection(selection, lifetime.signal, false, entry.extensionId, entry.preview).catch(reportError);
      }
      fileTreeRef.value?.refresh();
    } catch { /* Preserve the original error when recovery is unavailable. */ }
    throw error;
  }
  assertActive();
  const renamed = detached.map((entry) => ({ ...entry, nextId: `document:${crypto.randomUUID()}`, selection: remapSelection(entry.selection, source, destination) }));
  // 先恢复非活动标签，最后恢复原来选中的那个，重开后焦点不跳。
  for (const entry of [...renamed].sort((left, right) => Number(left.wasActive) - Number(right.wasActive))) {
    await openSelection(entry.selection, lifetime.signal, false, entry.extensionId, entry.preview, entry.nextId).catch(reportError);
  }
  const remapped = new Map(renamed.map((entry) => [entry.id, entry.nextId]));
  const expected = previousLayout && Object.keys(previousLayout.panels).map((id) => remapped.get(id) ?? id);
  // 重开期间用户可能继续开关标签，此时以当前布局为准，不恢复过时的分屏结构。
  if (renamed.length && previousLayout && expected?.length === sessions.size && expected.every((id) => sessions.has(id))) {
    const layout = JSON.parse(JSON.stringify({ ...previousLayout, panels: {} }, (_key, value) => typeof value === "string" ? remapped.get(value) ?? value : value)) as ReturnType<DockviewApi["toJSON"]>;
    layout.panels = Object.fromEntries(Object.entries(previousLayout.panels).map(([oldId, panel]) => {
      const id = remapped.get(oldId) ?? oldId;
      const session = sessions.get(id)!;
      return [id, { ...panel, id, title: session.context.resource.label, params: editorParams(id, session) }];
    }));
    rebuilding = true;
    try {
      editorApi.value!.fromJSON(layout);
    } finally {
      rebuilding = false;
    }
  }
  saveLayout();
  if (!treeMutation) fileTreeRef.value?.refresh();
};

// ── 全文搜索的打开与替换 ────────────────────────────────────────────────────────
async function openSearchResult(location: WorkspaceSearchTarget) {
  try {
    const session = await openSelection({ filePath: location.path, label: location.path.split("/").at(-1)! }, lifetime.signal);
    const id = editorApi.value?.activePanel?.id;
    if (session && id && sessions.get(id) === session) views.get(id)!.location = { query: location.query, revision: Date.now(), line: location.line, column: location.column };
  } catch (error) {
    reportError(error);
  }
}

// 画布文本节点的正文可能单独存在工作区文件里（node.data.textPath），这时替换必须走同一个
// session，否则画布标签里的旧正文会在下一次自动保存时覆盖掉替换结果。
async function canvasNodeSessionFor(currentDirectory: string, path: string) {
  const files = useWorkspaceFiles(currentDirectory);
  const owners = new Map<string, string | undefined>();
  for (const session of uniqueSessions()) {
    const resource = session.context.resource;
    if (resource.kind !== "canvasNode") continue;
    if (!owners.has(resource.path)) {
      let owner: string | undefined;
      try {
        const canvas = await files.readJson<{ nodes?: { id?: unknown; data?: { textPath?: unknown } }[] }>(resource.path);
        const node = canvas?.nodes?.find((item) => item?.data?.textPath === path);
        owner = typeof node?.id === "string" ? node.id : undefined;
      } catch {
        // 画布读不出来时不猜归属，交给普通文件路径处理。
      }
      owners.set(resource.path, owner);
    }
    if (owners.get(resource.path) === resource.nodeId) return session;
  }
  return undefined;
}

async function replaceSearchFile(path: string, expectedText: string, nextText: string) {
  const currentDirectory = directory.value;
  if (!currentDirectory) throw new Error(translate("请先打开工作区"));
  const source = insideWorkspace(path);
  const opened = uniqueSessions().find((session) => session.context.resource.kind === "file" && session.context.resource.path === source);
  if (opened) {
    if (!opened.extension.text || opened.context.loading || opened.context.text !== expectedText) throw new Error(translate("打开的文档内容已变化，请重新搜索"));
    opened.context.updateText(nextText);
    await opened.context.flushSave();
    return;
  }
  const canvasNode = await canvasNodeSessionFor(currentDirectory, source);
  if (canvasNode) {
    if (canvasNode.context.loading || canvasNode.context.text !== expectedText) throw new Error(translate("打开的文档内容已变化，请重新搜索"));
    canvasNode.context.updateText(nextText);
    await canvasNode.context.flushSave();
    return;
  }
  const files = useWorkspaceFiles(currentDirectory);
  // Keep this read's revision even if another view refreshes the shared cache
  // while the replacement waits in the workspace write queue.
  const snapshot = await files.readTextSnapshot(source);
  if (snapshot.text !== expectedText) throw new Error(translate("磁盘内容已变化，请重新搜索"));
  await files.writeText(source, nextText, snapshot.revision);
}

// ── 对外控制面（MCP / 面板切换）────────────────────────────────────────────────
async function flushSave() {
  const results = await Promise.allSettled(uniqueSessions().map((session) => session.context.flushSave()));
  const failed = results.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
}

async function flushNodeDocuments(targetDirectory: string, canvasPath: string, nodeIds: readonly string[], signal?: AbortSignal) {
  if (directory.value !== targetDirectory) throw new Error(translate("工作目录已切换"));
  await flushNodeDocumentSessions(uniqueSessions, targetDirectory, canvasPath, nodeIds, signal);
  if (directory.value !== targetDirectory) throw new Error(translate("工作目录已切换"));
}

function cancelSave() {
  for (const session of uniqueSessions()) session.cancelSave();
}

// 画布节点可能在画布面板里被改过，取正文前先按宿主状态同步一次。
async function syncCanvasNode(session: DocumentSession) {
  await session.syncNode();
}

function documentTargetId(session: DocumentSession) {
  // Equal text does not identify a resource. Keep receipts stable for one
  // live document/output, and retire them on relocation or a new session.
  const { resource, handleId } = session.context;
  const key = JSON.stringify([resource.directory, resource.kind, resource.path, resource.kind === "canvasNode" ? resource.nodeId : null, handleId || (session.extension.text ? "text" : null)]);
  const previous = documentTargets.get(session);
  if (previous?.key === key) return previous.id;
  const id = crypto.randomUUID();
  documentTargets.set(session, { key, id });
  return id;
}

function snapshot(session: DocumentSession | undefined, includeText: boolean) {
  return {
    documentId: session ? documentTargetId(session) : null,
    canWriteText: session?.canWriteText ?? false,
    selection: session ? selectionOf(session.context.resource) : null,
    handleId: session?.context.handleId || (session?.extension.text ? "text" : null),
    dirty: session?.context.dirty ?? false,
    saveError: session?.context.error || null,
    ...(includeText ? { text: session?.context.text ?? "" } : {}),
  };
}

function currentSession() {
  return sessions.get(editorApi.value?.activePanel?.id ?? "");
}

// 面板状态要同步返回（MCP 每帧都在读），只有取正文时才异步读画布节点。
function getDocument(includeText = true) {
  if (!includeText) return snapshot(currentSession(), false);
  return waitForEditor(lifetime.signal).then(() => layoutRestore).then(async () => {
    const session = currentSession();
    if (!session) return snapshot(session, true);
    insideWorkspace(session.context.resource.path);
    await session.ready;
    await syncCanvasNode(session);
    if (currentSession() !== session) throw new Error(translate("文档已切换，请重新读取"));
    return snapshot(session, true);
  });
}

async function openDocument(args: Record<string, unknown>, signal: AbortSignal) {
  signal.throwIfAborted();
  const currentDirectory = directory.value;
  if (!currentDirectory) throw new Error(translate("请先打开工作区"));
  await waitForEditor(signal);
  await layoutRestore;
  signal.throwIfAborted();
  if (directory.value !== currentDirectory) throw new Error(translate("工作目录已切换"));
  const selection = documentSelection(args)!;
  const session = await openSelection(selection, signal);
  if (!session) throw new Error(translate("已取消选择打开方式"));
  if (typeof args.handleId === "string" && session.context.resource.kind === "canvasNode") {
    const resource = session.context.resource;
    const node = await props.readNode(resource.directory, resource.path, resource.nodeId);
    if (!node.outputs.some((output) => output.id === args.handleId)) throw new Error(translate("文本输出不存在"));
    await session.context.selectOutput(args.handleId);
  }
  signal.throwIfAborted();
  if (currentSession() !== session) throw new Error(translate("文档已切换，请重新读取"));
}

async function writeDocument(args: Record<string, unknown>, signal: AbortSignal) {
  signal.throwIfAborted();
  const session = currentSession();
  if (!session || session.closing || session.context.loading) throw new Error(translate("请先打开需要编辑的文档"));
  insideWorkspace(session.context.resource.path);
  if (typeof args.text !== "string" || typeof args.expectedText !== "string") throw new Error(translate("需要 text 和读取时的 expectedText"));
  const assertTarget = () => {
    signal.throwIfAborted();
    if (currentSession() !== session || documentTargetId(session) !== args.documentId) throw new Error(translate("文档已切换，请重新读取"));
  };
  assertTarget();
  if (!session.canWriteText) throw new Error(translate("当前文档不支持文本写入"));
  await session.ready;
  await syncCanvasNode(session);
  assertTarget();
  if (session.context.text !== args.expectedText) throw new Error(translate("文档内容已变化，请重新读取后编辑"));
  session.context.updateText(args.text);
  await session.context.flushSave();
  signal.throwIfAborted();
  // Saving may outlive the active tab. Report the document actually written;
  // a separate current-document read could return a different file instead.
  return snapshot(session, true);
}

function documentSelection(args: Record<string, unknown>, current = false): DocumentSelection | undefined {
  if (typeof args.path === "string" && args.canvasPath === undefined && args.nodeId === undefined && args.handleId === undefined) {
    return { filePath: insideWorkspace(args.path), label: args.path.split(/[\\/]/).at(-1)! };
  }
  if (args.path === undefined && typeof args.canvasPath === "string" && typeof args.nodeId === "string") {
    return { canvasPath: insideWorkspace(args.canvasPath), nodeId: args.nodeId, label: `${translate("未命名节点")} · ${args.nodeId.slice(0, 8)}` };
  }
  if (current && args.path === undefined && args.canvasPath === undefined && args.nodeId === undefined) {
    const session = currentSession();
    return session && selectionOf(session.context.resource);
  }
  throw new Error(translate("请指定文件 path，或完整的 canvasPath 和 nodeId；两种目标不能混用"));
}

async function documentCommandScope(signal: AbortSignal) {
  const currentDirectory = directory.value;
  if (!currentDirectory) throw new Error(translate("请先打开工作区"));
  const scope = captureWorkspaceScope();
  const assertActive = () => {
    signal.throwIfAborted();
    assertWorkspaceScope(scope);
    if (directory.value !== currentDirectory) throw new Error(translate("工作目录已切换"));
  };
  assertActive();
  await waitForEditor(signal);
  await layoutRestore;
  await opening;
  assertActive();
  return { currentDirectory, assertActive };
}

async function closeDocument(args: Record<string, unknown>, signal: AbortSignal) {
  const { currentDirectory, assertActive } = await documentCommandScope(signal);
  const selection = documentSelection(args, true);
  if (!selection) return { selection: null, closedViews: 0, remainingViews: 0, document: snapshot(undefined, false) };
  const resource = toResource(currentDirectory, selection);
  const matching = () => [...sessions.entries()].filter(([, session]) => sameResource(session.context.resource, resource));
  const targets = matching();
  const closedSelection = targets[0] ? selectionOf(targets[0][1].context.resource) : selection;
  let closedViews = 0;
  for (const [id] of targets) {
    assertActive();
    await closeEditor(id, true, signal);
    if (!sessions.has(id)) closedViews++;
  }
  await nextTick();
  assertActive();
  return { selection: closedSelection, closedViews, remainingViews: matching().length, document: snapshot(currentSession(), false) };
}

async function moveDocument(args: Record<string, unknown>, signal: AbortSignal) {
  const { currentDirectory, assertActive } = await documentCommandScope(signal);
  const resource = currentSession()?.context.resource;
  const path = args.path ?? (resource?.kind === "file" ? resource.path : undefined);
  if (typeof path !== "string") throw new Error(translate("请先打开需要移动的文件文档；画布节点请用画布工具操作"));
  const source = insideWorkspace(path);
  if (typeof args.target !== "string") throw new Error(translate("需要目标文件路径 target"));
  const target = insideWorkspace(args.target);
  assertOrganizableAssetPath(source);
  assertOrganizableAssetPath(target);
  const files = useWorkspaceFiles(currentDirectory);
  let directorySource = false;
  try { directorySource = (await files.stat(source, signal)).mime === "inode/directory"; }
  catch (error) {
    if ((error as { response?: { status?: number } }).response?.status !== 404) throw error;
    // A directory can consist solely of indexed children, without its own row.
    const { entries } = await files.list(undefined, signal);
    if (!entries.some(entry => entry.path.startsWith(source + "/"))) throw error;
    directorySource = true;
  }
  assertActive();
  if (!directorySource && /\.json$/i.test(source) && await isCanvasFile(files, source, signal)) throw new Error(translate("画布文件请使用 renameCanvas 或 moveCanvas"));
  assertActive();
  await props.mutateFiles(currentDirectory, { path: source, target }, signal);
  assertActive();
  return { path: target, previousPath: source, document: snapshot(currentSession(), false) };
}

function getRetainedPaths() {
  return [...new Set(uniqueSessions().flatMap(session => {
    const resource = session.context.resource;
    return resource.kind === "canvasNode" ? [resource.path, `assets/${resource.nodeId}`] : [resource.path];
  }))];
}

defineExpose({ flushSave, flushNodeDocuments, cancelSave, getDocument, openDocument, writeDocument, closeDocument, moveDocument, coordinateWorkspaceFiles, getRetainedPaths, adoptMutationEntries });

// ── 面板激活与快捷键 ───────────────────────────────────────────────────────────
function onDocumentKeydown(event: KeyboardEvent) {
  const target = event.target instanceof Element ? event.target : undefined;
  if (event.isComposing || target?.closest("input, textarea, select, button, [contenteditable]:not([contenteditable='false']), [role='textbox'], [role='slider']")) return;
  if (!active.value || event.altKey || !(event.ctrlKey || event.metaKey)) return;
  if (target && target !== document.body && !target.closest(".documentPanel")) return;
  const api = editorApi.value;
  if (!api) return;
  if (!event.shiftKey && event.key.toLowerCase() === "p") {
    event.preventDefault();
    quickOpenRef.value?.open();
  } else if (event.shiftKey && event.key.toLowerCase() === "f") {
    event.preventDefault();
    searchRef.value?.open();
  } else if (event.shiftKey && event.key.toLowerCase() === "t") {
    event.preventDefault();
    void tabAction("", "reopen").catch(reportError);
  } else if (event.key.toLowerCase() === "w" && api.activePanel) {
    event.preventDefault();
    void closeEditor(api.activePanel.id).catch(reportError);
  } else if (event.key === "Tab" || event.key === "PageDown" || event.key === "PageUp") {
    event.preventDefault();
    const panels = api.panels;
    const index = panels.findIndex((panel) => panel.id === api.activePanel?.id);
    const backwards = event.shiftKey || event.key === "PageUp";
    panels[(index + (backwards ? -1 : 1) + panels.length) % panels.length]?.api.setActive();
  }
}

onActivated(() => {
  active.value = true;
  for (const session of uniqueSessions()) session.context.active = true;
});
onDeactivated(() => {
  active.value = false;
  for (const session of uniqueSessions()) session.context.active = false;
});
watch(directory, () => { activeSelection.value = undefined; });

// 文件树与快速打开用同步快照过滤候选，面板启动时先把清单拉回来。
void listExtensions().catch((error) => reportError(error));

// 扩展请求打开工作区里的另一个文件（ExtContext.openFile 广播的事件）。
function onExtOpenFile(event: Event) {
  const detail = (event as CustomEvent<{ directory?: string; path?: string }>).detail;
  if (!detail?.path || detail.directory !== directory.value) return;
  const path = detail.path;
  void openSelection({ filePath: path, label: path.split("/").at(-1)! }).catch(reportError);
}

window.addEventListener("keydown", onDocumentKeydown, true);
window.addEventListener("miaoimg:ext-open-file", onExtOpenFile);
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onDocumentKeydown, true);
  window.removeEventListener("miaoimg:ext-open-file", onExtOpenFile);
  clearTimeout(layoutTimer);
  saveLayout();
  lifetime.abort(new Error(translate("文档工作区已关闭")));
  cancelSave();
  sessionWatchers.forEach((stop) => stop());
  disposables.forEach((disposable) => disposable.dispose());
});
</script>

<style scoped lang="scss">
.documentPanel {
  display: grid;
  grid-template-columns: 260px minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
  gap: 16px;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  padding: 64px 20px 20px;
  padding-right: calc(20px + var(--agentWidth, 0px));
  overflow: hidden;
  background: var(--el-fill-color-light);

  @media (max-width: 760px) {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(100px, .45fr) minmax(100px, 1fr);
    gap: 8px;
    padding: 64px 12px 12px;
  }

  .treePane,
  .editorSurface {
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    border: 1px solid var(--el-border-color-light);
    border-radius: var(--ui-radius-large, 12px);
    background: var(--el-bg-color-overlay);
    box-shadow: var(--el-box-shadow-lighter);
  }
}
</style>

<style lang="scss">
// dockview 的 DOM 是运行时生成的，拿不到 scoped 属性，主题变量只能写在全局样式里。
.documentPanel .dockviewMiaoimg {
  --dv-background-color: var(--el-bg-color-overlay);
  --dv-group-view-background-color: var(--el-bg-color-overlay);
  --dv-tabs-and-actions-container-background-color: var(--el-fill-color-light);
  --dv-activegroup-visiblepanel-tab-background-color: var(--el-bg-color-overlay);
  --dv-activegroup-hiddenpanel-tab-background-color: var(--el-fill-color-light);
  --dv-inactivegroup-visiblepanel-tab-background-color: var(--el-bg-color-overlay);
  --dv-inactivegroup-hiddenpanel-tab-background-color: var(--el-fill-color-light);
  --dv-activegroup-visiblepanel-tab-color: var(--el-text-color-primary);
  --dv-activegroup-hiddenpanel-tab-color: var(--el-text-color-secondary);
  --dv-inactivegroup-visiblepanel-tab-color: var(--el-text-color-regular);
  --dv-inactivegroup-hiddenpanel-tab-color: var(--el-text-color-secondary);
  --dv-tab-divider-color: var(--el-border-color-light);
  --dv-separator-border: var(--el-border-color);
  --dv-tabs-and-actions-container-height: 35px;
  --dv-drag-over-background-color: var(--el-color-primary-light-8);
  --dv-drag-over-border-color: var(--el-color-primary);

  .dv-tab {
    padding: 0;
  }
  .dv-tab.dv-active-tab {
    border-top: 2px solid var(--el-color-primary);
  }
}
</style>
