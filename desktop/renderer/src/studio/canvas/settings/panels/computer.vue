<template>
  <div class="computerSettings">
    <settings-section :title="translate('让 Agent 使用这台电脑')" :description="translate('整理文件、运行命令、使用已安装的软件')">
      <settings-row :label="translate('本机操作')" :description="state?.error ? translate('设置异常，本机操作已暂停') : state?.enabled ? translate('已授权，关闭会停止正在进行的操作') : translate('尚未开启，需要你授权')">
        <el-button :type="state?.enabled ? 'default' : 'primary'" :loading="busy" :disabled="!state" @click="changeAccess">{{ state?.error ? translate('重新读取设置') : state?.enabled ? translate('关闭授权') : translate('开启并授权') }}</el-button>
      </settings-row>
    </settings-section>
    <settings-section :title="translate('可操作范围')" :description="translate('文件内容会发给模型，关闭授权会停掉正在进行的操作')">
      <p class="scopeHint">{{ translate('不限于默认工作文件夹') }}</p>
      <settings-row :label="translate('默认工作文件夹')" :description="translate('新聊天从这里开始，已有聊天保留原目录')" stacked>
        <code class="computerPath">{{ state?.directory }}</code>
        <el-button :disabled="busy || !state || !!state.error" @click="chooseDirectory">{{ translate('选择文件夹') }}</el-button>
      </settings-row>
      <settings-row v-if="bridge?.platform === 'darwin'" :label="translate('macOS 系统文件权限')" :description="translate('受保护文件需要系统的完全磁盘访问权限')">
        <el-button @click="bridge?.openComputerPermissions()">{{ translate('打开系统权限设置') }}</el-button>
      </settings-row>
    </settings-section>
    <settings-section :title="translate('使用已有工具')" :description="translate('优先用已安装的软件，不会预先安装')" />
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
