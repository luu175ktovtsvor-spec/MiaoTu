<template>
  <el-dropdown trigger="click" placement="bottom" :disabled="disabled || creating" popperClass="imagePresetMenu" @command="apply">
    <el-button :icon="IconTemplate" text :disabled="disabled" :loading="creating" :title="translate('快捷预设')" :aria-label="translate('快捷预设')" @click.stop />
    <template #dropdown>
      <el-dropdown-menu>
        <el-dropdown-item v-for="item in imagePresets" :key="item.id" :command="item.id">{{ translate(item.label) }}</el-dropdown-item>
      </el-dropdown-menu>
    </template>
  </el-dropdown>
</template>

<script setup lang="ts">
import { nextTick, ref } from "vue";
import { useVueFlow } from "@vue-flow/core";
import { ElButton, ElDropdown, ElDropdownItem, ElDropdownMenu } from "element-plus";
import { IconTemplate } from "@tabler/icons-vue";
import { translate } from "@miaoimg/i18n/vue";
import { showNodeError } from "@miaoimg/nodes-scaffold/runtime";
import { imagePresets } from "../imagePresets";
import { useImageVariationNode } from "../useImageVariationNode";

const props = defineProps<{ disabled?: boolean; loadModels: () => Promise<Array<{ type?: string; imageRatios?: string[] }>> }>();
const flow = useVueFlow();
const createVariation = useImageVariationNode();
const creating = ref(false);

// 新节点只填好提示词并选中，展开编辑卡片让用户看到模型、比例和预计积分后再点生成。
async function apply(id: string) {
  const preset = imagePresets.find(item => item.id === id);
  if (!preset || creating.value) return;
  creating.value = true;
  try {
    const label = translate(preset.label);
    // 预设比例只在默认图片模型支持时使用，否则留空让新节点按模型目录取默认值。
    const ratios = (await props.loadModels().catch(() => [])).find(item => item.type === "image")?.imageRatios ?? [];
    const ratio = preset.ratio && ratios.includes(preset.ratio) ? preset.ratio : "";
    const { nodeId } = await createVariation({ label, prompt: translate(preset.prompt), model: "", size: "", ratio });
    const created = flow.findNode(nodeId);
    if (!created) return;
    flow.removeSelectedElements();
    flow.addSelectedNodes([created]);
    // 等新节点渲染出尺寸再取景，否则 fitView 拿不到它的范围。
    for (let frame = 0; frame < 30 && !(created.dimensions.width && created.dimensions.height); frame++) await new Promise(resolve => requestAnimationFrame(resolve));
    await nextTick();
    await flow.fitView({ nodes: [nodeId], padding: 0.4, maxZoom: 1, duration: 200 });
  } catch (error) {
    showNodeError(error, translate("快捷预设失败"));
  } finally {
    creating.value = false;
  }
}
</script>
