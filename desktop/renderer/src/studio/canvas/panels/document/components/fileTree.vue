<template>
  <aside class="fileTree" :aria-label="translate('工作区文件')">
    <header class="treeHeader">
      <span class="treeTitle"><icon-folder :size="16" aria-hidden="true" />{{ translate("工作区文件") }}</span>
      <span class="treeActions">
        <el-button text circle size="small" :disabled="!directory || busy" :aria-label="translate('新建文件')" :title="translate('新建文件')" @click="createEntry(false)">
          <icon-file-plus :size="15" aria-hidden="true" />
        </el-button>
        <el-button text circle size="small" :disabled="!directory || busy" :aria-label="translate('新建文件夹')" :title="translate('新建文件夹')" @click="createEntry(true)">
          <icon-folder-plus :size="15" aria-hidden="true" />
        </el-button>
        <el-button text circle size="small" :disabled="!directory" :aria-label="translate('刷新文件树')" :title="translate('刷新文件树')" @click="refresh">
          <icon-refresh :size="15" aria-hidden="true" />
        </el-button>
      </span>
    </header>
    <div class="treeTools">
      <el-button text circle size="small" :disabled="!directory" :aria-label="translate('快速打开')" :title="translate('快速打开')" @click="emit('quickOpen')">
        <icon-file-search :size="15" />
      </el-button>
      <el-button text circle size="small" :disabled="!directory" :aria-label="translate('全文搜索')" :title="translate('全文搜索')" @click="emit('search')">
        <icon-search :size="15" />
      </el-button>
      <el-button text circle size="small" :disabled="!activeSelection" :aria-label="translate('定位当前标签')" :title="translate('定位当前标签')" @click="locateCurrent">
        <icon-focus-2 :size="15" />
      </el-button>
      <span v-if="clipboard" class="clipboardHint">
        {{ clipboard.cut ? translate("待移动：{0}", { 0: clipboard.item.name }) : translate("待复制：{0}", { 0: clipboard.item.name }) }}
        <el-button text size="small" :aria-label="translate('取消')" @click="clipboard = undefined"><icon-x :size="13" /></el-button>
      </span>
    </div>
    <el-alert v-if="loadError" class="loadError" :title="loadError" type="error" :closable="false" showIcon />
    <div v-loading="loading" class="treeContent">
      <el-tree
        v-if="directory && treeActive"
        ref="treeRef"
        :key="treeVersion"
        lazy
        highlightCurrent
        :load="loadChildren"
        :props="treeProps"
        nodeKey="key"
        :defaultExpandedKeys="expandedKeys"
        :expandOnClickNode="true"
        :emptyText="translate('暂无文件')"
        @node-click="clickItem"
        @node-contextmenu="openMenu"
        @node-expand="item => rememberExpanded(item, true)"
        @node-collapse="item => rememberExpanded(item, false)">
        <template #default="{ node, data }">
          <span class="fileItem" :class="{ activeItem: data.key === activeKey }" :title="itemTitle(data)" @dblclick.stop="openItem(data)">
            <component :is="nodeIcon(data)" :size="16" aria-hidden="true" />
            <span class="fileName">{{ data.name }}</span>
          </span>
        </template>
      </el-tree>
    </div>
    <el-dropdown ref="menu" trigger="contextmenu" virtualTriggering :virtualRef="menuAnchor" placement="bottom-start" :showArrow="false" @command="command => handleCommand(command)">
      <template #dropdown>
        <el-dropdown-menu v-if="menuItem" class="fileActionMenu">
          <el-dropdown-item v-if="isInternalAssetPath(menuItem.path)" disabled>{{ translate('内部文件固定，请复制到普通文件夹后整理') }}</el-dropdown-item>
          <el-dropdown-item v-if="menuItem.type === 'file' && canChooseExtension" command="openWith" :disabled="busy">{{ translate("打开方式…") }}</el-dropdown-item>
          <template v-if="menuItem.type !== 'node'">
            <el-dropdown-item command="newFile" :disabled="busy || isInternalAssetPath(menuItem.path)">{{ translate("新建文件…") }}</el-dropdown-item>
            <el-dropdown-item command="newFolder" :disabled="busy || isInternalAssetPath(menuItem.path)">{{ translate("新建文件夹…") }}</el-dropdown-item>
            <el-dropdown-item command="copy" :disabled="busy" divided>{{ translate("复制") }}</el-dropdown-item>
            <el-dropdown-item command="cut" :disabled="busy || isInternalAssetPath(menuItem.path)">{{ translate("剪切") }}</el-dropdown-item>
            <el-dropdown-item command="paste" :disabled="busy || !clipboard || isInternalAssetPath(menuItem.path)">{{ translate("粘贴") }}</el-dropdown-item>
            <el-dropdown-item command="copyPath" divided>{{ translate("复制路径") }}</el-dropdown-item>
            <el-dropdown-item command="rename" :disabled="busy || isInternalAssetPath(menuItem.path)" divided>{{ translate("重命名") }}</el-dropdown-item>
          </template>
          <el-dropdown-item command="delete" :disabled="busy || isInternalAssetPath(menuItem.path)" :divided="menuItem.type === 'node'" class="deleteAction">{{ translate("删除") }}</el-dropdown-item>
        </el-dropdown-menu>
      </template>
    </el-dropdown>
  </aside>
