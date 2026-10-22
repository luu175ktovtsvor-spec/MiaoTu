<template>
  <div class="pluginPanel">
    <p class="intro">{{ translate('妙图自带内置节点，也可以安装插件节点与 Agent 技能。这里控制「添加节点」菜单里出现哪些节点，关闭不影响画布上已有的节点。') }}</p>

    <nav class="typeTabs" :aria-label="translate('节点与工具分类')">
      <button class="typeTab" type="button" :aria-pressed="activeTab === 'node'" @click="activeTab = 'node'">
        {{ translate('节点') }}<span class="typeCount">{{ nodeCatalog.length + plugins.length }}</span>
      </button>
      <button class="typeTab" type="button" :aria-pressed="activeTab === 'skill'" @click="activeTab = 'skill'">
        {{ translate('技能') }}<span class="typeCount">{{ skills.length }}</span>
      </button>
      <button class="typeTab" type="button" :aria-pressed="activeTab === 'ext'" @click="activeTab = 'ext'">
        {{ translate('文件扩展') }}<span class="typeCount">{{ extensions.length }}</span>
      </button>
    </nav>

    <el-alert v-if="error" :title="error" type="error" :closable="false" showIcon />
    <el-alert v-else-if="message" :title="message" type="success" :closable="false" showIcon />

    <template v-if="activeTab === 'node'">
      <el-card class="groupCard" shadow="never">
        <div class="groupHeader">{{ translate('内置节点') }}</div>
        <div v-for="item in nodeCatalog" :key="item.type" class="pluginRow">
          <div class="pluginInfo">
            <span class="pluginName">{{ translate(item.label) }}</span>
            <span class="pluginId">{{ item.type }}</span>
          </div>
          <div class="pluginActions">
            <el-switch :modelValue="!disabled.includes(item.type)" :aria-label="translate('启用 {0}', { 0: translate(item.label) })" @update:modelValue="(value) => setDisabled(item.type, value === true)" />
          </div>
        </div>
      </el-card>

      <el-card class="groupCard" shadow="never">
        <div class="groupHeader">
          <span>{{ translate('插件节点') }}</span>
          <div class="headerActions">
            <el-button text :icon="IconRefresh" :loading="loading" @click="refresh()">{{ translate('刷新') }}</el-button>
            <el-button text type="primary" :icon="IconUpload" :loading="installing" @click="pickFile">{{ translate('安装插件…') }}</el-button>
            <el-button text :icon="IconLink" @click="openUrlInstall('node')">{{ translate('从链接安装') }}</el-button>
          </div>
        </div>
        <p v-if="!plugins.length" class="emptyHint">{{ translate('还没有安装插件节点。插件是妙图节点包，构建时把 vue、@vue-flow/core、element-plus 交给宿主提供。') }}</p>
        <div v-for="plugin in plugins" :key="plugin.name" class="pluginRow">
          <div class="pluginInfo">
            <span class="pluginName">{{ plugin.displayName }}</span>
            <span class="pluginId">{{ plugin.name }}{{ plugin.version ? ' · v' + plugin.version : '' }}{{ plugin.author ? ' · ' + plugin.author : '' }}</span>
          </div>
          <div class="pluginActions">
            <el-switch :modelValue="plugin.enabled !== false" :aria-label="translate('启用 {0}', { 0: plugin.displayName })" :loading="toggling === plugin.name" @update:modelValue="(value) => toggle(plugin, value === true)" />
            <el-button v-if="plugin.configRules?.length" text :icon="IconSettings" :aria-label="translate('配置 {0}', { 0: plugin.displayName })" @click="openConfig(plugin)">{{ translate('配置') }}</el-button>
            <el-popconfirm :title="translate('确定卸载这个插件节点？')" :confirmButtonText="translate('卸载')" :cancelButtonText="translate('取消')" @confirm="remove(plugin)">
              <template #reference><el-button text type="danger" :icon="IconTrash" :loading="removing === plugin.name" :aria-label="translate('卸载 {0}', { 0: plugin.displayName })" /></template>
            </el-popconfirm>
          </div>
        </div>
      </el-card>
    </template>

    <template v-else-if="activeTab === 'skill'">
      <el-card class="groupCard" shadow="never">
        <div class="groupHeader">
          <span>{{ translate('Agent 技能') }}</span>
          <div class="headerActions">
            <el-button text :icon="IconRefresh" :loading="skillsLoading" @click="refreshSkills()">{{ translate('刷新') }}</el-button>
            <el-button text :icon="IconFileText" @click="openSkillEditor()">{{ translate('新建技能') }}</el-button>
            <el-button text type="primary" :icon="IconUpload" @click="skillFileInput?.click()">{{ translate('导入 SKILL.md') }}</el-button>
            <el-button text :icon="IconPackage" @click="skillPackageInput?.click()">{{ translate('导入技能包') }}</el-button>
            <el-button text :icon="IconLink" @click="openUrlInstall('skill')">{{ translate('从链接安装') }}</el-button>
          </div>
        </div>
        <p v-if="!skills.length" class="emptyHint">{{ translate('还没有技能。技能是带 name 和 description 的 SKILL.md，在 Agent 输入框用 /skill:名称 调用。') }}</p>
        <div v-for="skill in skills" :key="skill.id" class="pluginRow">
          <div class="pluginInfo">
            <span class="pluginName">{{ skillLabel(skill) }}<el-tag v-if="skill.builtin || skill.local" size="small" type="info">{{ translate(skill.local ? '本地技能' : '内置') }}</el-tag></span>
            <span class="pluginId">{{ skillText(skill) || translate('未填写描述') }}</span>
          </div>
          <div v-if="!skill.builtin && !skill.local" class="pluginActions">
            <el-button text :icon="IconEdit" :aria-label="translate('编辑 {0}', { 0: skill.name })" @click="openSkillEditor(skill)">{{ translate('编辑') }}</el-button>
            <el-popconfirm :title="translate('确定删除这个技能？')" :confirmButtonText="translate('删除')" :cancelButtonText="translate('取消')" @confirm="removeSkill(skill)">
              <template #reference><el-button text type="danger" :icon="IconTrash" :aria-label="translate('删除 {0}', { 0: skill.name })" /></template>
            </el-popconfirm>
          </div>
        </div>
      </el-card>
    </template>

    <template v-else>
      <el-card class="groupCard" shadow="never">
        <div class="groupHeader">
          <span>{{ translate('文件扩展') }}</span>
          <div class="headerActions">
            <el-button text :icon="IconRefresh" :loading="extensionsLoading" @click="refreshExtensions()">{{ translate('刷新') }}</el-button>
            <el-button text :icon="IconSettings" @click="openAssociations">{{ translate('默认打开方式') }}</el-button>
            <el-button text type="primary" :icon="IconUpload" :loading="extensionsInstalling" @click="extensionFileInput?.click()">{{ translate('安装扩展…') }}</el-button>
            <el-button text :icon="IconLink" @click="openUrlInstall('ext')">{{ translate('从链接安装') }}</el-button>
          </div>
        </div>
        <p class="emptyHint">{{ translate('文件扩展决定工作区里的文件用什么打开。内置扩展随妙图发布，也可以安装其他人为妙图构建的扩展。') }}</p>
        <div v-for="extension in extensions" :key="extension.id" class="pluginRow">
          <div class="pluginInfo">
            <span class="pluginName">
              <img v-if="extension.icon" class="extensionIcon" :src="extension.icon" alt="" />
              {{ extension.displayName }}
              <el-tag v-if="extension.builtin" size="small" type="info">{{ translate('内置') }}</el-tag>
            </span>
            <span class="pluginId">{{ extension.id }}{{ extension.version ? ' · v' + extension.version : '' }} · {{ extensionKind(extension) }}</span>
            <span v-if="extension.loadError" class="pluginError">{{ extension.loadError }}</span>
          </div>
          <div class="pluginActions">
            <el-switch :modelValue="extension.enabled" :aria-label="translate('启用 {0}', { 0: extension.displayName })" :loading="extensionToggling === extension.id" @update:modelValue="(value) => toggleExtension(extension, value === true)" />
            <el-button v-if="extension.configRules?.length" text :icon="IconSettings" :aria-label="translate('配置 {0}', { 0: extension.displayName })" @click="openExtensionConfig(extension)">{{ translate('配置') }}</el-button>
            <el-popconfirm v-if="!extension.builtin" :title="translate('确定卸载这个文件扩展？')" :confirmButtonText="translate('卸载')" :cancelButtonText="translate('取消')" @confirm="removeExtension(extension)">
              <template #reference><el-button text type="danger" :icon="IconTrash" :loading="extensionRemoving === extension.id" :aria-label="translate('卸载 {0}', { 0: extension.displayName })" /></template>
            </el-popconfirm>
          </div>
        </div>
      </el-card>
    </template>

    <input ref="fileInput" class="fileInput" type="file" accept=".js,text/javascript" :aria-label="translate('选择节点插件文件')" @change="installFile" />
    <input ref="skillFileInput" class="fileInput" type="file" accept=".md,text/markdown" :aria-label="translate('选择技能文件')" @change="importSkillFile" />

    <input ref="skillPackageInput" class="fileInput" type="file" accept=".zip,.tar,.tar.gz,.tgz" :aria-label="translate('选择技能包文件')" @change="importSkillPackage" />

    <input ref="extensionFileInput" class="fileInput" type="file" accept=".js,text/javascript" :aria-label="translate('选择文件扩展')" @change="installExtensionFile" />

    <component :is="configDialog" v-model="configVisible" :plugin="configPlugin" @saved="applyConfig" />
    <component :is="extensionConfigDialog" v-model="extensionConfigVisible" :extension="extensionConfigTarget" />
    <component :is="associationsDialog" v-model="associationsVisible" />
    <component :is="urlDialog" v-model="urlVisible" :kind="urlKind" @installed="onUrlInstalled" />

    <el-dialog v-model="skillEditorVisible" :title="skillEditing ? translate('编辑技能') : translate('新建技能')" width="min(760px, calc(100vw - 32px))" alignCenter appendToBody>
      <el-form labelPosition="top">
        <el-form-item :label="translate('技能名称')">
          <el-input v-model="skillName" :disabled="!!skillEditing || skillSaving" :placeholder="translate('例如 storyboard')" :aria-label="translate('技能名称')" />
        </el-form-item>
        <el-form-item :label="translate('SKILL.md 内容')">
          <el-input v-model="skillContent" type="textarea" :disabled="skillLoading || skillSaving || !skillReady" :autosize="{ minRows: 12, maxRows: 22 }" :aria-label="translate('技能内容')" :placeholder="translate('# 技能标题\n描述这个技能适合什么任务。')" />
        </el-form-item>
      </el-form>
      <p v-if="skillLoading" role="status">{{ translate('加载中...') }}</p>
      <el-alert v-if="skillError" :title="skillError" type="error" :closable="false" showIcon />
      <template #footer>
        <el-button @click="skillEditorVisible = false">{{ translate('取消') }}</el-button>
        <el-button type="primary" :loading="skillSaving" :disabled="skillLoading || !skillReady" @click="saveSkill">{{ translate('保存') }}</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { locale, translate } from "@miaoimg/i18n/vue";
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, shallowRef, watch, type Component } from "vue";
import { ElAlert, ElButton, ElCard, ElDialog, ElForm, ElFormItem, ElInput, ElPopconfirm, ElSwitch, ElTag } from "element-plus";
import { IconEdit, IconFileText, IconLink, IconPackage, IconRefresh, IconSettings, IconTrash, IconUpload } from "@tabler/icons-vue";
import { nodeCatalog, nodeSettings, updateNodeSettings } from "@/stores/settings";
import { listExtensions, type InstalledExtension } from "@/studio/canvas/ext";
import type { ConfigRule } from "./pluginConfigDialog.vue";
import { forceInstall } from "../../installOptions";
import { captureWorkspaceScope, assertWorkspaceScope, subscribeWorkspaceScope, workspaceHeaders } from "@/lib/workspaceRemote";
import { skillNameFromFileName } from "../../../../../../../../server/skill-names.ts";

