<template>
  <div class="computerSettings">
    <settings-section :title="translate('让 Agent 使用这台电脑')" :description="translate('按你的要求整理文件、修改内容、运行命令和使用已安装的软件。')">
      <settings-row :label="translate('本机操作')" :description="state?.error ? translate('设置异常，本机操作已暂停。') : state?.enabled ? translate('完全允许访问，授权在这台电脑上持续有效。') : translate('尚未开启，首次使用需要你的授权。')">
        <el-button :type="state?.enabled ? 'default' : 'primary'" :loading="busy" :disabled="!state" @click="changeAccess">{{ state?.error ? translate('重新读取设置') : state?.enabled ? translate('关闭授权') : translate('开启并授权') }}</el-button>
      </settings-row>
    </settings-section>
    <settings-section :title="translate('可操作范围')" :description="translate('当前系统账号能够访问的文件和软件。任务需要的文件内容会发送给模型处理；关闭授权会停止正在执行的本机操作。')">
      <p class="scopeHint">{{ translate('可查找和操作其他位置的文件；默认工作文件夹不是访问范围限制。') }}</p>
      <settings-row :label="translate('默认工作文件夹')" :description="translate('新聊天从这里开始；已有聊天保留原目录，也可在对话中指定其他位置。')" stacked>
        <code class="computerPath">{{ state?.directory }}</code>
        <el-button :disabled="busy || !state || !!state.error" @click="chooseDirectory">{{ translate('选择文件夹') }}</el-button>
      </settings-row>
      <settings-row v-if="bridge?.platform === 'darwin'" :label="translate('macOS 系统文件权限')" :description="translate('受保护的文件还需要在系统设置中允许妙图完全磁盘访问。此处开启本机操作不会自动授予系统权限。')">
        <el-button @click="bridge?.openComputerPermissions()">{{ translate('打开系统权限设置') }}</el-button>
      </settings-row>
    </settings-section>
    <settings-section :title="translate('使用已有工具')" :description="translate('Agent 优先使用已有软件；任务需要时，可按你的要求准备依赖。妙图不会预先安装这些软件。')" />
    <feedbackNotice :message="error" @close="error = ''" />
  </div>
</template>
<script setup lang="ts">
import feedbackNotice from '../../components/feedbackNotice.vue';
import { onMounted, ref } from 'vue';
import { translate } from '@miaoimg/i18n/vue';
import settingsRow from '../components/settingsRow.vue';
import settingsSection from '../components/settingsSection.vue';
const bridge = window.miaoDesktop;
type ComputerState = { enabled: boolean; directory: string; error?: string };
const state = ref<ComputerState>();
const busy = ref(false), error = ref('');
async function perform(action: () => Promise<ComputerState> | undefined) {
  busy.value = true; error.value = '';
  try {
    const next = await action();
    if (!next || typeof next.enabled !== 'boolean' || typeof next.directory !== 'string') throw new Error('Invalid computer status');
    state.value = next; error.value = next.error ? translate(next.error) : '';
  } catch { error.value = translate(state.value?.error || '操作未完成，请重试。'); } finally { busy.value = false; }
}
function changeAccess() { return perform(() => state.value?.error ? bridge?.computerStatus() : state.value?.enabled ? bridge?.disableComputer() : bridge?.enableComputer()); }
function chooseDirectory() { return perform(() => bridge?.chooseComputerDirectory()); }
onMounted(() => perform(() => bridge?.computerStatus()));
</script>
<style scoped>
.computerSettings { display: flex; flex-direction: column; gap: 20px; }
.computerPath { display: block; margin-bottom: 12px; overflow-wrap: anywhere; color: var(--el-text-color-secondary); font-size: 12px; }
.computerError { color: var(--el-color-danger); font-size: 13px; }
.scopeHint { margin: 0 0 16px; color: var(--el-text-color-secondary); font-size: 13px; line-height: 1.7; }
</style>
