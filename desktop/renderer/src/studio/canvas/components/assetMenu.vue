<template>
  <el-dropdown ref="menu" trigger="contextmenu" virtualTriggering :virtualRef="menuAnchor" placement="bottom-start" :showArrow="false" :hideOnClick="false" popperClass="assetActionMenu" @command="handleCommand" @visibleChange="(opened: boolean) => { if (!opened) moveVisible = false; }">
    <template #dropdown>
      <el-dropdown-menu v-if="activeEntry">
        <el-dropdown-item v-if="internalEntry" disabled>{{ translate('内部文件固定，请另存副本后整理') }}</el-dropdown-item>
        <el-dropdown-item v-if="activeEntry.type === 'file'" command="save" :disabled="busy">{{ translate('另存到素材库') }}</el-dropdown-item>
        <el-dropdown-item command="move" :disabled="busy || internalEntry">
          <el-popover v-model:visible="moveVisible" trigger="hover" placement="right-start" :width="220" :offset="0" :showArrow="false" :showAfter="0" :hideAfter="150" appendTo=".assetActionMenu">
            <template #reference>
              <span class="moveTrigger"><span class="moveLabel">{{ translate('移动到') }}</span><icon-chevron-right :size="14" /></span>
            </template>
            <div class="moveDestinations" role="menu" :aria-label="translate('移动到目录')" @click.stop @keydown.stop>
              <el-button text :icon="IconFolderPlus" :disabled="busy" role="menuitem" @click="createMoveFolder">{{ translate('新建文件夹') }}</el-button>
              <el-scrollbar maxHeight="260px">
                <el-button v-for="item in moveFolders" :key="item.path" text :icon="IconFolder" :disabled="busy || destinationDisabled(item.path)" role="menuitem" :title="`${item.label}\n${item.path}`" @click="moveTo(item.path)">{{ item.label }}</el-button>
              </el-scrollbar>
            </div>
          </el-popover>
        </el-dropdown-item>
        <el-dropdown-item v-if="activeEntry.type === 'file'" command="download" divided>{{ translate('下载') }}</el-dropdown-item>
        <el-dropdown-item command="rename" :disabled="busy || internalEntry">{{ translate('重命名') }}</el-dropdown-item>
        <el-dropdown-item class="deleteAction" command="delete" :disabled="busy || internalEntry || !!activeEntry.children?.length" :title="activeEntry.children?.length ? translate('请先删除文件夹内的素材') : undefined">{{ translate('删除') }}</el-dropdown-item>
      </el-dropdown-menu>
    </template>
  </el-dropdown>
</template>

<script setup lang="ts">
import { translate } from "@miaoimg/i18n/vue";
import { computed, inject, nextTick, onBeforeUnmount, ref, shallowRef } from "vue";
import { createAssetFolder, isInternalAssetPath, assertOrganizableAssetPath } from "../saveCanvasAsset";
import saveFile from "@/lib/saveFile";
import { useWorkspaceContentFiles as useWorkspaceFiles } from "@/lib/workspaceFiles";
import { ElMessage, ElMessageBox, type DropdownInstance } from "element-plus";
import { IconChevronRight, IconFolder, IconFolderPlus } from "@tabler/icons-vue";
import type { WorkspaceFileChange, WorkspaceFileMutator } from "@/pages/workspace/canvasFiles";
import { captureWorkspaceSourceEntries, type WorkspaceSourceEntry } from '@/lib/workspaceFileSelection';

type AssetEntry = { name: string; path: string; type: "file" | "directory"; children?: AssetEntry[]; sourceEntries?: readonly WorkspaceSourceEntry[] };
const props = defineProps<{ entries: AssetEntry[]; inventory: readonly { path: string; revision?: string }[]; directory?: string }>();
const files = useWorkspaceFiles(props.directory || "");
const mutateWorkspaceFiles = inject<WorkspaceFileMutator>("mutateWorkspaceFiles");
function mutateFile(change: WorkspaceFileChange) {
  if (!props.directory || !mutateWorkspaceFiles) throw new Error(translate("工作区文件操作尚未就绪"));
  return mutateWorkspaceFiles(props.directory, change, lifetime.signal);
}
const lifetime = new AbortController();
onBeforeUnmount(() => lifetime.abort());
const emit = defineEmits<{ changed: [path?: string, target?: string]; save: [entry: AssetEntry] }>();
const menu = ref<DropdownInstance>();
const menuAnchor = shallowRef({ getBoundingClientRect: () => new DOMRect() });
const activeEntry = shallowRef<AssetEntry>();
const internalEntry = computed(() => !!activeEntry.value && isInternalAssetPath(activeEntry.value.path));
const moveVisible = ref(false);
const busy = ref(false);
const parentPath = computed(() => activeEntry.value?.path.split("/").slice(0, -1).join("/") || ".");
const moveFolders = computed(() => {
  function flatten(items: AssetEntry[]): { label: string; path: string }[] {
    return items.filter(item => item.type === "directory" && !isInternalAssetPath(item.path)).flatMap(item => [
      { label: item.name, path: item.path },
      ...flatten(item.children ?? []),
    ]);
  }
  return [{ label: translate("素材库根目录"), path: "." }, ...flatten(props.entries)];
});

