<template>
  <div class="skillSettings">
    <el-input v-model="query" clearable :placeholder="translate('搜索技能')" :aria-label="translate('搜索技能')" />
    <p>{{ translate('Agent 按任务选择已启用的技能，也可在对话框输入 / 手动指定。') }}</p>
    <p v-if="isDesktop">{{ translate('开启本机操作后，会发现个人和当前文件夹的 .agents/skills。') }}</p>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <div v-if="filtered.length" class="skillList">
      <div v-for="skill in filtered" :key="skill.id" class="skillRow">
        <div><strong>{{ skillLabel(skill) }}</strong><p><span class="skillSource">{{ translate(skill.local ? '本地技能' : skill.builtin ? '内置技能' : '工作区技能') }}</span>{{ skillText(skill) }}</p></div>
        <el-switch :model-value="skill.enabled" :loading="pending === skill.id" :disabled="!!pending" :aria-label="translate('启用 {0}', { 0: skillLabel(skill) })" @change="toggle(skill, Boolean($event))" />
      </div>
    </div>
    <p v-if="!filtered.length">{{ loading ? translate('加载中...') : translate('没有匹配的技能') }}</p>
  </div>
</template>
<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { locale, translate } from '@miaoimg/i18n/vue';
import { workspaceHeaders, captureWorkspaceScope, assertWorkspaceScope } from '@/lib/workspaceRemote';
type Skill = { id: string; name: string; displayName?: string; displayNameEn?: string; description: string; descriptionEn?: string; enabled: boolean; local?: boolean; builtin?: boolean };
const scope = captureWorkspaceScope(), controller = new AbortController();
const isDesktop = Boolean(window.miaoDesktop);
const skills = ref<Skill[]>([]), query = ref(''), error = ref(''), pending = ref(''), loading = ref(true);
const skillLabel = (skill: Skill) => (locale.value.startsWith('zh') ? skill.displayName : skill.displayNameEn) || skill.displayName || skill.name;
const skillText = (skill: Skill) => (locale.value.startsWith('zh') ? skill.description : skill.descriptionEn) || skill.description;
const filtered = computed(() => skills.value.filter(item => `${item.displayName} ${item.displayNameEn} ${item.name} ${item.description} ${item.descriptionEn}`.toLowerCase().includes(query.value.trim().toLowerCase())));
function assertActive() { assertWorkspaceScope(scope); controller.signal.throwIfAborted(); }
async function request(init?: RequestInit) {
  assertActive();
  const response = await fetch('/api/agent/skills?all=1', { ...init, cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]), headers: { ...workspaceHeaders(scope.owner), 'x-miaoimg-workspace': '1', 'content-type': 'application/json' } });
  try { assertActive(); }
  catch (cause) { await response.body?.cancel().catch(() => {}); throw cause; }
  const data = await response.json().catch(() => undefined);
  assertActive();
  if (!response.ok) throw new Error(data?.error || data?.message || translate('操作未完成，请重试。'));
  if (data?.code !== 200 || !Object.hasOwn(data, 'data')) throw new Error(translate('操作结果尚未确认，请保留当前内容并核对后再继续'));
  return data.data;
}
async function toggle(skill: Skill, enabled: boolean) {
  if (pending.value) return;
  pending.value = skill.id; error.value = '';
  try {
    const data = await request({ method: 'POST', body: JSON.stringify({ operation: 'enabled', name: skill.id, enabled }) });
    assertActive();
    if (data?.id !== skill.id || data.enabled !== enabled) throw new Error(translate('操作结果尚未确认，请保留当前内容并核对后再继续'));
    skill.enabled = enabled;
    window.dispatchEvent(new Event('miaoimg:skills-changed'));
  }
  catch (cause) { if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { pending.value = ''; }
}
onMounted(async () => {
  try {
    const data = await request();
    assertActive();
    if (!Array.isArray(data) || data.some(skill => !skill || typeof skill.id !== 'string' || !skill.id || typeof skill.name !== 'string' || typeof skill.description !== 'string' || typeof skill.enabled !== 'boolean')) throw new Error(translate('读取技能失败'));
    skills.value = data;
  } catch (cause) { if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { loading.value = false; }
});
onBeforeUnmount(() => controller.abort());
</script>
<style scoped>
.skillSettings > p, .skillRow p { font-size: 12px; line-height: 1.6; color: var(--el-text-color-secondary); }
.skillRow { display: flex; align-items: center; gap: 20px; padding: 14px 0; }
.skillRow > div:first-child { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.skillRow strong { font-size: 14px; }
.skillRow p { margin: 6px 0 0; }
.error { color: var(--el-color-danger) !important; }
</style>
