<template>
  <div class="doubaoSettings">
    <el-radio-group v-model="platform" :aria-label="translate('选择平台')">
      <el-radio-button value="doubao">豆包</el-radio-button><el-radio-button value="dola">Dola</el-radio-button>
    </el-radio-group>
    <settings-section :title="site.id === 'dola' ? translate('Dola 账号') : translate('豆包账号')" :description="translate('登录后，在妙图文本、图片和视频节点中使用该账户。')">
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
      <p v-if="state && !state.available" class="hint">{{ translate('请从妙图桌面客户端打开此设置。') }}</p>
    </settings-section>
    <settings-section v-if="state?.pending?.length" :title="translate('原任务待取回')" :description="translate('提交编号丢失时，先在平台窗口找到原对话，再关联当前对话；妙图会核对原提示词，不会重发。')">
      <settings-row v-for="task in state.pending" :key="task.id" :label="kinds.find(kind => kind.id === task.kind)?.label || task.kind" :description="new Date(task.createdAt).toLocaleString()">
        <el-button v-if="task.needsBinding" :disabled="busy" @click="perform('bind-current', false, { requestId: task.id })">{{ translate('关联当前对话') }}</el-button>
        <span v-else>{{ translate('正在查询原任务') }}</span>
      </settings-row>
    </settings-section>
    <settings-section :title="site.label + ' ' + translate('剩余额度')" :description="translate('仅显示平台明确提供的剩余值；页面未提供时显示未知。')">
      <div class="quotaGrid">
        <div v-for="kind in kinds" :key="kind.id" class="quotaCard">
          <span>{{ kind.label }}</span>
          <strong>{{ quota(kind.id)?.remaining == null ? translate('未知') : `${quota(kind.id)?.remaining} ${quota(kind.id)?.unit}` }}</strong>
          <small>{{ quota(kind.id)?.source === 'platform' ? translate('平台页面返回') : translate('平台尚未提供可读取的额度') }}</small>
        </div>
      </div>
      <p class="hint">{{ translate('额度仍属于平台账户。此路由使用该账户权益，不扣妙图积分。') }}</p>
      <p v-if="state?.checkedAt" class="hint">{{ translate('最近检查') }}：{{ new Date(state.checkedAt).toLocaleString() }}</p>
    </settings-section>
    <settings-section :title="translate('今日妙图用量')" :description="translate('仅统计此妙图账户在这台电脑发起的任务，不代表平台全账户消耗。')">
      <settings-row v-for="kind in kinds" :key="kind.id" :label="kind.label" control-width="auto">
        <span class="usageValue">{{ translate('已受理') }} {{ usage(kind.id)?.submitted || 0 }} · {{ translate('已完成') }} {{ usage(kind.id)?.succeeded || 0 }} · {{ translate('待取回') }} {{ usage(kind.id)?.pending || 0 }}<template v-if="usage(kind.id)?.confirming"> · {{ translate('待确认') }} {{ usage(kind.id)?.confirming }}</template></span>
      </settings-row>
    </settings-section>
    <settings-section :title="translate('在节点中使用')" :description="translate('在文本、图片或视频节点的模型菜单里，选择「豆包」或「Dola」分组下的模型。')">
      <p class="hint">{{ translate('在节点选择具体型号、时长和比例；仅在平台开放时提供分辨率选项，否则明确跟随平台。页面要求确认或验证时，在原窗口处理后继续取回。') }}</p>
      <local-media-info :model="{ providerId: platform + '-local', modelId: platform + '-local-video' }" />
      <p class="hint">{{ translate('豆包、Dola 的文本模型用于文本节点的回复；Agent 和 3D 导演台请在「文本模型」里选择妙图模型或你接入的模型。') }}</p>
      <p class="hint">{{ translate('网页登录状态仅保存在这台电脑，按平台和妙图账户隔离。断开连接只清除此处的网页登录状态。') }}</p>
    </settings-section>
    <settings-section :title="translate('地区与网络自检')" :description="translate('平台会按当前网络出口 IP 判断可用地区，以下为实际支持情况。')">
      <details class="networkDetails" :open="platform === 'dola' && !state?.connected">
      <summary>{{ translate('查看各平台的网络要求') }}</summary>
      <div class="networkGuide">
        <p><strong>Dola</strong><span>{{ translate('Dola 根据登录和提交时的网络出口 IP 判断地区，官方页面没有公开一份固定国家清单。2026-10-22 实测：日本可以进入创作区；美国、加拿大、澳大利亚、印度和中国大陆会进入“受区域限制”页面。其他地区以 Dola 页面是否允许进入创作区为准。') }}</span></p>
        <p><strong>豆包</strong><span>{{ translate('豆包服务面向可访问其网页的地区，是否会提示地区限制以豆包页面为准。妙图不会根据网络名称猜测账号可用性。') }}</span></p>
        <p><strong>{{ translate('自检') }}</strong><span>{{ translate('先确认平台页面能打开、登录框能加载，再登录并读取当前账号的模型菜单。出现地区限制、验证、超时或登录失败时分别处理。') }}</span></p>
        <p><strong>{{ translate('验收边界') }}</strong><span>{{ translate('页面、登录和模型菜单能正常打开即确认平台连接可用；真正生成时再核对账户额度与生成权限。') }}</span></p>
      </div>
      </details>
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
  try { await ElMessageBox.confirm(translate('清除此妙图账户在本机保存的网页登录状态？'), translate('断开连接') + ' ' + site.value.label, { type: 'warning', confirmButtonText: translate('断开连接'), cancelButtonText: translate('取消') }); }
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
.networkDetails summary { cursor:pointer; color:var(--el-text-color-regular); font-size:13px; font-weight:500; }
.networkDetails summary:hover { color:var(--el-text-color-primary); }
.usageValue { color:var(--el-text-color-regular); font-size:13px; font-variant-numeric:tabular-nums; white-space:nowrap; }
.doubaoSettings > .el-radio-group { margin-bottom:18px; }
.networkGuide p { display:grid; grid-template-columns:64px minmax(0,1fr); gap:12px; margin:0; color:var(--el-text-color-secondary); font-size:12px; line-height:1.7; }
.networkGuide strong { color:var(--el-text-color-primary); font-weight:600; }
.hint { margin:12px 0 0; } .error { color:var(--el-color-danger); font-size:13px; }
@media(max-width:520px) { .quotaGrid { grid-template-columns:1fr; } .networkGuide p { grid-template-columns:1fr; gap:3px; } }
</style>