</template>

<script setup lang="ts">
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, ref, shallowRef, watch, type Component } from "vue";
import type { DropdownInstance, LoadFunction, TreeInstance } from "element-plus";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  IconFile,
  IconFilePlus,
  IconFileSearch,
  IconFileText,
  IconFocus2,
  IconFolder,
  IconFolderPlus,
  IconLayoutDashboard,
  IconRefresh,
  IconSearch,
  IconX,
} from "@tabler/icons-vue";
import { translate } from "@miaoimg/i18n/vue";
import { useWorkspaceContentFiles as useWorkspaceFiles } from "@/lib/workspaceFiles";
import { writeClipboardText } from "@/lib/clipboard";
import { isCanvasFile } from "@/pages/workspace/canvasFile";
import { childPath, parentPath, readCanvasTextNodes, readEntryList, type WorkspaceEntry } from "@/pages/workspace/canvasFiles";
import { candidateExtensions } from "../../../ext";
import { documentError, type DocumentSelection } from "../documentSession";
import { isInternalAssetPath } from "../../../saveCanvasAsset";
import { captureWorkspaceSourceEntries, type WorkspaceSourceEntry } from '@/lib/workspaceFileSelection';

export type FileAction = "create" | "mkdir" | "rename" | "move" | "copy" | "delete" | "openWith";
export type FileTreeItem = { key: string; name: string; path: string; type: "file" | "directory" | "canvas" | "node"; nodeId?: string; isLeaf?: boolean; sourceEntries?: readonly WorkspaceSourceEntry[] };

const props = defineProps<{
  directory?: string;
  activeSelection?: DocumentSelection;
  fileAction: (action: FileAction, item: FileTreeItem, target?: string) => Promise<void>;
}>();
const emit = defineEmits<{ open: [selection: DocumentSelection, preview: boolean]; quickOpen: []; search: [] }>();
const treeProps = { label: "name", isLeaf: "isLeaf" };
const treeRef = ref<TreeInstance>();
const menu = ref<DropdownInstance>();
const menuAnchor = shallowRef({ getBoundingClientRect: () => new DOMRect() });
const menuItem = shallowRef<FileTreeItem>();
const treeVersion = ref(0);
const treeActive = ref(true);
const loading = ref(false);
const loadError = ref("");
const busy = ref(false);
const expandedKeys = ref<string[]>([]);
const clipboard = shallowRef<{ item: FileTreeItem; cut: boolean }>();
// ACT: 工作区接口一次返回全部文件，展开目录时按路径前缀从这份缓存里取子项，不再逐目录请求。
let listing: FileTreeItem[] | undefined;
let sourceInventory: readonly WorkspaceEntry[] = [];
let listingLoad: Promise<FileTreeItem[]> | undefined;
let childrenByParent = new Map<string, FileTreeItem[]>();
const canvasCache = new Map<string, { revision: string; canvas: boolean }>();
const lifetime = new AbortController();
let reading = new AbortController();
type ReadContext = { version: number; directory: string; files: ReturnType<typeof useWorkspaceFiles>; signal: AbortSignal };
function isCurrent(context: Pick<ReadContext, "version" | "directory">) {
  return treeActive.value && !lifetime.signal.aborted && context.version === treeVersion.value && context.directory === props.directory;
}
function assertCurrent(context: Pick<ReadContext, "version" | "directory">) {
  if (!isCurrent(context)) throw new DOMException("File tree changed", "AbortError");
}