type PluginEntry = { name: string; displayName: string; enabled?: boolean; author?: string; version?: string; config?: Record<string, unknown>; configRules?: ConfigRule[] };
type SkillEntry = { id: string; name: string; displayName?: string; displayNameEn?: string; description: string; descriptionEn?: string; size?: number; builtin?: boolean; local?: boolean };
// 技能标签跟随界面语言：中文界面用 frontmatter 的中文名，其余语言用 displayName_en。
const chineseLabels = computed(() => locale.value.startsWith("zh"));
const skillLabel = (skill: SkillEntry) => (chineseLabels.value ? skill.displayName : skill.displayNameEn) || skill.displayName || skill.name;
const skillText = (skill: SkillEntry) => (chineseLabels.value ? skill.description : skill.descriptionEn) || skill.description;

const activeTab = ref<"node" | "skill" | "ext" | "ext">("node");
const plugins = ref<PluginEntry[]>([]);
const skills = ref<SkillEntry[]>([]);
const loading = ref(false);
const skillsLoading = ref(false);
const installing = ref(false);
const removing = ref("");
const toggling = ref("");
const error = ref("");
const message = ref("");
const fileInput = ref<HTMLInputElement>();
const skillFileInput = ref<HTMLInputElement>();

const urlDialog = shallowRef<Component>();
const urlVisible = ref(false);
const urlKind = ref<"node" | "skill" | "ext" | "ext">("node");

