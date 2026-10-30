<template>
  <el-button :icon="IconLayoutBoard" text :disabled="disabled || !shots.length" :title="translate('生成分镜')" :aria-label="translate('生成分镜')" @click.stop="open">{{ translate('生成分镜') }}</el-button>
  <el-dialog v-model="visible" :title="translate('生成分镜')" width="min(560px, calc(100vw - 32px))" alignCenter appendToBody>
    <p class="storyboardHint">{{ translate('按段落或编号把文本拆成分镜，每条新建一个图片生成节点并放进同一分组；连到这个文本节点的图片会作为每个分镜的参考。只填好提示词，不会自动生成。') }}</p>
    <div class="storyboardOptions">
      <span>{{ translate('画面比例') }}</span>
      <el-radio-group v-if="ratios.length" v-model="ratio" size="small">
        <el-radio-button v-for="item in ratios" :key="item" :value="item">{{ item === "auto" ? translate("自动") : item }}</el-radio-button>
      </el-radio-group>
      <span class="storyboardCount">{{ translate('已选 {0} / {1} 条', { 0: chosen.length, 1: draft.length }) }}</span>
    </div>
    <ol class="storyboardList">
      <li v-for="(shot, index) in draft" :key="index">
        <el-checkbox v-model="shot.enabled" :aria-label="translate('分镜 {0}', { 0: index + 1 })" />
        <span class="shotIndex">{{ index + 1 }}</span>
        <el-input v-model="shot.text" type="textarea" :autosize="{ minRows: 1, maxRows: 4 }" :aria-label="translate('分镜 {0}', { 0: index + 1 })" />
      </li>
    </ol>
    <p v-if="references.length" class="storyboardHint">{{ translate('参考图片：{0} 张', { 0: references.length }) }}</p>
    <template #footer>
      <el-button @click="visible = false">{{ translate('取消') }}</el-button>
      <el-button type="primary" :loading="creating" :disabled="!chosen.length" @click="create">{{ translate('创建 {0} 个分镜', { 0: chosen.length }) }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { useVueFlow } from "@vue-flow/core";
import { ElButton, ElCheckbox, ElDialog, ElInput, ElMessage, ElRadioButton, ElRadioGroup } from "element-plus";
import { IconLayoutBoard } from "@tabler/icons-vue";
import { translate } from "@miaoimg/i18n/vue";
import { STORYBOARD_MAX_SHOTS as maxShots, splitShots, useStoryboard } from "./useStoryboard";

const props = defineProps<{ text: string; label: string; disabled?: boolean; loadModels: () => Promise<Array<{ type?: string; imageRatios?: string[] }>> }>();
const flow = useVueFlow();
const { references, createStoryboard } = useStoryboard(() => props.label);
const visible = ref(false);
const creating = ref(false);
// 比例只列新节点默认会用的图片模型（目录第一个图片模型）实际支持的值。
const ratios = ref<string[]>([]);
const ratio = ref("");
const draft = ref<Array<{ text: string; enabled: boolean }>>([]);
const chosen = computed(() => draft.value.filter(shot => shot.enabled && shot.text.trim()));
const shots = computed(() => splitShots(props.text));
defineExpose({ open, creating });

async function open() {
  draft.value = shots.value.map((text, index) => ({ text, enabled: index < maxShots }));
  visible.value = true;
  try {
    const model = (await props.loadModels()).find(item => item.type === "image");
    ratios.value = model?.imageRatios ?? [];
  } catch { ratios.value = []; }
  ratio.value = ratios.value.includes(ratio.value) ? ratio.value : ratios.value.includes("16:9") ? "16:9" : ratios.value[0] ?? "";
}

async function create() {
  const list = chosen.value.slice(0, maxShots).map(shot => shot.text.trim());
  if (!list.length || creating.value) return;
  creating.value = true;
  try {
    const { groupId } = await createStoryboard(list, ratio.value);
    visible.value = false;
    const group = flow.findNode(groupId);
    if (group) {
      flow.removeSelectedElements();
      flow.addSelectedNodes([group]);
      await nextTick();
      await flow.fitView({ nodes: [groupId], padding: 0.15, maxZoom: 1, duration: 200 });
    }
    ElMessage.success(translate("已创建 {0} 个分镜，可在分组右上角「整组生成」", { 0: list.length }));
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : translate("生成分镜失败"));
  } finally {
    creating.value = false;
  }
}
</script>

<style lang="scss" scoped>
.storyboardHint { margin: 0 0 12px; color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.6; }
.storyboardOptions { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; font-size: 13px; }
.storyboardCount { margin-left: auto; color: var(--el-text-color-secondary); font-size: 12px; }
.storyboardList {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: min(420px, 50vh);
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
  li { display: grid; grid-template-columns: auto 20px minmax(0, 1fr); align-items: start; gap: 6px; }
  .shotIndex { padding-top: 6px; color: var(--el-text-color-secondary); font-size: 12px; text-align: right; font-variant-numeric: tabular-nums; }
}
</style>
