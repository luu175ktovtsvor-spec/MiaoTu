<template>
  <teleport to="body">
  <section v-if="panelVisible" ref="libraryPanel" class="assetLibraryPanel" :style="panelStyle"
    @pointermove="movePanel" @pointerup="stopPanelMove" @pointercancel="stopPanelMove" @lostpointercapture="stopPanelMove">
  <el-card class="assetLibrary" shadow="never" :bodyStyle="{ padding: '8px' }" role="region" :aria-label="translate('素材库')" @dblclick.stop>
    <header class="libraryHeader" tabindex="0" :aria-label="translate('素材库')" @pointerdown="startPanelMove" @keydown="movePanelWithKeyboard">
      <span>{{ translate('素材库') }}</span>
      <el-button class="toolbarButton" text :icon="IconX" :title="translate('关闭素材库')" :aria-label="translate('关闭素材库')" @click="visible = false" />
    </header>
    <div class="libraryToolbar">
      <el-input v-model="searchQuery" class="searchInput" :prefixIcon="IconSearch" :placeholder="translate('搜索素材')" :aria-label="translate('搜索素材')" clearable @keydown.esc.stop="searchQuery = ''" />
      <el-button class="toolbarButton" text :icon="IconFolderPlus" :title="translate('新建文件夹')" :aria-label="translate('新建文件夹')" :disabled="newFolderParent !== undefined || isInternalAssetPath(folder)" @click="startFolder" />

    </div>
    <el-scrollbar class="libraryScroll" maxHeight="min(440px, calc(100dvh - 198px))">
      <el-tree ref="assetTree" class="assetTree" :data="displayEntries" nodeKey="path" :props="{ label: 'name' }" :currentNodeKey="folder === '.' ? undefined : folder" :filterNodeMethod="filterEntry" defaultExpandAll highlightCurrent emptyText="" @nodeClick="selectFolder">
        <template #default="{ data }">
          <div class="assetEntry" :title="entryTitle(data)" :draggable="data.type === 'file'" @dragstart.stop="startAssetDrag($event, data)" @dblclick.stop="openPreview(data)" @contextmenu="openItemMenu($event, data)">
            <icon-folder-filled v-if="data.type === 'directory'" class="folderIcon" :size="30" />
            <el-image v-else-if="mediaKind(data) === 'image'" class="assetThumbnail" :src="assetUrl(data.path)" fit="cover" loading="lazy" draggable="false" @click.stop="openPreview(data)">
              <template #error><icon-photo :size="22" /></template>
            </el-image>
            <span v-else class="fileIcon">
              <icon-music v-if="mediaKind(data) === 'audio'" :size="24" />
              <icon-video v-else-if="mediaKind(data) === 'video'" :size="24" />
              <icon-file v-else :size="24" />
            </span>
            <el-input v-if="data.draft" ref="folderInput" v-model="newFolderName" class="folderNameInput" size="small" :aria-label="translate('文件夹名称')" :disabled="folderSaving" @click.stop @keydown.stop @keydown.enter.prevent="saveFolder" @keydown.esc.prevent="cancelFolder" @blur="saveFolder" />
            <span v-else class="assetName">{{ data.name }}</span>
            <el-button v-if="mediaKind(data)" class="moreButton" text :icon="IconEye" :aria-label="translate('预览 {0}', { 0: data.name })" :title="translate('预览（也可双击素材）')" @click.stop="openPreview(data)" />
            <el-button v-if="!data.draft" class="moreButton" text :icon="IconDots" :aria-label="translate('更多 {0}', { 0: data.name })" :title="translate('更多')" @click.stop="openItemMenu($event, data)" />
          </div>
        </template>
      </el-tree>
    </el-scrollbar>
    <div v-if="previewAsset?.kind === 'audio'" class="audioPreview">
      <div class="audioHeader">
        <span :title="previewAsset.name">{{ previewAsset.name }}</span>
        <el-button text :icon="IconX" :aria-label="translate('关闭音频预览')" @click="previewAsset = undefined" />
      </div>
      <feedbackNotice v-if="previewError" :message="previewError" @close="previewError = ''" />
      <audio v-else :key="previewAsset.url" :src="previewAsset.url" :aria-label="previewAsset.name" controls preload="metadata" @error="previewError = translate('音频无法播放，文件可能已损坏或当前浏览器不支持其编码。')" />
    </div>
  </el-card>
  </section>
  </teleport>

  <assetMenu v-if="panelVisible" ref="assetMenuRef" :entries="entries" :inventory="sourceInventory" :directory="props.directory" @changed="refreshAssets" @save="openSaveFile" />

  <el-image-viewer v-if="previewAsset?.kind === 'image'" :urlList="[previewAsset.url]" teleported @close="previewAsset = undefined" />

  <el-dialog :modelValue="previewAsset?.kind === 'video'" :title="previewAsset?.name" width="min(800px, calc(100vw - 32px))" alignCenter appendToBody destroyOnClose @update:modelValue="previewAsset = undefined">
    <div v-if="previewAsset?.kind === 'video'" class="assetPreview">
      <feedbackNotice v-if="previewError" :message="previewError" @close="previewError = ''" />
      <video v-else :key="previewAsset.url" class="previewVideo" :src="workspacePlaybackUrl(previewAsset.url)" :aria-label="previewAsset.name" controls playsinline preload="metadata" @error="previewError = translate('视频无法播放，文件可能已损坏或当前浏览器不支持其编码。')" />
    </div>
  </el-dialog>

  <el-dialog v-model="saveVisible" :title="translate('保存到素材库')" width="460px" alignCenter appendToBody :closeOnClickModal="false" @opened="assetNameInput?.select()">
    <el-form class="saveForm" labelPosition="top" @submit.prevent="saveAsset">
      <el-form-item :label="translate('素材名称')">
        <el-input ref="assetNameInput" v-model="assetName" :aria-label="translate('素材名称')" :placeholder="translate('输入完整文件名')" :disabled="saving" @keydown.enter.prevent="saveAsset" />
      </el-form-item>
      <el-form-item v-if="outputs.length > 1" :label="translate('节点输出')">
        <el-select v-model="selectedOutput" :aria-label="translate('节点输出')" :disabled="saving">
          <el-option v-for="(item, index) in outputs" :key="index" :label="item.label" :value="index" />
        </el-select>
      </el-form-item>
      <div class="saveLocation">
        <div class="locationHeader">
          <span>{{ translate('保存位置') }}</span>
          <el-button text :icon="IconFolderPlus" :disabled="saving || saveFolderName !== undefined" @click="startSaveFolder">{{ translate('新建文件夹') }}</el-button>
        </div>
        <div class="locationPath" :title="saveLocationLabel">{{ saveLocationLabel }}</div>
        <el-scrollbar class="saveFolderScroll" maxHeight="220px">
          <el-tree class="saveFolderTree" :data="folders" nodeKey="path" :props="{ label: 'name' }" :currentNodeKey="saveDirectory" :expandOnClickNode="false" defaultExpandAll highlightCurrent @nodeClick="(entry: AssetEntry) => { if (!saving && saveFolderName === undefined) saveDirectory = entry.path; }">
            <template #default="{ data }">
              <span class="saveFolderEntry"><icon-folder-filled :size="20" /><span>{{ data.name }}</span></span>
            </template>
          </el-tree>
        </el-scrollbar>
        <div v-if="saveFolderName !== undefined" class="createFolderRow">
          <el-input ref="saveFolderInput" v-model="saveFolderName" :aria-label="translate('新文件夹名称')" :disabled="folderSaving" @keydown.enter.prevent="createFolder" @keydown.esc.stop="saveFolderName = undefined" />
          <el-button :loading="folderSaving" :disabled="!saveFolderName.trim()" @click="createFolder">{{ translate('创建') }}</el-button>
          <el-button text :disabled="folderSaving" @click="saveFolderName = undefined">{{ translate('取消') }}</el-button>
        </div>
      </div>
    </el-form>
    <template #footer>
      <el-button :disabled="saving" @click="saveVisible = false">{{ translate('取消') }}</el-button>
      <el-button type="primary" :loading="saving" :disabled="!assetName.trim() || /[\\/]/.test(assetName) || saveFolderName !== undefined" @click="saveAsset">{{ translate('保存') }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import feedbackNotice from "./feedbackNotice.vue";
import { saveCanvasAsset, saveWorkspaceAsset, isInternalAssetPath, createAssetFolder as createFolderPath, type AssetOutput } from "../saveCanvasAsset";
import { assetFileType } from "../assetFile";
import { isCanvasFile } from "@/pages/workspace/canvasFile";
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { ElMessage, ElTree, type InputInstance, type TreeNodeData } from "element-plus";
import { IconDots, IconEye, IconFile, IconFolderFilled, IconFolderPlus, IconMusic, IconPhoto, IconSearch, IconVideo, IconX } from "@tabler/icons-vue";
import { useVueFlow } from "@vue-flow/core";
import { startAssetDrag } from "../canvasDrop";
import { useWorkspaceContentFiles as useWorkspaceFiles, workspacePlaybackUrl } from "@/lib/workspaceFiles";
import { workspaceSourceRevision, type WorkspaceSourceEntry } from "@/lib/workspaceFileSelection";
import assetMenu from "./assetMenu.vue";
import { translate } from "@miaoimg/i18n/vue";

type AssetEntry = { name: string; path: string; type: "file" | "directory"; rawName?: string; mime?: string; updatedAt?: string; nodeId?: string; children?: AssetEntry[]; draft?: boolean };

const props = defineProps<{ directory?: string; active?: boolean; flowId?: string }>();
const visible = defineModel<boolean>({ default: false });
const panelVisible = computed(() => visible.value && props.active !== false);
const flow = useVueFlow(props.flowId);
const files = useWorkspaceFiles(props.directory || "");
const lifetime = new AbortController();
onBeforeUnmount(() => lifetime.abort());
// 面板在视口坐标中移动，与 VueFlow 的缩放和顶部菜单布局分离。
const libraryPanel = ref<HTMLElement>();
const panelLeft = ref(15);
const panelTop = ref(0);
const panelStyle = computed(() => ({ left: `${panelLeft.value}px`, top: `${panelTop.value}px` }));
let positioned = false;
const panelMove = shallowRef<{ pointerId: number; element: HTMLElement; x: number; y: number; left: number; top: number }>();
function clampPanel(left = panelLeft.value, top = panelTop.value) {
  const rect = libraryPanel.value?.getBoundingClientRect();
  if (!rect) return;
  const workspaceTop = Math.max(0, document.querySelector(".workspacePage")?.getBoundingClientRect().top ?? 0);
  panelLeft.value = Math.max(8, Math.min(left, Math.max(8, window.innerWidth - rect.width - 8)));
  const menuBottom = document.querySelector(".canvasRuntime:not(.backgroundCanvas) .canvasMenu")?.getBoundingClientRect().bottom;
  const maxTop = Math.max(workspaceTop + 8, window.innerHeight - rect.height - 8);
  // 窗口变窄后顶部工具换成两排，悬浮素材库也必须让出新的工具高度。
  const minTop = Math.min(maxTop, (menuBottom || workspaceTop + (window.innerWidth <= 900 ? 108 : 64)) + 8);
  panelTop.value = Math.max(minTop, Math.min(top, maxTop));
}
function startPanelMove(event: PointerEvent) {
  if (event.button !== 0 || panelMove.value || (event.target as HTMLElement).closest("button, input, a")) return;
  event.preventDefault();
  const element = event.currentTarget as HTMLElement;
  element.setPointerCapture(event.pointerId);
  panelMove.value = { pointerId: event.pointerId, element, x: event.clientX, y: event.clientY, left: panelLeft.value, top: panelTop.value };
}
function movePanel(event: PointerEvent) {
  const move = panelMove.value;
  if (move?.pointerId === event.pointerId) clampPanel(move.left + event.clientX - move.x, move.top + event.clientY - move.y);
}
function stopPanelMove(event?: PointerEvent) {
  const move = panelMove.value;
  if (event && move?.pointerId !== event.pointerId) return;
  panelMove.value = undefined;
  if (move?.element.hasPointerCapture(move.pointerId)) move.element.releasePointerCapture(move.pointerId);
}
function movePanelWithKeyboard(event: KeyboardEvent) {
  if (event.target !== event.currentTarget) return;
  const delta = { ArrowLeft: [-16, 0], ArrowRight: [16, 0], ArrowUp: [0, -16], ArrowDown: [0, 16] }[event.key];
  if (!delta) return;
  event.preventDefault(); clampPanel(panelLeft.value + delta[0]!, panelTop.value + delta[1]!);
}
const panelObserver = new ResizeObserver(() => clampPanel());
const resizePanel = () => { stopPanelMove(); clampPanel(); };
window.addEventListener("resize", resizePanel);
watch(panelVisible, async opened => {
  stopPanelMove(); panelObserver.disconnect();
  if (!opened) return;
  await nextTick();
  if (!panelVisible.value || !libraryPanel.value) return;
  if (!positioned) {
    panelTop.value = (document.querySelector(".workspacePage")?.getBoundingClientRect().top ?? 0) + (window.innerWidth <= 900 ? 108 : 64);
    positioned = true;
  }
  clampPanel(); panelObserver.observe(libraryPanel.value);
}, { flush: "post" });
onBeforeUnmount(() => { stopPanelMove(); panelObserver.disconnect(); window.removeEventListener("resize", resizePanel); });
const saveVisible = ref(false);
const saving = ref(false);
const entries = ref<AssetEntry[]>([]);
const sourceInventory = shallowRef<readonly { path: string; revision?: string }[]>([]);
const folder = ref(".");
const assetName = ref("");
const assetNameInput = ref<InputInstance>();
const saveDirectory = ref(".");
const saveFolderName = ref<string>();
const saveFolderInput = ref<InputInstance>();
const saveLocationLabel = computed(() => saveDirectory.value === "." ? "素材库" : `素材库 / ${displayPath(saveDirectory.value)}`);
const searchQuery = ref("");
const assetTree = ref<InstanceType<typeof ElTree>>();
const folderInput = ref<InputInstance>();
const newFolderParent = ref<string>();
const newFolderName = ref("");
const folderSaving = ref(false);
const assetMenuRef = ref<InstanceType<typeof assetMenu>>();
const previewAsset = ref<{ name: string; url: string; kind: "image" | "audio" | "video" }>();
const previewError = ref("");
let loadRequest = 0;
const canvasHeaders = new Map<string, { revision: string; canvas: boolean }>();
onBeforeUnmount(() => { loadRequest++; });

function assetUrl(path: string) {
  return files.url(path);
}

function mediaKind(entry: AssetEntry) {
  if (entry.type !== "file" || entry.draft) return;
  const name = entry.rawName || entry.name;
  if (entry.mime?.startsWith("image/") || /\.(avif|apng|bmp|gif|ico|jpe?g|png|svg|webp)$/i.test(name)) return "image";
  if (entry.mime?.startsWith("audio/") || /\.(mp3|wav|ogg|opus|flac|m4a|aac)$/i.test(name)) return "audio";
  if (entry.mime?.startsWith("video/") || /\.(mp4|m4v|webm|mov|mkv|avi|ogv)$/i.test(name)) return "video";
}

function entryTitle(entry: AssetEntry) { return `${entry.name}\n${entry.path}`; }

function nodeLabel(nodeId: string) {
  const node = flow.findNode(nodeId);
  const value = node?.data?.label ?? node?.label;
  return typeof value === "string" && value.trim() && !/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(value) ? value.trim() : undefined;
}

function localTime(value?: string) {
  if (!value) return "时间未知";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "时间未知" : new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function mediaLabel(entry: AssetEntry) {
  const kind = mediaKind(entry);
  return kind === "image" ? translate("图片") : kind === "video" ? translate("视频") : kind === "audio" ? translate("音频") : translate("文件");
}

function isUploadNode(nodeId: string, rawName: string) {
  const node = flow.findNode(nodeId);
  const label = String(node?.data?.label ?? node?.label ?? "");
  return /^remote-(image|video|audio|text)Node$/i.test(node?.type || "") && /\.[a-z0-9]{1,12}$/i.test(label) && label.toLocaleLowerCase().endsWith((rawName.match(/\.[a-z0-9]{1,12}$/i)?.[0] || "").toLocaleLowerCase());
}

function displayPath(path: string) {
  const flatten = (items: AssetEntry[]): AssetEntry[] => items.flatMap(item => [item, ...flatten(item.children || [])]);
  const entry = flatten(entries.value).find(item => item.path === path);
  return entry ? path.split("/").map((part, index, parts) => parts.slice(0, index + 1).join("/") === path ? entry.name : part).join(" / ") : path.split("/").join(" / ");
}

function openPreview(entry: AssetEntry) {
  const kind = mediaKind(entry);
  if (!kind) return;
  previewError.value = "";
  previewAsset.value = { name: entry.name, url: assetUrl(entry.path), kind };
}

function openItemMenu(event: MouseEvent, entry: AssetEntry) {
  if (entry.draft) return;
  event.preventDefault();
  event.stopPropagation();
  assetMenuRef.value?.openMenu(event, entry);
}

async function refreshAssets(path?: string, target?: string) {
  if (path && (folder.value === path || folder.value.startsWith(path + "/"))) {
    folder.value = target ? target + folder.value.slice(path.length) : ".";
  }
  try { await loadEntries(); } catch (error) { showError(error); }
}
const displayEntries = computed(() => {
  function withDraft(items: AssetEntry[], parent: string): AssetEntry[] {
    const children = items.map(item => item.children ? { ...item, children: withDraft(item.children, item.path) } : item);
    if (newFolderParent.value === parent) children.push({ name: "新建文件夹", path: `${parent}/:newFolder`, type: "directory", draft: true });
    return children;
  }
  return newFolderParent.value === undefined ? entries.value : withDraft(entries.value, ".");
});

function filterEntry(query: string, entry: TreeNodeData) {
  const needle = query.trim().toLocaleLowerCase();
  return !!entry.draft || `${entry.name} ${entry.path}`.toLocaleLowerCase().includes(needle);
}

watch(searchQuery, query => assetTree.value?.filter(query));

async function startFolder() {
  searchQuery.value = "";
  newFolderParent.value = folder.value;
  newFolderName.value = "新建文件夹";
  await nextTick();
  assetTree.value?.getNode(folder.value)?.expand();
  await nextTick();
  folderInput.value?.select();
}

function cancelFolder() {
  newFolderParent.value = undefined;
}

async function saveFolder() {
  if (newFolderParent.value === undefined || folderSaving.value) return;
  const name = newFolderName.value.trim();
  if (!name) return cancelFolder();
  const parent = newFolderParent.value;
  folderSaving.value = true;
  try {
    await createAssetFolder(parent, name);
    cancelFolder();
    await loadEntries();
    folder.value = parent;
  } catch (error) {
    showError(error);
    await nextTick();
    folderInput.value?.focus();
  } finally {
    folderSaving.value = false;
  }
}

const outputs = ref<AssetOutput[]>([]);
const sourceAsset = ref<{ name: string; path: string; revision?: string }>();
const selectedOutput = ref(0);
const folders = computed<AssetEntry[]>(() => [{ name: translate("素材库根目录"), path: ".", type: "directory", children: directoryEntries(entries.value) }]);
const extension = computed(() => {
  if (sourceAsset.value) return sourceAsset.value.path.match(/\.[^./\\]+$/)?.[0] ?? "";
  const output = outputs.value[selectedOutput.value]?.output;
  if (!output) return "";
  if (typeof output.value !== "object") {
    if (output.dataType !== "STRING") return ".json";
    return outputs.value[selectedOutput.value]?.sourcePath ? ".md" : ".txt";
  }
  return output.value.url.match(/\.[^./\\]+$/)?.[0] ?? "";
});

function directoryEntries(items: AssetEntry[]): AssetEntry[] {
  return items.filter(item => item.type === "directory" && !isInternalAssetPath(item.path)).map(item => ({ ...item, children: directoryEntries(item.children ?? []) }));
}

function withExtension(name: string, rawName: string) {
  const extension = rawName.match(/\.[a-z0-9]{1,12}$/i)?.[0] || "";
  return extension && !name.toLocaleLowerCase().endsWith(extension.toLocaleLowerCase()) ? `${name}${extension}` : name;
}

async function loadEntries() {
  const request = ++loadRequest;
  try {
    const { entries: flat } = await files.list();
    if (request !== loadRequest) return;
    const paths = new Set(flat.map(entry => entry.path));
    for (const path of canvasHeaders.keys()) if (!paths.has(path)) canvasHeaders.delete(path);
    const roots: AssetEntry[] = [];
    const directories = new Map<string, AssetEntry>();
    const ensureDirectory = (path: string) => {
      const existing = directories.get(path);
      if (existing) return existing;
      const parts = path.split("/");
      const directory: AssetEntry = { name: path === "assets" ? translate("节点素材") : parts.at(-1) || path, path, type: "directory", children: [] };
      directories.set(path, directory);
      const parentPath = parts.slice(0, -1).join("/");
      if (parentPath) ensureDirectory(parentPath).children!.push(directory);
      else roots.push(directory);
      return directory;
    };
    // Named library folders can live anywhere outside the reserved directories.
    // Reuse the canvas header reader to distinguish saved scalar JSON from canvases.
    const assetFlat: typeof flat = [];
    for (const entry of flat) {
      if (/^(agent|settings|skills)(\/|$)/i.test(entry.path)) continue;
      if (entry.type !== "directory" && !/^assets\//i.test(entry.path)) {
        if (!assetFileType({ name: entry.name, type: entry.mime || "" }).kind) continue;
        if (/\.json$/i.test(entry.path)) {
          const cached = canvasHeaders.get(entry.path);
          const canvas = entry.revision && cached?.revision === entry.revision ? cached.canvas : await isCanvasFile(files, entry.path);
          if (entry.revision && canvas !== undefined) canvasHeaders.set(entry.path, { revision: entry.revision, canvas });
          if (canvas !== false) continue;
        }
        if (request !== loadRequest) return;
      }
      assetFlat.push(entry);
    }
    const rawFiles = assetFlat.filter(entry => entry.type !== "directory");
    const siblingCounts = new Map<string, number>();
    const mediaCounts = new Map<string, number>();
    const latestByDirectory = new Map<string, string>();
    const namedFiles = rawFiles.map(item => {
      const parts = item.path.split("/");
      const rawName = parts.at(-1) || item.path;
      const parent = parts.slice(0, -1).join("/");
      const extension = rawName.match(/\.[a-z0-9]{1,12}$/i)?.[0] || "";
      const mediaEntry = { name: rawName, rawName, path: item.path, type: "file" as const, mime: item.mime, updatedAt: item.updatedAt };
      const description = `${mediaLabel(mediaEntry)} · ${localTime(item.updatedAt)}`;
      const mediaKey = `${parent}\0${description}\0${extension.toLocaleLowerCase()}`;
      const index = (siblingCounts.get(parent) || 0) + 1;
      const mediaIndex = (mediaCounts.get(mediaKey) || 0) + 1;
      siblingCounts.set(parent, index);
      mediaCounts.set(mediaKey, mediaIndex);
      for (let directory = parent; directory; directory = directory.split("/").slice(0, -1).join("/")) {
        if (item.updatedAt && item.updatedAt > (latestByDirectory.get(directory) || "")) latestByDirectory.set(directory, item.updatedAt);
      }
      return { item, parts, rawName, parent, extension, description, mediaKey, index, mediaIndex };
    });
    for (const item of assetFlat.filter(entry => entry.type === "directory")) ensureDirectory(item.path);
    for (const { item, parts, rawName, parent, extension, description, mediaKey, index, mediaIndex } of namedFiles) {
      const nodeId = /^assets\/([^/]+)$/.exec(parent)?.[1];
      const label = nodeId ? nodeLabel(nodeId) : undefined;
      const upload = !!nodeId && !!label && isUploadNode(nodeId, rawName);
      const name = parts[0] !== "assets" ? rawName : upload
        ? withExtension(siblingCounts.get(parent)! > 1 ? `${label} · ${index}` : label, rawName)
        : `${description}${mediaCounts.get(mediaKey)! > 1 ? ` · ${mediaIndex}` : ""}${extension}`;
      const entry: AssetEntry = { name, rawName, path: item.path, type: "file", mime: item.mime, updatedAt: item.updatedAt, nodeId };
      if (parts.length === 1) roots.push(entry);
      else ensureDirectory(parts.slice(0, -1).join("/")).children!.push(entry);
    }
    for (const directory of directories.values()) {
      const nodeId = /^assets\/([^/]+)$/.exec(directory.path)?.[1];
      const label = nodeId ? nodeLabel(nodeId) : undefined;
      const latest = latestByDirectory.get(directory.path);
      directory.name = label || (nodeId ? `${translate("其他画布素材")} · ${localTime(latest)}` : directory.name);
      directory.nodeId = nodeId;
      directory.updatedAt = latest || undefined;
    }
    sourceInventory.value = flat;
    entries.value = roots;
    await nextTick();
    if (request === loadRequest) assetTree.value?.filter(searchQuery.value);
  } catch (error) {
    if (request === loadRequest) throw error;
  }
}

function showError(error: unknown) {
  ElMessage.error(error instanceof Error ? error.message : translate("素材操作失败"));
}

watch(panelVisible, opened => {
  if (opened) loadEntries().catch(showError);
  else {
    cancelFolder();
    previewAsset.value = undefined;
  }
});

function selectFolder(entry: AssetEntry) {
  if (entry.draft) return;
  const path = entry.type === "directory" ? entry.path : entry.path.split("/").slice(0, -1).join("/") || ".";
  folder.value = folder.value === path ? "." : path;
}

async function startSaveFolder() {
  saveFolderName.value = "新建文件夹";
  await nextTick();
  saveFolderInput.value?.select();
}

async function createFolder() {
  const name = saveFolderName.value?.trim();
  if (!name || folderSaving.value) return;
  folderSaving.value = true;
  try {
    const path = await createAssetFolder(saveDirectory.value, name);
    await loadEntries();
    saveDirectory.value = path;
    saveFolderName.value = undefined;
  } catch (error) {
    showError(error);
  } finally {
    folderSaving.value = false;
  }
}

async function createAssetFolder(parent: string, name: string) {
  if (/[\\/]/.test(name)) throw new Error(translate("文件夹名称不能包含斜杠"));
  const path = parent === "." ? name : `${parent}/${name}`;
  await createFolderPath(files, path, lifetime.signal);
  return path;
}

async function openSave(label: string, items: AssetOutput[]) {
  lifetime.signal.throwIfAborted();
  sourceAsset.value = undefined;
  outputs.value = items;
  selectedOutput.value = 0;
  assetName.value = label.endsWith(extension.value) ? label : `${label}${extension.value}`;
  saveDirectory.value = isInternalAssetPath(folder.value) ? "." : folder.value;
  saveFolderName.value = undefined;
  saveVisible.value = true;
  try {
    await loadEntries();
  } catch (error) {
    showError(error);
  }
}

async function openSaveFile(entry: { name: string; path: string; sourceEntries?: readonly WorkspaceSourceEntry[] }) {
  lifetime.signal.throwIfAborted();
  const revision = entry.sourceEntries ? workspaceSourceRevision(entry.sourceEntries, entry.path) : undefined;
  if (entry.sourceEntries && !revision?.trim()) {
    showError(new Error(translate("素材版本尚未确认，请重新选择后操作")));
    return;
  }
  sourceAsset.value = { name: entry.name, path: entry.path, revision: revision ?? undefined };
  outputs.value = [];
  assetName.value = entry.path.split("/").at(-1)!;
  saveDirectory.value = isInternalAssetPath(folder.value) ? "." : folder.value;
  saveFolderName.value = undefined;
  saveVisible.value = true;
  try { await loadEntries(); } catch (error) { showError(error); }
}

async function saveAsset() {
  const output = outputs.value[selectedOutput.value]?.output;
  const name = assetName.value.trim();
  const selectedSource = sourceAsset.value;
  const source = selectedSource?.path;
  if ((!output && !source) || !name || /[\\/]/.test(name) || saving.value || saveFolderName.value !== undefined) return;
  const path = saveDirectory.value === "." ? name : `${saveDirectory.value}/${name}`;
  saving.value = true;
  try {
    if (source) await saveWorkspaceAsset(files, source, path, true, lifetime.signal, selectedSource?.revision);
    else await saveCanvasAsset(files, output!, path, true, lifetime.signal, outputs.value[selectedOutput.value]?.sourcePath);
    lifetime.signal.throwIfAborted();
    saveVisible.value = false;
    ElMessage.success(translate("已保存到素材库"));
    await loadEntries();
  } catch (error) {
    if (!lifetime.signal.aborted) showError(error);
  } finally {
    saving.value = false;
  }
}

defineExpose({ openSave });
</script>

<style lang="scss" scoped>
.assetLibraryPanel { position: fixed; z-index: 1002; max-width: calc(100vw - 16px); }
.assetLibrary {
  .libraryHeader { display: flex; align-items: center; justify-content: space-between; min-height: 30px; padding: 0 2px 6px 6px; cursor: grab; touch-action: none; user-select: none; font-size: 13px; font-weight: 600; }
  .libraryHeader:active { cursor: grabbing; }
  .toolbarButton { flex-shrink: 0; width: 28px; height: 28px; margin: 0; padding: 0; }
  width: min(320px, calc(100vw - 30px));
  max-height: calc(100dvh - 140px);

  :deep(.el-card__body) {
    display: flex;
    flex-direction: column;
    max-height: inherit;
    box-sizing: border-box;
  }

  .libraryToolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-shrink: 0;
    gap: 8px;
    height: 32px;
    margin-bottom: 8px;

    .toolbarButton {
      flex-shrink: 0;
      width: 28px;
      height: 28px;
      margin: 0;
      padding: 0;
    }

    .searchInput {
      flex: 1;
      min-width: 0;
    }
  }

  .libraryScroll {
    min-height: 0;
    max-height: 440px;
  }

  .audioPreview {
    flex-shrink: 0;
    margin-top: 8px;

    .audioHeader {
      display: flex;
      align-items: center;
      gap: 8px;

      span {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: var(--el-font-size-small);
      }
    }

    audio { display: block; width: 100%; }
  }

  .assetTree {
    :deep(.el-tree-node__content) {
      height: 44px;
      padding-right: 6px;
      border-radius: var(--el-border-radius-base);
    }

    .assetEntry {
      display: flex;
      flex: 1;
      align-items: center;
      gap: 8px;
      min-width: 0;
      overflow: hidden;

      &[draggable="true"] {
        cursor: grab;
      }

      .folderIcon {
        flex-shrink: 0;
        color: var(--el-text-color-secondary);
      }

      .assetThumbnail,
      .fileIcon {
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        width: 32px;
        height: 32px;
        border-radius: var(--el-border-radius-base);
        color: var(--el-text-color-secondary);
        background: var(--el-fill-color-light);
      }

      .moreButton {
        flex-shrink: 0;
        width: 24px;
        height: 24px;
        margin: 0;
        padding: 0;
        color: var(--el-text-color-secondary);
      }

      .assetName {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: var(--el-font-size-base);
      }

      .folderNameInput {
        flex: 1;
        min-width: 0;
      }
    }
  }
}

.assetPreview {
  .previewVideo {
    display: block;
    width: 100%;
    max-height: 65dvh;
    background: #000;
  }

}

.saveForm {
  .saveLocation {
    .locationHeader {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: var(--el-font-size-base);
      color: var(--el-text-color-regular);
    }

    .locationPath {
      margin: 4px 0 10px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: var(--el-font-size-small);
      color: var(--el-text-color-secondary);
    }

    .saveFolderScroll {
      height: auto;
      max-height: 220px;
    }

    .saveFolderTree {
      :deep(.el-tree-node__content) {
        height: 34px;
        border-radius: var(--el-border-radius-base);
      }

      .saveFolderEntry {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;

        svg { flex-shrink: 0; color: var(--el-text-color-secondary); }
        span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      }
    }

    .createFolderRow {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 10px;

      .el-input { flex: 1; min-width: 0; }
      .el-button { margin: 0; }
    }
  }
}
</style>
