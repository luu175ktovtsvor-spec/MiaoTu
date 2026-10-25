<template>
  <div class="skillSettings">
    <div class="skillToolbar">
      <label class="skillSearch">
        <IconSearch :size="16" aria-hidden="true" />
        <input v-model="query" type="search" :placeholder="translate('搜索技能')" :aria-label="translate('搜索技能')" />
      </label>
      <span v-if="skills.length" class="skillCount"><strong>{{ enabledCount }}</strong> / {{ skills.length }}<span>{{ translate('已启用') }}</span></span>
    </div>
    <div class="skillNote">
      <p>{{ translate('Agent 按任务选择已启用的技能，也可在对话框输入 / 手动指定。') }}</p>
      <p v-if="isDesktop">{{ translate('开启本机操作后，还会读取你个人目录和当前工作文件夹里 .agents/skills 下的技能。') }}</p>
    </div>
    <feedbackNotice :message="error" @close="error = ''" />
    <div v-if="filtered.length" class="skillGrid">
      <article v-for="skill in filtered" :key="skill.id" class="skillCard" :class="{ isOn: skill.enabled }">
        <header>
          <span class="skillIcon"><component :is="skill.local ? IconFolderCode : skill.builtin ? IconSparkles : IconStack2" :size="19" aria-hidden="true" /></span>
          <span class="skillSource">{{ translate(skill.local ? '本地技能' : skill.builtin ? '内置技能' : '工作区技能') }}</span>
          <el-switch :model-value="skill.enabled" :loading="pending === skill.id" :disabled="!!pending" :aria-label="translate('启用 {0}', { 0: skillLabel(skill) })" @change="toggle(skill, Boolean($event))" />
        </header>
        <h3>{{ skillLabel(skill) }}</h3>
        <p :title="skillText(skill)">{{ skillText(skill) }}</p>
      </article>
    </div>
    <p v-else class="skillEmpty">{{ loading ? translate('加载中...') : translate('没有匹配的技能') }}</p>
  </div>
</template>
<script setup lang="ts">
import feedbackNotice from '../../components/feedbackNotice.vue';
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { locale, translate } from '@miaoimg/i18n/vue';
import { IconFolderCode, IconSearch, IconSparkles, IconStack2 } from '@tabler/icons-vue';
import { workspaceHeaders, captureWorkspaceScope, assertWorkspaceScope } from '@/lib/workspaceRemote';
type Skill = { id: string; name: string; displayName?: string; displayNameEn?: string; description: string; descriptionEn?: string; enabled: boolean; local?: boolean; builtin?: boolean };
const scope = captureWorkspaceScope(), controller = new AbortController();
const isDesktop = Boolean(window.miaoDesktop);
const skills = ref<Skill[]>([]), query = ref(''), error = ref(''), pending = ref(''), loading = ref(true);
const skillLabel = (skill: Skill) => (locale.value.startsWith('zh') ? skill.displayName : skill.displayNameEn) || skill.displayName || skill.name;
const skillText = (skill: Skill) => (locale.value.startsWith('zh') ? skill.description : skill.descriptionEn) || skill.description;
const enabledCount = computed(() => skills.value.filter(item => item.enabled).length);
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
/* 官网 landing.css 的部件：搜索 = .site-command，计数 = .site-changelog-version span，
   卡片 = .site-feature-grid article（细线、3% 高光、悬停蓝光与顶边流光），图标底座 = .site-feature-icon。 */
