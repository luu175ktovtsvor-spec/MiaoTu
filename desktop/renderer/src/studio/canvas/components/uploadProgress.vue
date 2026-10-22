<template>
  <!-- 上传进度画在「这次拖入/粘贴创建出来的那个节点」的框里，不在画布中间飘浮条。 -->
  <div v-if="entry" class="uploadProgress" :class="`state-${entry.status}`" role="status">
    <el-progress
      class="uploadRing"
      type="circle"
      :percentage="entry.percent"
      :width="64"
      :stroke-width="3"
      :color="ringColor"
      :aria-label="translate('上传状态')"
      :aria-valuetext="statusText">
      <span class="ringText">{{ entry.percent }}%</span>
    </el-progress>
    <div class="uploadLine">
      <span class="uploadName" :title="entry.name">{{ entry.name }}</span>
      <span class="uploadState">{{ statusText }}</span>
    </div>
    <div v-if="entry.status === 'error'" class="uploadActions">
      <el-button size="small" @click.stop="emit('retry')">{{ translate('重试') }}</el-button>
      <el-button size="small" text @click.stop="emit('dismiss')">{{ translate('取消') }}</el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { ElButton, ElProgress } from "element-plus";
import { translate } from "@miaoimg/i18n/vue";
import type { UploadEntry } from "../uploadStatus";

const props = defineProps<{ entry: UploadEntry }>();
const emit = defineEmits<{ retry: []; dismiss: [] }>();

const RING_COLORS: Record<UploadEntry["status"], string> = {
  pending: "var(--el-color-primary, #f2f2f2)",
  uploading: "var(--el-color-primary, #f2f2f2)",
  done: "#34d399",
  error: "#f87171",
};
const ringColor = computed(() => RING_COLORS[props.entry.status]);
const statusText = computed(() => props.entry.status === "done" ? translate("已加入画布")
  : props.entry.status === "error" ? (props.entry.message || translate("上传失败"))
    : props.entry.percent >= 99 ? translate("正在保存素材…") : translate("上传中…"));
</script>

<style scoped lang="scss">
.uploadProgress {
  position: absolute;
  inset: 0;
  z-index: 3;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 8px;
  background: rgba(0, 0, 0, 0.68);
  color: #fff;
  text-align: center;

  .uploadRing {
    :deep(.el-progress__text) {
      color: #fff;
      font-size: 14px !important;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
    }
  }

  .uploadLine {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-width: 100%;
    font-size: 12px;
    line-height: 16px;
  }

  .uploadName {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 600;
  }

  .uploadState {
    display: -webkit-box;
    overflow: hidden;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    color: rgba(255, 255, 255, 0.72);
  }

  .uploadActions {
    display: flex;
    gap: 4px;
    margin-top: 2px;
  }

  &.state-done {
    background: rgba(0, 0, 0, 0.5);
  }
}
</style>