const extensions = ref<InstalledExtension[]>([]);
const extensionsLoading = ref(false);
const extensionsInstalling = ref(false);
const extensionRemoving = ref("");
const extensionToggling = ref("");
const extensionFileInput = ref<HTMLInputElement>();
const extensionConfigDialog = shallowRef<Component>();
const extensionConfigVisible = ref(false);
const extensionConfigTarget = ref<InstalledExtension>();
const associationsDialog = shallowRef<Component>();
const associationsVisible = ref(false);
const skillPackageInput = ref<HTMLInputElement>();
type InstallSession = { scope: ReturnType<typeof captureWorkspaceScope>; controller: AbortController; force: boolean };
const installs = new Set<InstallSession>();
let disposed = false;
function beginInstall(): InstallSession {
  if (disposed) throw new Error(translate("安装页面已关闭，请重新打开后重试"));
  const edit = { scope: captureWorkspaceScope(), controller: new AbortController(), force: forceInstall.value };
  installs.add(edit);
  return edit;
}
function assertInstall(edit: InstallSession) {
  edit.controller.signal.throwIfAborted();
  if (disposed || !installs.has(edit)) throw new Error(translate("安装页面已关闭，请重新打开后重试"));
  assertWorkspaceScope(edit.scope);
}
function installActive(edit: InstallSession) {
  try { assertInstall(edit); return true; } catch { return false; }
}
function releaseInstalls() {
  if (!installs.size) return;
  for (const edit of installs) edit.controller.abort();
  installs.clear();
  installing.value = false;
  extensionsInstalling.value = false;
  loading.value = false;
  skillsLoading.value = false;
  extensionsLoading.value = false;
  message.value = "";
}
const unsubscribeInstalls = subscribeWorkspaceScope(releaseInstalls);
onBeforeUnmount(() => { disposed = true; unsubscribeInstalls(); releaseInstalls(); });

