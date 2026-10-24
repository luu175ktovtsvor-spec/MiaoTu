<template>
  <div class="doubaoSettings">
    <el-radio-group v-model="platform" :aria-label="translate('选择平台')">
      <el-radio-button value="doubao">豆包</el-radio-button><el-radio-button value="dola">Dola</el-radio-button>
    </el-radio-group>
    <settings-section :title="site.id === 'dola' ? translate('Dola 账号') : translate('豆包账号')" :description="translate('登录后，就能在文本、图片和视频节点里用这个账号生成；用的是账号自己的额度，不扣妙图积分。')">
      <div class="accountStatus" role="status">
        <el-tag :type="state?.connected ? 'success' : 'info'">{{ state?.connected ? translate('已连接') : translate('未连接') }}</el-tag>
        <strong v-if="state?.name">{{ state.name }}</strong>
        <span>{{ state?.message || translate('正在读取连接状态…') }}</span>
      </div>
      <div class="actions">
        <el-button type="primary" :loading="busy" :disabled="!state?.available" @click="perform(state?.connected ? 'open' : 'login')">{{ (state?.connected ? translate('打开') : translate('登录')) + ' ' + site.label }}</el-button>
        <el-button :disabled="busy || !state?.available" @click="perform('refresh')">{{ translate('刷新额度') }}</el-button>
        <el-button :disabled="busy || !state?.connected" @click="disconnect">{{ translate('断开连接') }}</el-button>
      </div>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p v-if="state && !state.available" class="hint">{{ translate('请在妙图桌面版里打开这个设置。') }}</p>
    </settings-section>
    <settings-section v-if="state?.pending?.length" :title="translate('还有结果没取回')" :description="translate('在平台窗口里打开那段对话，再点「关联当前对话」；妙图核对提示词后取回结果，不会重新生成。')">
      <settings-row v-for="task in state.pending" :key="task.id" :label="kinds.find(kind => kind.id === task.kind)?.label || task.kind" :description="new Date(task.createdAt).toLocaleString()">
        <el-button v-if="task.needsBinding" :disabled="busy" @click="perform('bind-current', false, { requestId: task.id })">{{ translate('关联当前对话') }}</el-button>
        <span v-else>{{ translate('正在取回') }}</span>
      </settings-row>
    </settings-section>
    <settings-section :title="site.label + ' ' + translate('剩余额度')" :description="translate('数字来自你的平台账号。')">
      <div class="quotaGrid">
        <div v-for="kind in kinds" :key="kind.id" class="quotaCard">
          <span>{{ kind.label }}</span>
          <strong>{{ quota(kind.id)?.remaining == null ? '—' : `${quota(kind.id)?.remaining} ${quota(kind.id)?.unit}` }}</strong>
          <small v-if="quota(kind.id)?.remaining == null">{{ translate('平台没有显示剩余额度') }}</small>
        </div>
      </div>
      <p v-if="state?.checkedAt" class="hint">{{ translate('上次更新') }}：{{ new Date(state.checkedAt).toLocaleString() }}</p>
    </settings-section>
    <settings-section :title="translate('今天在妙图里的用量')" :description="translate('这台电脑上，用这个账号在妙图里提交的生成。')">
      <settings-row v-for="kind in kinds" :key="kind.id" :label="kind.label" control-width="auto">
        <span class="usageValue">{{ translate('提交') }} {{ usage(kind.id)?.submitted || 0 }} · {{ translate('完成') }} {{ usage(kind.id)?.succeeded || 0 }} · {{ translate('待取回') }} {{ usage(kind.id)?.pending || 0 }}<template v-if="usage(kind.id)?.confirming"> · {{ translate('确认中') }} {{ usage(kind.id)?.confirming }}</template></span>
      </settings-row>
    </settings-section>
    <settings-section :title="translate('在节点里使用')" :description="translate('在文本、图片或视频节点的模型菜单里，选「豆包」或「Dola」分组下的模型。')">
      <local-media-info :model="{ providerId: platform + '-local', modelId: platform + '-local-video' }" />
      <p class="hint">{{ translate('时长、比例等选项按平台实际提供的显示；平台窗口要求验证时，在窗口里完成后会自动继续。') }}</p>
      <p class="hint">{{ translate('豆包、Dola 的文本模型只在文本节点里用；Agent 和 3D 导演台请在「文本模型」里换成其他模型。') }}</p>
      <p class="hint">{{ translate('登录状态只保存在这台电脑上，每个妙图账号分开保存；断开连接会清除它。') }}</p>
    </settings-section>
    <settings-section :title="translate('支持的地区')" :description="translate('平台按你登录和生成时所用网络的地区判断能不能用。')">
      <div class="networkGuide">
        <p><strong>Dola</strong><span>{{ translate('可用：日本、英国和东南亚等地区。不可用：中国大陆、美国、加拿大、澳大利亚、印度。') }}</span></p>
        <p><strong>豆包</strong><span>{{ translate('在中国大陆的网络下可直接使用。') }}</span></p>
        <p><strong>{{ translate('受限时') }}</strong><span>{{ translate('换到可用地区的网络后，重新打开平台窗口并登录。') }}</span></p>
      </div>
    </settings-section>
  </div>