.skillSettings { --skill-flow: #4c9dff; display: grid; gap: 16px; }
.skillToolbar { display: flex; align-items: center; gap: 12px; }
.skillSearch { display: flex; flex: 1; min-width: 0; height: 42px; align-items: center; gap: 10px; padding: 0 16px; border-radius: 999px; background: var(--color-abyss, var(--el-bg-color)); box-shadow: inset 0 0 0 1px var(--el-border-color); color: var(--el-text-color-placeholder); transition: box-shadow .2s; }
.skillSearch:hover { box-shadow: inset 0 0 0 1px var(--el-border-color-hover, var(--el-border-color)); }
.skillSearch:focus-within { box-shadow: inset 0 0 0 1px rgb(76 157 255 / .7), 0 0 0 3px rgb(76 157 255 / .14); color: #9cc8ff; }
.skillSearch input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--el-text-color-primary); font: inherit; font-size: 13px; }
.skillSearch input::placeholder { color: var(--el-text-color-placeholder); }
.skillSearch input::-webkit-search-cancel-button { filter: invert(.6); }
.skillCount { display: inline-flex; flex: none; align-items: center; gap: 4px; height: 30px; padding: 0 12px; border-radius: 999px; background: rgb(76 157 255 / .12); box-shadow: inset 0 0 0 1px rgb(76 157 255 / .4), 0 0 16px -4px rgb(76 157 255 / .6); color: #9cc8ff; font-size: 12px; font-variant-numeric: tabular-nums; letter-spacing: .04em; white-space: nowrap; }
.skillCount strong { color: #fff; font-weight: 650; }
.skillCount span { margin-left: 4px; }
.skillNote { display: grid; gap: 2px; padding: 0 4px; }
.skillNote p { margin: 0; color: var(--el-text-color-secondary); font-size: 12.5px; line-height: 1.9; letter-spacing: .02em; }
.skillError { margin: 0; padding: 2px 0 2px 12px; border-left: 2px solid #e5484d; color: var(--el-text-color-regular); font-size: 13px; line-height: 1.7; }
.skillGrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; }
.skillCard { position: relative; display: flex; min-width: 0; flex-direction: column; gap: 10px; overflow: hidden; padding: 20px 22px 22px; border: 1px solid var(--el-border-color); border-radius: 20px; background: linear-gradient(180deg, rgb(255 255 255 / .03), transparent 60%); transition: border-color .3s, background .3s, box-shadow .3s; }
.skillCard::after { position: absolute; top: 0; right: 28px; left: 28px; height: 1px; background: linear-gradient(90deg, transparent, var(--skill-flow), transparent); content: ""; opacity: 0; pointer-events: none; transition: opacity .4s; }
.skillCard.isOn::after { opacity: .55; }
.skillCard:hover { border-color: #505050; background: linear-gradient(180deg, rgb(255 255 255 / .05), transparent 60%); box-shadow: 0 0 0 1px rgb(76 157 255 / .2), 0 20px 50px -20px rgb(76 157 255 / .35); }
.skillCard:hover::after { opacity: .9; }
.skillCard header { display: flex; align-items: center; gap: 10px; }
.skillIcon { display: grid; width: 40px; height: 40px; flex: none; place-items: center; border: 1px solid #363636; border-radius: 12px; background: #262626; color: var(--el-text-color-secondary); transition: color .3s, box-shadow .3s, border-color .3s; }
.skillCard.isOn .skillIcon { border-color: rgb(76 157 255 / .45); color: #9cc8ff; box-shadow: 0 0 18px -4px rgb(76 157 255 / .6); }
.skillSource { padding: 2px 9px; border-radius: 999px; background: rgb(255 255 255 / .06); color: var(--el-text-color-secondary); font-size: 11px; font-weight: 550; letter-spacing: .06em; }
.skillCard header .el-switch { margin-left: auto; }
.skillCard h3 { margin: 4px 0 0; color: var(--el-text-color-primary); font-size: 16px; font-weight: 600; letter-spacing: .01em; line-height: 1.4; overflow-wrap: anywhere; transition: opacity .3s; }
.skillCard p { display: -webkit-box; margin: 0; overflow: hidden; color: var(--el-text-color-secondary); font-size: 13px; line-height: 1.85; letter-spacing: .02em; overflow-wrap: anywhere; -webkit-box-orient: vertical; -webkit-line-clamp: 3; transition: opacity .3s; }
.skillCard:not(.isOn) :is(h3, p) { opacity: .6; }
.skillEmpty { margin: 0; padding: 44px 20px; border: 1px dashed var(--el-border-color); border-radius: 20px; color: var(--el-text-color-secondary); font-size: 13px; text-align: center; }
@media (prefers-reduced-motion: reduce) { .skillCard, .skillCard::after, .skillIcon { transition: none; } }
</style>
