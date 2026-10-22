<template>
  <div class="thumbnailItem" :class="{ textAttachment: isText }">
    <template v-if="isText">
      <button class="textAttachmentButton" type="button" :title="displayTitle" :aria-label="translate('预览 {0}', { 0: displayName })" @click="textPreviewVisible = true">
        <icon-file-text :size="18" />
        <span>{{ displayName }}</span>
      </button>
      <el-button v-if="restorable" class="restoreAttachment" text size="small" :disabled="disabled" @click="emit('restore')">{{ translate('还原到输入框') }}</el-button>
    </template>
    <el-image
      v-else-if="attachment.mimeType.startsWith('image/')"
      ref="imageRef"
      class="thumbnailImage"
      :src="thumbnailUrl"
      :previewSrcList="thumbnailUrl ? [thumbnailUrl] : []"
      previewTeleported
      fit="cover"
      :alt="displayName"
      :title="displayTitle"
      tabindex="0"
      role="button"
      :aria-label="translate('预览 {0}', { 0: displayName })"
      @keydown.enter.prevent="imageRef?.showPreview()"
      @keydown.space.prevent="imageRef?.showPreview()">
      <template #error><icon-photo :size="20" /></template>
    </el-image>
    <button v-else class="thumbnailButton" type="button" :title="displayTitle" :aria-label="translate('预览 {0}', { 0: displayName })" :disabled="!thumbnailUrl" @click="videoPreviewVisible = true">
      <img v-if="posterUrl" :src="posterUrl" alt="" draggable="false" />
      <video v-else-if="thumbnailUrl" :src="thumbnailUrl" preload="metadata" muted playsinline aria-hidden="true" />
      <icon-video class="videoIcon" :size="16" />
    </button>
    <el-button v-if="removable" class="removeAttachment" circle :disabled="disabled" :aria-label="translate('移除 {0}', { 0: displayName })" :title="translate('移除附件')" @click="emit('remove')"><icon-x :size="10" /></el-button>
    <el-dialog v-model="videoPreviewVisible" :title="displayName" width="min(800px, 90vw)" alignCenter appendToBody destroyOnClose>
      <video v-if="videoPreviewVisible" class="videoPreview" :src="workspacePlaybackUrl(thumbnailUrl)" controls playsinline preload="metadata" />
    </el-dialog>
    <el-dialog v-model="textPreviewVisible" :title="displayName" width="min(720px, 90vw)" alignCenter appendToBody destroyOnClose>
      <p v-if="textLoading || textError" :role="textError ? 'alert' : 'status'">{{ textLoading ? translate('正在读取…') : textError }}</p>
      <pre v-else class="textPreview">{{ textContent }}</pre>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { ImageInstance } from "element-plus";
import { IconFileText, IconPhoto, IconVideo, IconX } from "@tabler/icons-vue";
import useWorkspaceFiles, { workspacePlaybackUrl, workspacePreviewUrl } from "@/lib/workspaceFiles";
import type { AgentAttachment } from "./types";
import { readTextAttachment } from "./textAttachments";
import { translate } from "@miaoimg/i18n/vue";

const props = defineProps<{ attachment: AgentAttachment; directory?: string; removable?: boolean; restorable?: boolean; disabled?: boolean }>();
const emit = defineEmits<{ remove: []; restore: [] }>();
const isText = computed(() => props.attachment.mimeType === "text/plain");
const textPreviewVisible = ref(false);
const textContent = ref("");
const textLoading = ref(false);
const textError = ref("");
const imageRef = ref<ImageInstance>();
const videoPreviewVisible = ref(false);
const thumbnailUrl = ref("");
const posterUrl = computed(() => thumbnailUrl.value.includes("/api/imagine/workspace/files?") ? workspacePreviewUrl(thumbnailUrl.value, 320) : "");
const displayName = computed(() => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(props.attachment.name)) return props.attachment.name;
  return props.attachment.mimeType.startsWith("image/") ? translate("图片") : props.attachment.mimeType.startsWith("video/") ? translate("视频") : props.attachment.mimeType.startsWith("audio/") ? translate("音频") : translate("文件");
});
const displayTitle = computed(() => displayName.value === props.attachment.name ? displayName.value : `${displayName.value}\n${props.attachment.path || props.attachment.name}`);