const configDialog = shallowRef<Component>();
const configVisible = ref(false);
const configPlugin = ref<PluginEntry>();

function openConfig(plugin: PluginEntry) {
  configDialog.value ??= defineAsyncComponent(() => import("./pluginConfigDialog.vue"));
  configPlugin.value = plugin;
  configVisible.value = true;
}

// 保存后把最新配置写回列表，画布那边由对话框派发的 node-config-updated 事件刷新。
function applyConfig(config: Record<string, unknown>) {
  if (configPlugin.value) configPlugin.value.config = config;
}

const skillEditorVisible = ref(false);
const skillEditing = ref<SkillEntry | null>(null);
const skillName = ref("");
const skillContent = ref("");
const skillError = ref("");
const skillSaving = ref(false);
const skillLoading = ref(false);
const skillReady = ref(false);
let skillEditSession: { scope: ReturnType<typeof captureWorkspaceScope>; controller: AbortController; revision: string | null } | undefined;

function releaseSkillEditor() {
  skillEditSession?.controller.abort();
  skillEditSession = undefined;
  skillLoading.value = false;
  skillReady.value = false;
  skillSaving.value = false;
}
watch(skillEditorVisible, visible => { if (!visible) releaseSkillEditor(); }, { flush: "sync" });
onBeforeUnmount(releaseSkillEditor);

const disabled = computed(() => nodeSettings.value.disabledNodeTypes);