function keyOf(type: string, path: string) {
  return JSON.stringify([type, path]);
}

const activeKey = computed(() => {
  const selection = props.activeSelection;
  if (!selection) return "";
  return "filePath" in selection ? keyOf("file", selection.filePath) : keyOf("node", `${selection.canvasPath}\0${selection.nodeId}`);
});

async function createItem(entry: WorkspaceEntry, context: ReadContext): Promise<FileTreeItem> {
  const canvas = entry.type === "file" && /\.json$/i.test(entry.path) && await isCanvas(entry, context);
  return {
    key: keyOf(canvas ? "canvas" : entry.type, entry.path),
    name: entry.name,
    path: entry.path,
    type: canvas ? "canvas" : entry.type,
    isLeaf: entry.type === "file" && !canvas,
  };
}

async function isCanvas(entry: WorkspaceEntry, context: ReadContext) {
  const cached = canvasCache.get(entry.path);
  if (entry.revision && cached?.revision === entry.revision) return cached.canvas;
  const result = await isCanvasFile(context.files, entry.path, context.signal);
  assertCurrent(context);
  if (result === undefined) return false;
  if (entry.revision) canvasCache.set(entry.path, { revision: entry.revision, canvas: result });
  return result;
}

async function allItems(context: ReadContext) {
  assertCurrent(context);
  if (listing) return listing;
  if (listingLoad) return listingLoad;
  const pending = (async () => {
    const entries = await readEntryList(context.files, context.signal);
    assertCurrent(context);
    const items = await Promise.all(entries.map((entry) => createItem(entry, context)));
    assertCurrent(context);
    // 直接在子路径写文件不会建出上级目录行，这里把缺失的中间目录补出来。
    const known = new Set(items.map((item) => item.path));
    const missing: FileTreeItem[] = [];
    for (const item of items) {
      const absent: string[] = [];
      let parent = parentPath(item.path);
      while (parent && !known.has(parent)) {
        known.add(parent);
        absent.push(parent);
        parent = parentPath(parent);
      }
      for (const path of absent.reverse()) missing.push({ key: keyOf("directory", path), name: path.split("/").at(-1)!, path, type: "directory" });
    }
    const live = new Set(entries.map(entry => entry.path));
    for (const path of canvasCache.keys()) if (!live.has(path)) canvasCache.delete(path);
    const children = new Map<string, FileTreeItem[]>();
    listing = [...items, ...missing];
    sourceInventory = entries;
    for (const item of listing) {
      const parent = parentPath(item.path), siblings = children.get(parent) ?? [];
      siblings.push(item);
      children.set(parent, siblings);
    }
    childrenByParent = children;
    return listing;
  })();
  listingLoad = pending;
  try { return await pending; }
  finally { if (listingLoad === pending) listingLoad = undefined; }
}

function childrenOf(path: string) {
  return childrenByParent.get(path) ?? [];
}

function refresh() {
  menu.value?.handleClose();
  menuItem.value = undefined;
  reading.abort();
  reading = new AbortController();
  listing = undefined;
  sourceInventory = [];
  listingLoad = undefined;
  childrenByParent.clear();
  loading.value = false;
  loadError.value = "";
  treeVersion.value++;
}

const loadChildren: LoadFunction = async (node, resolve, reject) => {
  const version = treeVersion.value;
  const directory = props.directory;
  if (!directory || !treeActive.value || lifetime.signal.aborted) return reject();
  const context = { version, directory, files: useWorkspaceFiles(directory), signal: reading.signal };
  const path = node.level === 0 ? "" : (node.data as FileTreeItem).path;
  loading.value = true;
  try {
    let items: FileTreeItem[];
    if (node.level > 0 && (node.data as FileTreeItem).type === "canvas") {
      items = (await readCanvasTextNodes(context.files, path, context.signal)).map((child): FileTreeItem => ({
        key: keyOf("node", `${path}\0${child.nodeId}`),
        name: child.label,
        path,
        type: "node",
        nodeId: child.nodeId,
        isLeaf: true,
      }));
    } else {
      await allItems(context);
      items = childrenOf(path);
    }
    if (!isCurrent(context)) return reject();
    resolve(items);
  } catch (error) {
    if (isCurrent(context)) loadError.value = translate("读取{0}失败：{1}。可重新展开目录或刷新重试。", { 0: path || translate("工作区"), 1: documentError(error) });
    reject();
  } finally {
    if (version === treeVersion.value) loading.value = false;
  }
};

