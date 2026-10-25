<template>
  <div class="doubaoSettings">
    <el-radio-group v-model="platform" :aria-label="translate('选择平台')">
      <el-radio-button value="doubao">豆包</el-radio-button><el-radio-button value="dola">Dola</el-radio-button>
    </el-radio-group>
    <settings-section :title="site.id === 'dola' ? translate('Dola 账号') : translate('豆包账号')" :description="translate('登录后，就能在文本、图片和视频节点里用这个账号生成；用的是账号自己的额度，不扣妙图积分。')">
      <div class="accountList" :aria-label="translate('平台账号列表')">
        <button v-for="account in state?.accounts || []" :key="account.id" type="button" class="accountItem" :class="{ active: account.id === state?.accountId }" :aria-pressed="account.active" :disabled="busy" @click="perform('select-account', false, { accountId: account.id })">
          <span class="accountDot" aria-hidden="true" />
          <span><strong>{{ account.label }}</strong><small>{{ account.active ? translate('当前使用') : translate('切换使用') }}</small></span>
        </button>
        <el-button class="addAccount" :disabled="busy || !state?.available" @click="perform('add-account')">{{ translate('添加账号') }}</el-button>
      </div>
      <div class="accountStatus" role="status">
        <el-tag :type="state?.connected ? 'success' : 'info'">{{ state?.connected ? translate('已连接') : translate('未连接') }}</el-tag>
        <strong v-if="state?.name">{{ state.name }}</strong>
        <span>{{ state?.message || translate('正在读取连接状态…') }}</span>
      </div>
      <div class="actions">
        <el-button type="primary" :loading="busy" :disabled="!state?.available" @click="perform(state?.connected ? 'open' : 'login')">{{ (state?.connected ? translate('打开') : translate('登录')) + ' ' + site.label }}</el-button>
        <el-button :disabled="busy || !state?.available" @click="perform('refresh')">{{ translate('刷新额度') }}</el-button>
        <el-button :disabled="busy" @click="renameAccount">{{ translate('重命名账号') }}</el-button>
        <el-button :disabled="busy || !state?.connected" @click="disconnect">{{ translate('断开连接') }}</el-button>
        <el-button v-if="state?.accountId !== 'default'" :disabled="busy" @click="removeAccount">{{ translate('删除账号') }}</el-button>
      </div>
      <feedbackNotice :message="error" @close="error = ''" />
      <p v-if="state && !state.available" class="hint">{{ translate('请在妙图桌面版里打开这个设置。') }}</p>
    </settings-section>
    <settings-section :title="translate('当前账号模型与参数')" :description="translate('这里显示节点实际使用的模型 ID，以及这个账号当前可选的时长、比例和分辨率。节点里仍可直接修改参数。')">
      <div v-if="mediaModels.length" class="modelList">
        <article v-for="item in mediaModels" :key="item.providerId + ':' + item.modelId" class="modelCard">
          <header>
            <strong>{{ item.label }}</strong>
            <span class="modelTags">
              <el-tag size="small" effect="plain">{{ item.type === 'video' ? translate('视频') : translate('图片') }}</el-tag>
              <el-tag size="small" :type="item.parameterSource === 'preset' ? 'info' : 'success'" effect="plain">{{ translate(item.parameterSource === 'preset' ? '预置参数' : '当前账号菜单') }}</el-tag>
            </span>
          </header>
          <div class="modelIdLine"><span>{{ translate('节点模型 ID') }}</span><code>{{ item.modelId }}</code></div>
          <div v-if="item.upstreamModelId" class="modelIdLine"><span>{{ translate('平台模型 ID') }}</span><code>{{ item.upstreamModelId }}</code></div>
          <dl>
            <div v-if="item.type === 'video'"><dt>{{ translate('时长') }}</dt><dd>{{ durationSummary(item.durations) }}</dd></div>
            <div><dt>{{ translate('比例') }}</dt><dd>{{ item.ratios?.length ? item.ratios.join(' · ') : translate('跟随平台') }}</dd></div>
            <div v-if="item.type === 'video'"><dt>{{ translate('分辨率') }}</dt><dd>{{ item.resolutions?.length ? item.resolutions.join(' · ') : translate('跟随平台') }}</dd></div>
          </dl>
        </article>
      </div>
      <p v-else class="hint">{{ state?.connected ? translate('正在读取这个账号的模型与参数，或当前账号没有开放图片和视频模型。') : translate('连接账号后会显示图片、视频模型及其参数。') }}</p>
      <div v-if="textModels.length" class="textModels">
        <strong>{{ translate('文本模型') }}</strong>
        <div v-for="item in textModels" :key="item.modelId" class="textModelRow">
          <span>{{ item.label }}</span><code>{{ item.modelId }}</code><code v-if="item.upstreamModelId">{{ item.upstreamModelId }}</code>
        </div>
      </div>
    </settings-section>
    <settings-section v-if="state?.pending?.length" :title="translate('还有结果没取回')" :description="translate('在平台窗口里打开那段对话，再点「关联当前对话」；妙图核对提示词后取回结果，不会重新生成。')">
      <settings-row v-for="task in state.pending" :key="task.id" :label="kinds.find(kind => kind.id === task.kind)?.label || task.kind" :description="(task.accountLabel || translate('默认账号')) + ' · ' + new Date(task.createdAt).toLocaleString()">
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
      <p class="hint">{{ translate('每个平台账号使用独立的本机网页登录状态；新生成任务会固定到当时使用的账号，切换默认账号不会把旧任务改到别的账号。') }}</p>
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
import feedbackNotice from '../../components/feedbackNotice.vue';
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
type LocalModel = { providerId: string; modelId: string; upstreamModelId?: string; label: string; type: 'image' | 'video' | 'text'; durations?: number[]; ratios?: string[]; resolutions?: string[]; parameterSource?: 'preset' | 'account' };
type PlatformAccount = { id: string; label: string; createdAt: string; active: boolean };
type State = { available: boolean; connected: boolean; name: string; message: string; checkedAt: string | null; accountId?: string; accounts?: PlatformAccount[]; image: Quota; video: Quota; text: Quota; models?: LocalModel[]; textModels?: LocalModel[]; usage: Record<Kind, { submitted: number; succeeded: number; pending: number; confirming: number }>; pending: { id: string; kind: Kind; status: string; createdAt: string; needsBinding: boolean; accountId?: string; accountLabel?: string }[] };
const state = ref<State>(), error = ref(''), busy = ref(false);
const platform = ref<'doubao' | 'dola'>('doubao');
const site = computed(() => ({ id: platform.value, label: platform.value === 'doubao' ? '豆包' : 'Dola' }));
const kinds = [{ id: 'text' as const, label: translate('文本对话') }, { id: 'image' as const, label: translate('图片生成') }, { id: 'video' as const, label: translate('视频生成') }];
const mediaModels = computed(() => state.value?.models || []);
const textModels = computed(() => state.value?.textModels || []);
const scope = captureWorkspaceScope(), controller = new AbortController();
let routeController = new AbortController(), revision = 0;
let interval: ReturnType<typeof setInterval> | undefined, watching = false;
const quota = (kind: Kind) => state.value?.[kind];
const usage = (kind: Kind) => state.value?.usage[kind];
function durationSummary(values?: number[]) {
  const items = [...new Set((values || []).filter(Number.isFinite))].sort((left, right) => left - right);
  if (!items.length) return translate('跟随平台');
  return items.length > 2 && items.every((value, index) => !index || value === items[index - 1] + 1)
    ? translate('{0}–{1} 秒', { 0: items[0], 1: items.at(-1) })
    : items.map(value => translate('{0} 秒', { 0: value })).join(' · ');
}
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
async function renameAccount() {
  if (!state.value?.accountId) return;
  const current = state.value.accounts?.find(account => account.id === state.value?.accountId);
  try { const { value } = await ElMessageBox.prompt(translate('给这个平台账号起一个方便区分的名称。'), translate('重命名账号'), { inputValue: current?.label || '', inputPattern: /\S/, inputErrorMessage: translate('账号名称不能为空'), confirmButtonText: translate('保存'), cancelButtonText: translate('取消') }); await perform('rename-account', false, { accountId: state.value.accountId, label: value }); }
  catch { /* cancelled */ }
}
async function removeAccount() {
  if (!state.value?.accountId) return;
  const current = state.value.accounts?.find(account => account.id === state.value?.accountId);
  try { await ElMessageBox.confirm(translate('清除“{0}”在这台电脑上保存的网页登录状态？已有任务会要求先处理完成。', { 0: current?.label || translate('这个账号') }), translate('删除账号'), { type: 'warning', confirmButtonText: translate('删除账号'), cancelButtonText: translate('取消') }); await perform('remove-account', false, { accountId: state.value.accountId }); }
  catch { /* cancelled */ }
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
.accountList { display:flex; flex-wrap:wrap; gap:10px; margin-bottom:16px; }
.accountItem { display:flex; align-items:center; gap:10px; min-width:150px; padding:10px 13px; border:1px solid var(--el-border-color); border-radius:12px; background:transparent; color:var(--el-text-color-secondary); text-align:left; cursor:pointer; }
.modelTags { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
.accountItem:hover { color:var(--el-text-color-primary); background:var(--el-fill-color-light); }
.accountItem.active { color:var(--el-text-color-primary); border-color:var(--el-color-primary); background:color-mix(in srgb,var(--el-color-primary) 9%,transparent); }
.accountItem:disabled { cursor:default; opacity:.65; }
.accountDot { width:8px; height:8px; flex:0 0 auto; border-radius:999px; background:var(--el-border-color-dark); }
.accountItem.active .accountDot { background:var(--el-color-success); box-shadow:0 0 0 3px color-mix(in srgb,var(--el-color-success) 18%,transparent); }
.accountItem span:last-child { display:grid; gap:2px; }
.accountItem strong { font-size:13px; font-weight:600; }
.accountItem small { font-size:11px; color:var(--el-text-color-secondary); }
.addAccount { min-height:42px; border-style:dashed; border-radius:12px; }
.modelList { display:grid; gap:12px; }
.modelCard { padding:15px 16px; border:1px solid var(--el-border-color-lighter); border-radius:12px; background:var(--el-fill-color-light); }
.modelCard header { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:12px; }
.modelCard header strong { color:var(--el-text-color-primary); font-size:14px; }
.modelIdLine { display:grid; grid-template-columns:92px minmax(0,1fr); gap:10px; align-items:start; margin:6px 0; font-size:12px; color:var(--el-text-color-secondary); }
.modelIdLine code,.textModelRow code { min-width:0; overflow-wrap:anywhere; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--el-text-color-primary); }
.modelCard dl { display:grid; gap:7px; margin:12px 0 0; padding-top:12px; border-top:1px solid var(--el-border-color-lighter); }
.modelCard dl div { display:grid; grid-template-columns:64px minmax(0,1fr); gap:10px; }
.modelCard dt { color:var(--el-text-color-secondary); font-size:12px; }
.modelCard dd { margin:0; color:var(--el-text-color-regular); font-size:12px; line-height:1.55; overflow-wrap:anywhere; }
.textModels { display:grid; gap:8px; margin-top:16px; }
.textModels > strong { font-size:13px; color:var(--el-text-color-primary); }
.textModelRow { display:grid; grid-template-columns:minmax(110px,.7fr) minmax(0,1fr); gap:8px 12px; align-items:start; padding:10px 12px; border-radius:10px; background:var(--el-fill-color-light); font-size:12px; }
.textModelRow code:last-child:not(:nth-child(2)) { grid-column:2; color:var(--el-text-color-secondary); }
.quotaGrid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; }
.quotaCard { display:flex; flex-direction:column; gap:10px; padding:18px; border-radius:12px; background:var(--el-fill-color-light); }
.quotaCard strong { font-size:24px; font-variant-numeric:tabular-nums; }
.quotaCard span,.quotaCard small,.hint { color:var(--el-text-color-secondary); font-size:12px; line-height:1.7; }
.networkGuide { display:grid; gap:12px; margin-top:14px; }
.usageValue { color:var(--el-text-color-regular); font-size:13px; font-variant-numeric:tabular-nums; white-space:nowrap; }
.doubaoSettings > .el-radio-group { display:inline-flex; width:max-content; gap:10px; margin-bottom:18px; }
.doubaoSettings > .el-radio-group :deep(.el-radio-button__inner) {
  min-width:82px;
  border:0;
  border-radius:999px !important;
  background:transparent;
  box-shadow:inset 0 0 0 1px var(--el-border-color);
  transition:background .2s,color .2s,box-shadow .2s;
}
.doubaoSettings > .el-radio-group :deep(.el-radio-button__inner:hover) {
  color:var(--el-text-color-primary);
  box-shadow:inset 0 0 0 1px var(--el-border-color-hover,var(--el-border-color));
}
.doubaoSettings > .el-radio-group :deep(.el-radio-button.is-active .el-radio-button__inner) {
  background:var(--el-color-primary);
  color:var(--settings-accent-ink, #151515);
  box-shadow:0 0 0 1px var(--el-color-primary),0 0 18px -4px var(--el-color-primary);
}
.networkGuide p { display:grid; grid-template-columns:64px minmax(0,1fr); gap:12px; margin:0; color:var(--el-text-color-secondary); font-size:12px; line-height:1.7; }
.networkGuide strong { color:var(--el-text-color-primary); font-weight:600; }
.hint { margin:12px 0 0; } .error { color:var(--el-color-danger); font-size:13px; }
@media(max-width:520px) { .quotaGrid { grid-template-columns:1fr; } .networkGuide p,.modelIdLine { grid-template-columns:1fr; gap:3px; } .textModelRow { grid-template-columns:1fr; } .textModelRow code:last-child:not(:nth-child(2)) { grid-column:1; } }
</style>