async function api(path: string, init?: RequestInit, edit?: InstallSession) {
  if (edit) assertInstall(edit);
  const response = await fetch(path, { credentials: "same-origin", ...init,
    ...(edit ? { signal: AbortSignal.any([edit.controller.signal, ...(init?.signal ? [init.signal] : [])]) } : {}),
    headers: { "x-miaoimg-workspace": "1", "content-type": "application/json", ...(edit ? workspaceHeaders(edit.scope.owner) : {}), ...(init?.headers || {}) } });
  if (edit) {
    try { assertInstall(edit); }
    catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
  }
  let data;
  try { data = await response.json(); }
  catch {
    if (edit) assertInstall(edit);
    if (response.ok) throw new Error(translate("操作结果尚未确认，请保留当前内容并核对后再继续"));
  }
  if (edit) assertInstall(edit);
  if (!response.ok || data?.ok === false || (data?.code !== undefined && data.code !== 200)) throw new Error(data?.error || data?.message || translate("请求失败（{0}）", { 0: response.status }));
  if (!data || typeof data !== "object" || Array.isArray(data) || data.code !== 200 || !Object.hasOwn(data, "data")) throw new Error(translate("操作结果尚未确认，请保留当前内容并核对后再继续"));
  return data;
}

async function refresh(edit?: InstallSession) {
  if (edit) assertInstall(edit);
  loading.value = true;
  error.value = "";
  try {
    const data = await api("/api/nodes/get", { method: "GET", cache: "no-store" }, edit);
    plugins.value = (data.data || []).filter((item: PluginEntry & { builtin?: boolean }) => !item.builtin);
  } catch (loadError) {
    if (!edit || installActive(edit)) error.value = loadError instanceof Error ? loadError.message : translate("读取插件列表失败");
  } finally {
    if (!edit || installActive(edit)) loading.value = false;
  }
}

async function refreshSkills(edit?: InstallSession) {
  if (edit) assertInstall(edit);
  skillsLoading.value = true;
  try {
    const data = await api("/api/agent/skills", { method: "GET", cache: "no-store" }, edit);
    skills.value = Array.isArray(data.data) ? data.data : [];
    window.dispatchEvent(new Event("miaoimg:skills-changed"));
  } catch (loadError) {
    if (!edit || installActive(edit)) error.value = loadError instanceof Error ? loadError.message : translate("读取技能列表失败");
  } finally {
    if (!edit || installActive(edit)) skillsLoading.value = false;
  }
}

// 内置节点的启用状态只存本地：服务端目录里没有它们的开关。
function setDisabled(type: string, value: boolean) {
  const current = new Set(disabled.value);
  if (value) current.delete(type);
  else current.add(type);
  updateNodeSettings({ disabledNodeTypes: [...current] });
}

// 插件节点的类型是 remote-<插件名>（画布按 /api/nodes/get 的 name 拼），
// 服务端持久化插件的 enabled，本地同时记一份让"添加节点"菜单即时生效。
async function toggle(plugin: PluginEntry, value: boolean) {
  if (toggling.value) return;
  toggling.value = plugin.name;
  error.value = "";
  setDisabled("remote-" + plugin.name, value);
  try {
    await api("/api/nodes/toggle", { method: "POST", body: JSON.stringify({ name: plugin.name, enabled: value }) });
    plugin.enabled = value;
    window.dispatchEvent(new CustomEvent("miaoimg:plugin-installed", { detail: { type: "node", name: plugin.name } }));
  } catch (toggleError) {
    setDisabled("remote-" + plugin.name, !value);
    error.value = toggleError instanceof Error ? toggleError.message : translate("更新插件状态失败");
  } finally {
    toggling.value = "";
  }
}

function pickFile() {
  fileInput.value?.click();
}

function openUrlInstall(kind: "node" | "skill" | "ext") {
  urlDialog.value ??= defineAsyncComponent(() => import("./installFromUrlDialog.vue"));
  urlKind.value = kind;
  urlVisible.value = true;
}

