<template>
  <!-- 上传进度画在「这次拖入/粘贴创建出来的那个节点」的框里，不在画布中间飘浮条。 -->
  <div v-if="entry" class="uploadProgress" :class="`state-${entry.status}`" role="status">
    <!-- 和生成进度同一种样子：蓝色进度条从左往右推进、发蓝光，百分比跟着条子的头走。 -->
    <div class="uploadTrack" role="progressbar" :aria-label="translate('上传状态')" :aria-valuetext="statusText" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="entry.percent">
      <div class="uploadFill" :style="{ width: `${Math.max(2, entry.percent)}%` }" />
    </div>
    <span class="uploadNumber">{{ entry.percent }}%</span>
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
import { ElButton } from "element-plus";
import { translate } from "@miaoimg/i18n/vue";
import type { UploadEntry } from "../uploadStatus";

const props = defineProps<{ entry: UploadEntry }>();
const emit = defineEmits<{ retry: []; dismiss: [] }>();

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

  .uploadTrack {
    width: min(78%, 220px);
    height: 4px;
    margin-top: 4px;
    border-radius: 999px;
    background: rgb(255 255 255 / .16);
  }

  .uploadFill {
    height: 100%;
    border-radius: inherit;
    background: linear-gradient(90deg, rgb(76 157 255 / .55), #4c9dff);
    box-shadow: 0 0 10px rgb(76 157 255 / .85);
    transition: width .4s cubic-bezier(.2, .7, .2, 1);
  }

  .uploadNumber {
    font-size: 12px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    text-shadow: 0 0 8px rgb(76 157 255 / .9);
  }

  &.state-error .uploadFill { background: #e5484d; box-shadow: 0 0 10px rgb(229 72 77 / .7); }

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