// 画布节点行只列有文本输出的节点，统一用文本图标。
function nodeIcon(item: FileTreeItem): Component {
  if (item.type === "canvas") return IconLayoutDashboard;
  if (item.type === "node") return IconFileText;
  if (item.type === "directory") return IconFolder;
  return IconFile;
}

function itemTitle(item: FileTreeItem) {
  return item.type === "node" ? `${item.name}\nID: ${item.nodeId}\n${item.path}` : item.path;
}

function selectionOf(item: FileTreeItem): DocumentSelection | undefined {
  if (item.type === "node" && item.nodeId) return { canvasPath: item.path, nodeId: item.nodeId, label: item.name };
  if (item.type === "file") return { filePath: item.path, label: item.name };
  return undefined;
}

// 目录与画布靠 el-tree 自己展开；文件和节点单击是预览标签，双击固定下来。
function clickItem(item: FileTreeItem) {
  const selection = selectionOf(item);
  if (selection) emit("open", selection, true);
}

function openItem(item: FileTreeItem) {
  const selection = selectionOf(item);
  if (selection) emit("open", selection, false);
}

function rememberExpanded(item: FileTreeItem, expanded: boolean) {
  expandedKeys.value = expanded
    ? [...new Set([...expandedKeys.value, item.key])]
    : expandedKeys.value.filter((key) => key !== item.key);
}