// 从链接装完后刷新列表；节点还要通知画布把新节点挂上。
function onUrlInstalled(result: { name?: string }) {
  message.value = urlKind.value === "node"
    ? translate("已安装 {0}，节点菜单已刷新", { 0: result?.name || "" })
    : translate("已安装技能 {0}", { 0: result?.name || "" });
  if (urlKind.value === "node") {
    void refresh();
    window.dispatchEvent(new CustomEvent("miaoimg:plugin-installed", { detail: { type: "node", name: result?.name } }));
  } else if (urlKind.value === "ext") {
    void refreshExtensions();
    notifyExtensionsChanged();
  } else {
    void refreshSkills();
  }
}

// 技能包（.zip / .tar / .tar.gz / .tgz）按二进制读进来转 base64，交给服务端解析与校验。
async function importSkillPackage(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  const edit = beginInstall();
  error.value = "";
  message.value = "";
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    assertInstall(edit);
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    const data = await api("/api/nodes/skill/install", { method: "POST", body: JSON.stringify({ fileName: file.name, content: btoa(binary), force: edit.force }) }, edit);
    assertInstall(edit);
    message.value = translate("已安装技能 {0}", { 0: data.data?.name || file.name });
    await refreshSkills(edit);
  } catch (importError) {
    if (installActive(edit)) error.value = importError instanceof Error ? importError.message : translate("技能包安装失败，请检查文件");
  } finally { installs.delete(edit); }
}

async function installFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  const edit = beginInstall();
  installing.value = true;
  error.value = "";
  message.value = "";
  try {
    const bundle = await file.text();
    assertInstall(edit);
    const name = guessName(file.name, bundle);
    const meta = readBundleMeta(bundle);
    await api("/api/nodes/install", { method: "POST", body: JSON.stringify({ name, displayName: meta.displayName || name, author: meta.author, version: meta.version, bundle, force: edit.force }) }, edit);
    assertInstall(edit);
    message.value = translate("已安装 {0}，节点菜单已刷新", { 0: meta.displayName || name });
    await refresh(edit);
    assertInstall(edit);
    window.dispatchEvent(new CustomEvent("miaoimg:plugin-installed", { detail: { type: "node", name } }));
  } catch (installError) {
    if (installActive(edit)) error.value = installError instanceof Error ? installError.message : translate("安装失败，请检查插件文件");
  } finally {
    if (installActive(edit)) installing.value = false;
    installs.delete(edit);
  }
}

async function remove(plugin: PluginEntry) {
  removing.value = plugin.name;
  error.value = "";
  try {
    await api("/api/nodes/remove", { method: "POST", body: JSON.stringify({ name: plugin.name }) });
    setDisabled("remote-" + plugin.name, true);
    await refresh();
    message.value = translate("已卸载 {0}", { 0: plugin.displayName });
  } catch (removeError) {
    error.value = removeError instanceof Error ? removeError.message : translate("卸载失败");
  } finally {
    removing.value = "";
  }
}

async function openSkillEditor(skill?: SkillEntry) {
  releaseSkillEditor();
  const edit = { scope: captureWorkspaceScope(), controller: new AbortController(), revision: null as string | null };
  skillEditSession = edit;
  skillEditing.value = skill || null;
  skillName.value = skill?.id || "";
  skillContent.value = "";
  skillError.value = "";
  skillEditorVisible.value = true;
  skillReady.value = !skill;
  if (!skill) return;
  skillLoading.value = true;
  try {
    const data = await api("/api/agent/skill?name=" + encodeURIComponent(skill.id), { method: "GET", cache: "no-store", signal: edit.controller.signal });
    if (skillEditSession !== edit || edit.controller.signal.aborted) return;
    assertWorkspaceScope(edit.scope);
    if (typeof data.data?.content !== "string" || typeof data.data.revision !== "string" || !data.data.revision || data.data.truncated) throw new Error(translate("读取技能失败"));
    skillContent.value = data.data.content;
    edit.revision = data.data.revision;
    skillReady.value = true;
  } catch (loadError) {
    if (skillEditSession === edit && !edit.controller.signal.aborted) skillError.value = loadError instanceof Error ? loadError.message : translate("读取技能失败");
  } finally { if (skillEditSession === edit) skillLoading.value = false; }
}

