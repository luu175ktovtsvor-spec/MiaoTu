<template>
  <el-dialog v-model="visible" :title="translate('默认打开方式')" width="min(660px, calc(100vw - 32px))" alignCenter appendToBody>
    <div v-loading="loading" class="extensionAssociations">
      <p>{{ translate("按文件类型选择默认扩展。清除后，有多个可用扩展时会再次询问打开方式。") }}</p>
      <feedbackNotice v-if="error" :message="error"  />
      <el-table :data="rows" maxHeight="420" :emptyText="translate('暂无已安装的文件扩展或默认关联')">
        <el-table-column :label="translate('文件类型')" width="140">
          <template #default="{ row }">{{ row.suffix === "canvasNode" ? translate("画布节点") : `.${row.suffix}` }}</template>
        </el-table-column>
        <el-table-column :label="translate('默认扩展')">
          <template #default="{ row }">
            <el-select
              :modelValue="extensionAssociations[row.suffix] ?? ''"
              :placeholder="translate('自动选择 / 每次询问')"
              clearable
              :disabled="saving"
              :aria-label="translate('{0} 的默认扩展', { 0: row.suffix })"
              @change="(id: string) => save(row.suffix, id)">
              <el-option v-if="row.unavailable" :value="row.unavailable" :label="translate('{0}（不可用）', { 0: row.unavailable })" disabled />
              <el-option v-for="extension in row.candidates" :key="extension.id" :value="extension.id" :label="`${extension.displayName} · ${extension.id}`" />
            </el-select>
          </template>
        </el-table-column>
      </el-table>
    </div>
    <template #footer>
      <el-button @click="visible = false">{{ translate("完成") }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import feedbackNotice from '../../../components/feedbackNotice.vue';
import { computed, ref, shallowRef, watch } from "vue";
import { ElMessage } from "element-plus";
import { translate } from "@miaoimg/i18n/vue";
import { extensionAssociations, listExtensions, setExtensionAssociation, type InstalledExtension } from "@/studio/canvas/ext";

const visible = defineModel<boolean>({ default: false });
const extensions = shallowRef<InstalledExtension[]>([]);
const loading = ref(false);
const saving = ref(false);
const error = ref("");

// 一行一种文件类型：已关联的（哪怕现在不可用）与所有可用扩展声明的后缀都列出来。
const rows = computed(() => {
  const available = extensions.value.filter(extension => extension.enabled && !extension.loadError);
  const suffixes = new Set([
    ...Object.keys(extensionAssociations.value),
    ...available.flatMap(extension => extension.resourceKind === "canvasNode" ? ["canvasNode"] : extension.extensions),
  ]);
  return [...suffixes].sort().map(suffix => {
    const candidates = available.filter(extension => suffix === "canvasNode"
      ? extension.resourceKind === "canvasNode"
      : extension.resourceKind === "file" && extension.extensions.includes(suffix));
    const selected = extensionAssociations.value[suffix];
    return { suffix, candidates, unavailable: selected && !candidates.some(extension => extension.id === selected) ? selected : undefined };
  });
});

watch(visible, async value => {
  if (!value) return;
  loading.value = true;
  error.value = "";
  try { extensions.value = await listExtensions(true); }
  catch (cause) { error.value = cause instanceof Error ? cause.message : translate("读取文件扩展失败"); }
  finally { loading.value = false; }
}, { immediate: true });

async function save(suffix: string, id: string) {
  saving.value = true;
  try { await setExtensionAssociation(suffix, id || undefined); }
  catch (cause) { ElMessage.error(cause instanceof Error ? cause.message : translate("保存默认打开方式失败")); }
  finally { saving.value = false; }
}
</script>

<style scoped lang="scss">
.extensionAssociations {
  p {
    margin: 0 0 16px;
    color: var(--el-text-color-secondary);
    line-height: 1.6;
  }

  :deep(.el-select) { width: 100%; }
}
</style>