async function locateCurrent() {
  const selection = props.activeSelection;
  if (!selection) return;
  const path = "filePath" in selection ? selection.filePath : selection.canvasPath;
  const parts = path.split("/");
  const keys = parts.slice(0, -1).map((_part, index) => keyOf("directory", parts.slice(0, index + 1).join("/")));
  if ("canvasPath" in selection) keys.push(keyOf("canvas", selection.canvasPath));
  expandedKeys.value = [...new Set([...expandedKeys.value, ...keys])];
  treeVersion.value++;
  // 懒加载目录是异步展开的，目标行出现后再定位并滚动到它。
  const key = activeKey.value;
  for (let attempt = 0; attempt < 5; attempt++) {
    await nextTick();
    await new Promise((done) => setTimeout(done, 80));
    if (treeRef.value?.getNode(key)) {
      treeRef.value.setCurrentKey(key);
      document.querySelector(`.fileTree [data-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: "nearest" });
      return;
    }
  }
}

async function openMenu(event: MouseEvent, item: FileTreeItem) {
  const context = { version: treeVersion.value, directory: props.directory || "" };
  menu.value?.handleClose();
  menuItem.value = item;
  menuAnchor.value = { getBoundingClientRect: () => new DOMRect(event.clientX, event.clientY, 0, 0) };
  await nextTick();
  if (isCurrent(context) && menuItem.value === item) menu.value?.handleOpen();
}

const canChooseExtension = computed(() => {
  const item = menuItem.value;
  const directory = props.directory;
  return !!item && !!directory && candidateExtensions({ kind: "file", directory, path: item.path, label: item.name }).length > 1;
});

function validName(name: string | undefined, item?: FileTreeItem) {
  const value = name?.trim() ?? "";
  if (!value || /[\\/\0]/.test(value) || [".", ".."].includes(value)) return translate("请输入有效名称，不能包含斜杠");
  if (item?.type === "canvas" && !value.toLowerCase().endsWith(".json")) return translate("画布文件须保留 .json 后缀");
  return true;
}

async function promptName(title: string, label: string, value: string, item?: FileTreeItem) {
  try {
    const result = await ElMessageBox.prompt(label, title, {
      inputValue: value,
      inputValidator: (name) => validName(name, item),
      confirmButtonText: translate("保存"),
      cancelButtonText: translate("取消"),
    });
    return result.value.trim();
  } catch {
    return undefined;
  }
}

// 工具栏按钮在根目录新建；右键菜单把目标目录显式传进来，不看残留的 menuItem。
async function createEntry(folder: boolean, target?: FileTreeItem) {
  const directory = props.directory;
  if (!directory || busy.value) return;
  const context = { version: treeVersion.value, directory };
  const destination = target && target.type === "directory" && target.path ? target.path : "";
  // 默认名会直接落成磁盘上的名字，不走 translate，避免把界面语言写进文件名。
  const name = await promptName(
    folder ? translate("新建文件夹") : translate("新建文件"),
    translate("在“{0}”中新建{1}", { 0: destination || translate("工作区根目录"), 1: folder ? translate("文件夹") : translate("文件") }),
    folder ? "新建文件夹" : "文档.md");
  if (!name || !isCurrent(context)) return;
  const finalName = folder || /\.[^.]+$/.test(name) ? name : `${name}.md`;
  const path = childPath(destination, finalName);
  await run(async () => {
    await props.fileAction(folder ? "mkdir" : "create", { key: keyOf(folder ? "directory" : "file", path), name: finalName, path, type: folder ? "directory" : "file" });
    assertCurrent(context);
    expandedKeys.value = [...new Set([...expandedKeys.value, ...ancestorKeys(path)])];
    refresh();
    // 新建的文本文件直接按预览标签打开，省去再点一次。
    if (!folder) {
      const selection: DocumentSelection = { filePath: path, label: finalName };
      if (candidateExtensions({ kind: "file", directory, path, label: finalName }).length) emit("open", selection, true);
    }
  });
}

function ancestorKeys(path: string) {
  const parts = path.split("/");
  return parts.slice(0, -1).map((_part, index) => keyOf("directory", parts.slice(0, index + 1).join("/")));
}

function selectedItem(item: FileTreeItem): FileTreeItem {
  return item.type === 'node' ? item : { ...item, sourceEntries: captureWorkspaceSourceEntries(sourceInventory, item.path) };
}

async function rename(original: FileTreeItem) {
  let item: FileTreeItem;
  try { item = selectedItem(original); } catch (error) { ElMessage.error(documentError(error)); return; }
  const context = { version: treeVersion.value, directory: props.directory || "" };
  const name = await promptName(translate("重命名"), translate("名称"), item.name, item);
  if (!name || name === item.name || !isCurrent(context)) return;
  const target = childPath(parentPath(item.path), name);
  await run(async () => {
    await props.fileAction("rename", item, target);
    assertCurrent(context);
    relocateExpansion(item.path, target);
    refresh();
  });
}

function relocateExpansion(source: string, target: string) {
  expandedKeys.value = expandedKeys.value.flatMap((key) => {
    try {
      const parts = JSON.parse(key) as string[];
      const path = parts[1]!;
      if (path !== source && !path.startsWith(`${source}/`)) return [key];
      parts[1] = target + path.slice(source.length);
      return [JSON.stringify(parts)];
    } catch {
      return [];
    }
  });
}

async function paste(destination: string) {
  const source = clipboard.value;
  const directory = props.directory;
  if (!source || !directory) return;
  const context = { version: treeVersion.value, directory };
  const identity = (path: string) => path.replace(/\/+$/, "");
  if (source.item.type === "directory" && (identity(destination) === identity(source.item.path) || identity(destination).startsWith(`${identity(source.item.path)}/`))) {
    ElMessage.error(translate("不能将文件夹粘贴到自身或其子目录"));
    return;
  }
  let name = source.item.name;
  if (!source.cut) {
    const dot = source.item.type === "directory" ? -1 : name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const suffix = dot > 0 ? name.slice(dot) : "";
    const taken = new Set(childrenOf(destination).map((child) => child.name));
    for (let index = 1; taken.has(name); index++) name = `${stem} 副本${index === 1 ? "" : ` ${index}`}${suffix}`;
  }
  const target = childPath(destination, name);
  if (target === source.item.path) return;
  await run(async () => {
    await props.fileAction(source.cut ? "move" : "copy", source.item, target);
    assertCurrent(context);
    if (source.cut) {
      relocateExpansion(source.item.path, target);
      clipboard.value = undefined;
    }
    refresh();
  });
}

async function remove(original: FileTreeItem) {
  let item: FileTreeItem;
  try { item = selectedItem(original); } catch (error) { ElMessage.error(documentError(error)); return; }
  const context = { version: treeVersion.value, directory: props.directory || "" };
  try {
    await ElMessageBox.confirm(
      translate("删除“{0}”？{1}{2}", { 0: item.name, 1: item.type === "node" ? translate("该节点会从画布中删除。") : item.type === "directory" || item.type === "canvas" ? translate("所选文件夹的全部内容、画布的全部节点会一并删除。") : "", 2: item.type === "node" ? translate("可在该画布中撤销。") : translate("此操作不可恢复。") }),
      item.type === "node" ? translate("删除节点") : translate("删除文件"),
      { type: "warning", confirmButtonText: translate("删除"), cancelButtonText: translate("取消"), closeOnClickModal: false });
  } catch {
    return;
  }
  if (!isCurrent(context)) return;
  await run(async () => {
    await props.fileAction("delete", item);
    assertCurrent(context);
    clipboard.value = undefined;
    refresh();
  });
}

async function run(task: () => Promise<void>) {
  const context = { version: treeVersion.value, directory: props.directory || "" };
  if (!context.directory || !isCurrent(context) || busy.value) return;
  busy.value = true;
  loadError.value = "";
  try {
    await task();
  } catch (error) {
    if (isCurrent(context)) ElMessage.error(documentError(error));
  } finally {
    busy.value = false;
  }
}

function destinationOf(item: FileTreeItem) {
  return item.type === "directory" ? item.path : parentPath(item.path);
}

async function handleCommand(command: string) {
  const item = menuItem.value;
  const directory = props.directory;
  menu.value?.handleClose();
  if (!item || !directory || busy.value) return;
  if (command === "newFile") return createEntry(false, item);
  if (command === "newFolder") return createEntry(true, item);
  if (command === "copyPath") return void writeClipboardText(item.path || ".");
  if (command === "copy" || command === "cut") {
    if (item.type === "node") return;
    try { clipboard.value = { item: selectedItem(item), cut: command === "cut" }; }
    catch (error) { ElMessage.error(documentError(error)); }
    return;
  }
  if (command === "paste") return paste(destinationOf(item));
  if (command === "rename") return rename(item);
  if (command === "delete") return remove(item);
  if (command === "openWith") return run(() => props.fileAction("openWith", item));
}

watch(() => props.directory, () => {
  clipboard.value = undefined;
  menuItem.value = undefined;
  expandedKeys.value = [];
  canvasCache.clear();
  refresh();
}, { flush: "sync" });
onDeactivated(() => {
  treeActive.value = false;
  reading.abort();
  listingLoad = undefined;
  menu.value?.handleClose();
});
onActivated(() => {
  // The canvas can change while this panel is cached (undo, another canvas or
  // an Agent command). Refresh once on return rather than polling while hidden.
  if (treeActive.value) return;
  treeActive.value = true;
  refresh();
});
onBeforeUnmount(() => {
  lifetime.abort();
  reading.abort();
  menu.value?.handleClose();
  listing = undefined;
  listingLoad = undefined;
  childrenByParent.clear();
  canvasCache.clear();
});

defineExpose({ refresh });
</script>

<style scoped lang="scss">
.fileTree {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  min-width: 0;
  min-height: 0;
  height: 100%;
  overflow: hidden;
  background: var(--docSurface);
  color: var(--el-text-color-regular);

  .treeHeader {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: space-between;
    padding: 8px 10px 6px;
    font-size: 12px;

    .treeTitle {
      display: flex;
      align-items: center;
      gap: 7px;
      color: var(--el-text-color-primary);
      font-weight: 600;
    }
    .treeActions {
      display: flex;
      align-items: center;
      gap: 2px;
    }
    .el-button {
      width: 24px;
      height: 24px;
      padding: 0;
    }
  }

  .treeTools {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px;
    padding: 0 8px 8px;

    :deep(.el-button) {
      margin-left: 0;
      flex-shrink: 0;
    }
    .clipboardHint {
      display: flex;
      flex: 1 1 100%;
      align-items: center;
      gap: 2px;
      color: var(--el-text-color-secondary);
      font-size: 11px;
    }
  }

  .loadError {
    flex-shrink: 0;
    margin-bottom: 8px;
  }

  .treeContent {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 0 6px 8px;
    overscroll-behavior: contain;

    :deep(.el-tree) {
      background: transparent;
    }
    :deep(.el-tree-node__content) {
      height: 28px;
      border-radius: var(--el-border-radius-base);
    }

    .fileItem {
      display: flex;
      align-items: center;
      gap: 7px;
      min-width: 0;
      padding-right: 6px;
      font-size: 13px;

      &.activeItem {
        color: var(--el-color-primary);
        font-weight: 600;
      }
      svg {
        flex-shrink: 0;
        color: var(--el-text-color-secondary);
      }
      .fileName {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    }
  }
}

.fileActionMenu {
  min-width: 170px;

  .deleteAction {
    color: var(--el-color-danger);
  }
}
</style>