async function writeSkillContent(name: string, content: string, revision: string | null, signal?: AbortSignal) {
  const result = await api("/api/agent/skills", { method: "POST", body: JSON.stringify({ name, content, revision }), signal });
  if (result.data?.id !== name || typeof result.data.revision !== "string" || !result.data.revision) throw new Error(translate("操作结果尚未确认，请保留当前内容并核对后再继续"));
  return result.data;
}

async function saveSkill() {
  const edit = skillEditSession;
  if (!edit || skillSaving.value || skillLoading.value || !skillReady.value) return;
  const name = skillName.value.trim(), content = skillContent.value, updating = Boolean(skillEditing.value);
  skillSaving.value = true;
  skillError.value = "";
  try {
    assertWorkspaceScope(edit.scope);
    await writeSkillContent(name, content, edit.revision, edit.controller.signal);
    if (skillEditSession !== edit || edit.controller.signal.aborted) return;
    assertWorkspaceScope(edit.scope);
    skillEditorVisible.value = false;
    message.value = updating ? translate("技能已更新") : translate("技能已创建，输入 /skill:{0} 调用", { 0: name });
    await refreshSkills();
  } catch (saveError) {
    if (skillEditSession === edit && !edit.controller.signal.aborted) skillError.value = saveError instanceof Error ? saveError.message : translate("保存技能失败");
  } finally {
    if (skillEditSession === edit) skillSaving.value = false;
  }
}

async function importSkillFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  const scope = captureWorkspaceScope();
  error.value = "";
  message.value = "";
  try {
    const content = await file.text();
    assertWorkspaceScope(scope);
    const name = skillNameFromFileName(file.name);
    await writeSkillContent(name, content, null);
    assertWorkspaceScope(scope);
    message.value = translate("已导入技能 {0}", { 0: name });
    await refreshSkills();
  } catch (importError) {
    error.value = importError instanceof Error ? importError.message : translate("导入技能失败");
  }
}

async function removeSkill(skill: SkillEntry) {
  error.value = "";
  try {
    await api("/api/agent/skills", { method: "POST", body: JSON.stringify({ operation: "remove", name: skill.id }) });
    message.value = translate("已删除技能 {0}", { 0: skill.name });
    await refreshSkills();
  } catch (removeError) {
    error.value = removeError instanceof Error ? removeError.message : translate("删除技能失败");
  }
}

function extensionKind(extension: InstalledExtension) {
  return extension.resourceKind === "canvasNode" ? translate("画布节点") : extension.extensions.map(item => `.${item}`).join(" ");
}

async function refreshExtensions(edit?: InstallSession) {
  if (edit) assertInstall(edit);
  extensionsLoading.value = true;
  error.value = "";
  try {
    const next = await listExtensions(true);
    if (edit) assertInstall(edit);
    extensions.value = next;
  } catch (loadError) {
    if (!edit || installActive(edit)) error.value = loadError instanceof Error ? loadError.message : translate("读取文件扩展失败");
  } finally {
    if (!edit || installActive(edit)) extensionsLoading.value = false;
  }
}

function openExtensionConfig(extension: InstalledExtension) {
  extensionConfigDialog.value ??= defineAsyncComponent(() => import("./extensionConfigDialog.vue"));
  extensionConfigTarget.value = extension;
  extensionConfigVisible.value = true;
}

function openAssociations() {
  associationsDialog.value ??= defineAsyncComponent(() => import("./extensionAssociationsDialog.vue"));
  associationsVisible.value = true;
}

// 安装、卸载、启停都会改变候选扩展，广播给文档面板让它重新拉一次清单。
function notifyExtensionsChanged() {
  window.dispatchEvent(new CustomEvent("miaoimg:ext-updated"));
}

async function toggleExtension(extension: InstalledExtension, value: boolean) {
  if (extensionToggling.value) return;
  extensionToggling.value = extension.id;
  error.value = "";
  try {
    await api("/api/ext/setEnabled", { method: "POST", body: JSON.stringify({ name: extension.id, enabled: value }) });
    extension.enabled = value;
    notifyExtensionsChanged();
  } catch (toggleError) {
    error.value = toggleError instanceof Error ? toggleError.message : translate("更新扩展状态失败");
  } finally {
    extensionToggling.value = "";
  }
}