</template>
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { ElMessageBox } from 'element-plus';
import { translate } from '@miaoimg/i18n/vue';
import { captureWorkspaceScope, assertWorkspaceScope, workspaceHeaders } from '@/lib/workspaceRemote';
import { invalidateNodeModels } from '@/studio/canvas/scaffold/nodeAi';
import settingsSection from '../components/settingsSection.vue';
import settingsRow from '../components/settingsRow.vue';
import localMediaInfo from '../../nodes/localMediaInfo.vue';
type Kind = 'image' | 'video' | 'text';
type Quota = { remaining: number | null; unit: string; source: string };
type State = { available: boolean; connected: boolean; name: string; message: string; checkedAt: string | null; image: Quota; video: Quota; text: Quota; usage: Record<Kind, { submitted: number; succeeded: number; pending: number; confirming: number }>; pending: { id: string; kind: Kind; status: string; createdAt: string; needsBinding: boolean }[] };
const state = ref<State>(), error = ref(''), busy = ref(false);
const platform = ref<'doubao' | 'dola'>('doubao');
const site = computed(() => ({ id: platform.value, label: platform.value === 'doubao' ? '豆包' : 'Dola' }));
const kinds = [{ id: 'text' as const, label: translate('文本对话') }, { id: 'image' as const, label: translate('图片生成') }, { id: 'video' as const, label: translate('视频生成') }];
const scope = captureWorkspaceScope(), controller = new AbortController();
let routeController = new AbortController(), revision = 0;
let interval: ReturnType<typeof setInterval> | undefined, watching = false;
const quota = (kind: Kind) => state.value?.[kind];
const usage = (kind: Kind) => state.value?.usage[kind];
async function perform(action?: string, silent = false, payload: Record<string, unknown> = {}) {
  if (busy.value) return;
  busy.value = true; if (!silent) error.value = '';
  const route = platform.value, requestedRevision = ++revision;
  const signal = AbortSignal.any([controller.signal, routeController.signal]);
  try {
    assertWorkspaceScope(scope);
    const response = await fetch('./api/desktop/' + route, { method: action ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal,
      headers: workspaceHeaders(scope.owner), ...(action ? { body: JSON.stringify({ action, ...payload }) } : {}) });
    const data = await response.json();
    assertWorkspaceScope(scope); signal.throwIfAborted();
    if (requestedRevision !== revision) return;
    if (!response.ok || data.ok !== true) throw new Error(data.error || translate('连接操作失败'));
    state.value = data;
    invalidateNodeModels('media');
    if (action === 'disconnect') watching = false;
    else if (action) watching = true;
  } catch (reason) { if (!signal.aborted && requestedRevision === revision) error.value = reason instanceof Error ? reason.message : translate('连接操作失败'); }
  finally { if (requestedRevision === revision) busy.value = false; }
}
watch(platform, () => { routeController.abort(); routeController = new AbortController(); revision++; busy.value = false; watching = false; state.value = undefined; error.value = ''; void perform(); });
async function disconnect() {
  try { await ElMessageBox.confirm(translate('清除这台电脑上保存的网页登录状态？'), translate('断开连接') + ' ' + site.value.label, { type: 'warning', confirmButtonText: translate('断开连接'), cancelButtonText: translate('取消') }); }
  catch { return; }
  await perform('disconnect');
}
onMounted(() => {
  void perform();
  interval = setInterval(() => { if (watching && !document.hidden) void perform('refresh', true); }, 5000);
});
onUnmounted(() => { controller.abort(); if (interval) clearInterval(interval); });
</script>
<style scoped>
.doubaoSettings { display: flex; flex-direction: column; gap: var(--settings-gap-section); }
.accountStatus,.actions { display:flex; align-items:center; flex-wrap:wrap; gap:12px; margin-bottom:16px; }
.accountStatus { font-size:13px; color:var(--el-text-color-secondary); }
.quotaGrid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; }
.quotaCard { display:flex; flex-direction:column; gap:10px; padding:18px; border-radius:12px; background:var(--el-fill-color-light); }
.quotaCard strong { font-size:24px; font-variant-numeric:tabular-nums; }
.quotaCard span,.quotaCard small,.hint { color:var(--el-text-color-secondary); font-size:12px; line-height:1.7; }
.networkGuide { display:grid; gap:12px; margin-top:14px; }
.usageValue { color:var(--el-text-color-regular); font-size:13px; font-variant-numeric:tabular-nums; white-space:nowrap; }
.doubaoSettings > .el-radio-group { margin-bottom:18px; }
.networkGuide p { display:grid; grid-template-columns:64px minmax(0,1fr); gap:12px; margin:0; color:var(--el-text-color-secondary); font-size:12px; line-height:1.7; }
.networkGuide strong { color:var(--el-text-color-primary); font-weight:600; }
.hint { margin:12px 0 0; } .error { color:var(--el-color-danger); font-size:13px; }
@media(max-width:520px) { .quotaGrid { grid-template-columns:1fr; } .networkGuide p { grid-template-columns:1fr; gap:3px; } }
</style>