watch(() => [props.directory, props.attachment.file, props.attachment.path, props.attachment.mimeType] as const, async ([directory, file, path, mimeType], _previous, onCleanup) => {
  videoPreviewVisible.value = false;
  thumbnailUrl.value = "";
  if (mimeType === "text/plain") return;
  let cancelled = false;
  let release = () => {};
  onCleanup(() => { cancelled = true; release(); });
  try {
    if (file) {
      const url = URL.createObjectURL(file);
      release = () => URL.revokeObjectURL(url);
      thumbnailUrl.value = url;
    } else if (directory) {
      const preview = useWorkspaceFiles(directory).acquireUrl(path);
      release = preview.release;
      const url = await preview.url;
      if (!cancelled) thumbnailUrl.value = url;
    }
  } catch {
    if (!cancelled) thumbnailUrl.value = "";
  }
}, { immediate: true });

watch([textPreviewVisible, () => props.attachment, () => props.directory], async ([visible, attachment, directory], _previous, onCleanup) => {
  textContent.value = "";
  textError.value = "";
  textLoading.value = false;
  if (!visible || attachment.mimeType !== "text/plain") return;
  let cancelled = false;
  onCleanup(() => { cancelled = true; });
  textLoading.value = true;
  try {
    const text = await readTextAttachment(attachment, directory);
    if (!cancelled) textContent.value = text;
  } catch {
    if (!cancelled) textError.value = translate("无法读取文本附件，请重试");
  } finally {
    if (!cancelled) textLoading.value = false;
  }
});
</script>

<style scoped lang="scss">
.thumbnailItem {
  position: relative;
  flex-shrink: 0;
  width: 38px;
  height: 38px;

  &.textAttachment {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    width: min(160px, 100%);
    height: auto;
    padding: 6px 8px;
    box-sizing: border-box;
    border: 1px solid var(--el-border-color);
    border-radius: 8px;
    background: var(--el-fill-color-extra-light);

    .textAttachmentButton {
      display: flex;
      align-items: center;
      gap: 6px;
      width: 100%;
      padding: 0;
      border: none;
      background: transparent;
      color: var(--el-text-color-primary);
      font: inherit;
      font-size: 12px;
      cursor: pointer;

      svg { flex-shrink: 0; color: var(--el-color-primary); }
      span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    }

    .restoreAttachment { height: 20px; margin: 2px 0 0 24px; padding: 0; font-size: 11px; }
  }

  .thumbnailButton,
  .thumbnailImage {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    padding: 0;
    overflow: hidden;
    border: 1px solid var(--el-border-color);
    border-radius: 10px;
    background: transparent;
    color: var(--el-text-color-secondary);
    cursor: pointer;

    .el-image,
    video, img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }

    :deep(.el-image__error) {
      background: transparent;
    }

    .videoIcon {
      position: absolute;
      right: 3px;
      bottom: 3px;
      color: white;
      filter: drop-shadow(0 1px 2px rgb(0 0 0 / 80%));
    }
  }

  .removeAttachment {
    position: absolute;
    top: -5px;
    right: -5px;
    width: 16px;
    height: 16px;
    margin: 0;
    padding: 0;
    opacity: 0;
    pointer-events: none;
  }

  &:hover .removeAttachment,
  &:focus-within .removeAttachment {
    opacity: 1;
    pointer-events: auto;
  }

}

.videoPreview {
  display: block;
  width: 100%;
  max-height: 70vh;
}

.textPreview {
  max-height: 60vh;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: inherit;
}
</style>