async function removeExtension(extension: InstalledExtension) {
  extensionRemoving.value = extension.id;
  error.value = "";
  try {
    await api("/api/ext/uninstall", { method: "POST", body: JSON.stringify({ name: extension.id }) });
    await refreshExtensions();
    notifyExtensionsChanged();
    message.value = translate("已卸载 {0}", { 0: extension.displayName });
  } catch (removeError) {
    error.value = removeError instanceof Error ? removeError.message : translate("卸载失败");
  } finally {
    extensionRemoving.value = "";
  }
}

async function installExtensionFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  const edit = beginInstall();
  extensionsInstalling.value = true;
  error.value = "";
  message.value = "";
  try {
    const bundle = await file.text();
    assertInstall(edit);
    const installed = await api("/api/ext/install", { method: "POST", body: JSON.stringify({ bundle, force: edit.force }) }, edit);
    assertInstall(edit);
    await refreshExtensions(edit);
    assertInstall(edit);
    notifyExtensionsChanged();
    message.value = translate("已安装扩展 {0}", { 0: installed.data?.name || file.name });
  } catch (installError) {
    if (installActive(edit)) error.value = installError instanceof Error ? installError.message : translate("安装失败，请检查扩展文件");
  } finally {
    if (installActive(edit)) extensionsInstalling.value = false;
    installs.delete(edit);
  }
}

function guessName(fileName: string, bundle: string) {
  const declared = /["']?name["']?\s*[:=]\s*["']([A-Za-z0-9._-]+)["']/.exec(bundle.slice(0, 4000))
  const base = fileName.replace(/\.(umd\.)?js$/i, "").replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "")
  return (declared?.[1] || base || "plugin").slice(0, 40)
}

function readBundleMeta(bundle: string) {
  const meta: { displayName?: string; version?: string; author?: string } = {}
  const display = /displayName["']?\s*[:=]\s*["']([^"']{1,60})["']/.exec(bundle.slice(0, 6000))
  const version = /version["']?\s*[:=]\s*["']([^"']{1,20})["']/.exec(bundle.slice(0, 6000))
  const author = /author["']?\s*[:=]\s*["']([^"']{1,60})["']/.exec(bundle.slice(0, 6000))
  if (display) meta.displayName = display[1]
  if (version) meta.version = version[1]
  if (author) meta.author = author[1]
  return meta
}

onMounted(() => { void refresh(); void refreshSkills(); void refreshExtensions(); });
</script>

<style scoped lang="scss">
.pluginPanel {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 0 4px 8px;

  .intro { margin: 0; font-size: 12px; line-height: 1.7; color: var(--el-text-color-secondary); }

  .typeTabs {
    display: flex;
    gap: 8px;

    .typeTab {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 14px;
      border: 1px solid var(--el-border-color);
      border-radius: 999px;
      background: transparent;
      color: var(--el-text-color-regular);
      font: inherit;
      font-size: 13px;
      cursor: pointer;

      &:hover { border-color: var(--el-color-primary-light-5); }

      &[aria-pressed="true"] {
        border-color: var(--el-color-primary);
        background: var(--el-color-primary-light-9);
        color: var(--el-color-primary);
      }

      &:focus-visible { outline: 2px solid var(--el-color-primary); }

      .typeCount {
        font-size: 11px;
        color: var(--el-text-color-secondary);
      }
    }
  }

  .groupCard {
    :deep(.el-card__body) { padding: 14px 16px; }
  }

  .groupHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 10px;
    font-size: 14px;
    font-weight: 600;
    color: var(--el-text-color-primary);

    .headerActions { display: flex; gap: 4px; }
  }

  .extensionIcon {
    width: 15px;
    height: 15px;
    margin-right: 6px;
    vertical-align: -3px;
    object-fit: contain;
  }

  .pluginError {
    color: var(--el-color-danger);
    font-size: 12px;
    overflow-wrap: anywhere;
  }

  .emptyHint { margin: 0; font-size: 12px; line-height: 1.7; color: var(--el-text-color-secondary); }

  .pluginRow {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 0;
    border-top: 0;

    &:first-of-type { border-top: 0; }

    .pluginInfo {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;

      .pluginName { font-size: 13px; color: var(--el-text-color-primary); }
      .pluginId { font-size: 11px; color: var(--el-text-color-secondary); overflow-wrap: anywhere; }
    }

    .pluginActions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
  }

  .fileInput { display: none; }
}
</style>
