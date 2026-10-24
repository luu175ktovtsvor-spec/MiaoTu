<template>
  <div v-if="capabilities" class="localMediaInfo" :class="{ compact }" :aria-label="translate('账号模型能力')">
    <p class="watermarkPolicy">{{ translate('生成前，妙图会自动打开账号里的「去除 AI 水印」，只保存平台确认已去掉 AI 水印的原片。') }}</p>
    <p>{{ referenceHint }}</p>
    <template v-if="!compact">
      <p>{{ translate(capabilities.platform === 'doubao' ? '普通豆包账号会保留豆包品牌标识，订阅账号没有。' : 'Dola 免费和付费账号都会去除 AI 水印；品牌标识按 Dola 返回的为准。') }}</p>
      <p>{{ translate(capabilities.kind === 'video' ? '按平台给的原片保存（MP4 或 WebM），不转码、不改分辨率。' : '按平台给的原图保存（PNG、JPEG 或 WebP）。') }}</p>
    </template>
  </div>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { translate } from '@miaoimg/i18n/vue';
import { localMediaCapabilities } from '../../../../../local-media/catalog.ts';

const props = defineProps<{ model?: { providerId?: string; modelId?: string }; compact?: boolean }>();
const capabilities = computed(() => props.model?.modelId && props.model.providerId ? localMediaCapabilities(props.model.modelId, props.model.providerId) : undefined);
const referenceHint = computed(() => capabilities.value?.references.maxImages
  ? translate('可以放参考图：PNG、JPEG 或 WebP，最多 {0} 张，每张不超过 20MB。', { 0: capabilities.value.references.maxImages })
  : translate('用文字提示词生成。'));
</script>
<style scoped>
.localMediaInfo { color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.6; }
.localMediaInfo p { margin: 8px 0 0; }
.localMediaInfo .watermarkPolicy { color: var(--el-text-color-regular); }
.localMediaInfo.compact p { margin: 8px 0; }
</style>