function destinationDisabled(path: string) {
  const entry = activeEntry.value;
  return path === parentPath.value || (entry?.type === "directory" && (path === entry.path || path.startsWith(entry.path + "/")));
}

async function openMenu(event: MouseEvent, entry: AssetEntry) {
  if (busy.value || lifetime.signal.aborted) return;
  menu.value?.handleClose();
  moveVisible.value = false;
  try { activeEntry.value = { ...entry, sourceEntries: captureWorkspaceSourceEntries(props.inventory, entry.path) }; }
  catch (error) { showError(error); return; }
  const target = event.currentTarget as HTMLElement;
  const rect = event.type === "contextmenu" ? new DOMRect(event.clientX, event.clientY, 0, 0) : target.getBoundingClientRect();
  menuAnchor.value = { getBoundingClientRect: () => rect };
  await nextTick();
  menu.value?.handleOpen();
}

function closeMenu() {
  moveVisible.value = false;
  menu.value?.handleClose();
}

function showError(error: unknown) {
  if (lifetime.signal.aborted || error === "cancel" || error === "close") return;
  ElMessage.error(error instanceof Error ? error.message : translate("素材操作失败"));
}

async function relocate(entry: AssetEntry, target: string) {
  lifetime.signal.throwIfAborted();
  assertOrganizableAssetPath(entry.path);
  assertOrganizableAssetPath(target);
  busy.value = true;
  try {
    await mutateFile({ path: entry.path, target, sourceEntries: entry.sourceEntries });
    lifetime.signal.throwIfAborted();
    emit("changed", entry.path, target);
  } catch (error) {
    if (!lifetime.signal.aborted) emit("changed");
    throw error;
  } finally {
    busy.value = false;
  }
}

async function moveTo(directory: string) {
  const entry = activeEntry.value!;
  const name = entry.path.split("/").at(-1)!;
  closeMenu();
  try {
    await relocate(entry, directory === "." ? name : directory + "/" + name);
  } catch (error) {
    showError(error);
  }
}

async function createMoveFolder() {
  const entry = activeEntry.value!;
  closeMenu();
  try {
    assertOrganizableAssetPath(entry.path);
    const { value } = await ElMessageBox.prompt(translate("新文件夹将创建在素材库根目录"), "新建文件夹", {
      inputValue: "新建文件夹",
      inputPattern: /^[^\\/]+$/,
      inputValidator: value => !!value?.trim() || translate("请输入文件夹名称"),
      inputErrorMessage: translate("名称不能包含斜杠"),
      confirmButtonText: translate("创建并移动"),
      cancelButtonText: translate("取消"),
    });
    lifetime.signal.throwIfAborted();
    const name = value.trim();
    await createAssetFolder(files, name, lifetime.signal);
    await relocate(entry, name + "/" + entry.path.split("/").at(-1)!);
  } catch (error) {
    showError(error);
    if (!lifetime.signal.aborted) emit("changed");
  }
}

async function handleCommand(command: string) {
  if (lifetime.signal.aborted || !activeEntry.value || busy.value) return;
  if (command === "save") { const entry = activeEntry.value; closeMenu(); emit("save", entry); return; }
  if (["move", "rename", "delete"].includes(command) && internalEntry.value) return;
  if (command === "move") {
    moveVisible.value = true;
    return;
  }
  const entry = activeEntry.value!;
  const parent = parentPath.value;
  closeMenu();
  try {
    if (command === "download") {
      const content = await files.read(entry.path, lifetime.signal);
      lifetime.signal.throwIfAborted();
      await saveFile(new Blob([content]), entry.name);
    }
    if (command === "rename") {
      const { value } = await ElMessageBox.prompt(translate("名称"), "重命名", {
        inputValue: entry.path.split("/").at(-1)!,
        inputPattern: /^[^\\/]+$/,
        inputValidator: value => !!value?.trim() || translate("请输入名称"),
        inputErrorMessage: translate("名称不能包含斜杠"),
        confirmButtonText: translate("保存"),
        cancelButtonText: translate("取消"),
      });
      lifetime.signal.throwIfAborted();
      await relocate(entry, parent === "." ? value.trim() : parent + "/" + value.trim());
    }
    if (command === "delete") {
      await ElMessageBox.confirm("确定删除“" + entry.name + "”？", "删除素材", { type: "warning", confirmButtonText: translate("删除"), cancelButtonText: translate("取消") });
      lifetime.signal.throwIfAborted();
      busy.value = true;
      try {
        assertOrganizableAssetPath(entry.path);
        await mutateFile({ path: entry.path, recursive: false, sourceEntries: entry.sourceEntries });
        lifetime.signal.throwIfAborted();
        emit("changed", entry.path);
      } finally {
        busy.value = false;
      }
    }
  } catch (error) {
    showError(error);
  }
}

defineExpose({ openMenu });
</script>

<style lang="scss" scoped>
.moveTrigger {
  display: flex;
  align-items: center;
  width: 100%;
}

.moveLabel {
  flex: 1;
  min-width: 132px;
}

:global(.assetActionMenu .deleteAction:not(.is-disabled)) {
  color: var(--el-color-danger);
}

.moveDestinations {
  .el-button {
    display: flex;
    justify-content: flex-start;
    width: 100%;
    margin: 0;
    padding: 8px;
    font-weight: normal;

    :deep(> span) {
      display: block;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  }
}
</style>
