<template>
  <section v-show="visible" class="agent">
    <agentMenu
      :key="conversationKey"
      :name="name"
      :history="history"
      :sessionFile="sessionFile"
      :parentFile="selectedConversation?.parentFile"
      :subAgents="selectedConversation?.subAgents"
      :loading="loading || historyLoading"
      @open-sub-agent="selectConversation"
      @back="backToParent"
      @new-chat="newConversation"
      @history="loadHistory(!initialized)"
      @select="selectConversation"
      @rename="renameConversation"
      @remove="removeConversation"
      @close="visible = false">
      <template #actions><slot name="menuActions" /></template>
    </agentMenu>
    <conversation
      v-for="item in mountedConversations"
      v-show="item.key === conversationKey"
      :key="item.key"
      :ref="instance => setConversationRef(item, instance)"
      :active="visible && item.key === conversationKey"
      :initialSession="item.session"
      :initialDraft="item.draft"
      :sessionFile="item.file"
      :disabled="loading || !initialized"
      @session="setSessionFile(item, $event)"
      @event="receiveAgentEvent"
      @open-sub-agent="selectConversation"
      @running="item.running = $event"
      @admitting="item.admitting = $event"
      @draft="item.draft = $event"
      @sent="updateConversationName(item, $event)" />
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch, type ComponentPublicInstance } from "vue";
import axios from "axios";
import { translate } from "@miaoimg/i18n/vue";
import { ElMessage } from "element-plus";
import { useWorkspaceStore } from "@/stores/workspace";
import type { AgentConversation, AgentDraft, AgentHistory } from "./types";
import type { AgentEvent, AgentSubAgent } from "@miaoimg/server/agent/types";
import agentMenu from "./menu.vue";
import conversation from "./conversation.vue";
import { warmMessageRenderer } from "./messageRenderer";

const visible = defineModel<boolean>({ default: false });
type OpenConversation = { key: number; name: string; file?: string; parentFile?: string; subAgents: AgentSubAgent[]; session: AgentConversation | null; draft?: AgentDraft; running: boolean; admitting?: boolean };
const conversations = ref<OpenConversation[]>([]);
// Native execution survives an unmounted chat; keep only the visible renderer.
const mountedConversations = computed(() => conversations.value.filter(item => item.key === conversationKey.value || item.admitting));
const conversationKey = ref(0);
watch(conversationKey, key => {
  for (const item of conversations.value) if (item.key !== key) { item.session = null; item.subAgents = []; }
}, { flush: 'post' });
const selectedConversation = computed(() => conversations.value.find(item => item.key === conversationKey.value));
// ACT: 新对话是现有自动命名逻辑使用的保留值；仅翻译显示，不改变存储或比较值。
const name = computed(() => {
  const value = selectedConversation.value?.name;
  return value && value !== "新对话" ? value : translate("新对话");
});
const sessionFile = computed(() => selectedConversation.value?.file);
const workspaceStore = useWorkspaceStore();
const history = ref<AgentHistory[]>([]);
const loading = ref(false);
const historyLoading = ref(false);
const initialized = ref(false);
let requestId = 0;
let nextConversationKey = 0;
const conversationRefs = new Map<number, InstanceType<typeof conversation>>();
const pendingEvents = new Map<number, AgentEvent[]>();

function showConversation(session: AgentConversation | null, activate = true) {
  const existing = session
    ? conversations.value.find(item => item.file === session.file)
    : conversations.value.find(item => !item.file && !item.parentFile);
  if (existing) {
    if (session) { existing.session = session; existing.subAgents = session.subAgents || []; existing.running = !!session.running; }
    if (activate) conversationKey.value = existing.key;
    return existing;
  }
  const key = ++nextConversationKey;
  const item = { key, name: session?.name || "新对话", file: session?.file, parentFile: session?.parentFile, subAgents: session?.subAgents ?? [], session, running: !!session?.running };
  conversations.value.push(item);
  if (activate) conversationKey.value = key;
  return conversations.value[conversations.value.length - 1]!;
}

function setConversationRef(item: OpenConversation, instance: Element | ComponentPublicInstance | null) {
  if (!instance) { conversationRefs.delete(item.key); return; }
  const view = instance as InstanceType<typeof conversation>;
  conversationRefs.set(item.key, view);
  for (const event of pendingEvents.get(item.key) ?? []) view.receiveEvent(event);
  pendingEvents.delete(item.key);
}

function deliverEvent(item: OpenConversation, event: AgentEvent) {
  const view = conversationRefs.get(item.key);
  if (view) view.receiveEvent(event);
  else {
    const events = pendingEvents.get(item.key) ?? [];
    events.push(event);
    pendingEvents.set(item.key, events);
  }
}

function receiveAgentEvent(event: AgentEvent) {
  if (event.type === "subAgent") {
    const parent = conversations.value.find(item => item.file === event.agent.parentFile);
    if (!parent) return;
    const current = parent.subAgents.find(agent => agent.file === event.agent.file);
    if (current) Object.assign(current, event.agent);
    else parent.subAgents.push(event.agent);
    return;
  }
  if (event.type === "subAgentEvent") {
    const child = conversations.value.find(item => item.file === event.file);
    if (event.event.type === "error") {
      const agent = conversations.value.find(item => item.file === child?.parentFile)?.subAgents.find(agent => agent.file === event.file);
      if (agent?.status === "running") Object.assign(agent, { status: "cancelled", result: event.event.message });
    }
    if (child) deliverEvent(child, event.event);
    return;
  }
  if (event.type === "report") {
    const parent = conversations.value.find(item => item.file === event.parentFile);
    if (parent) deliverEvent(parent, event);
  }
}

function backToParent() {
  const file = selectedConversation.value?.parentFile;
  if (file) void selectConversation(file);
}

function updateConversationName(item: OpenConversation, prompt: string) {
  if (item.name !== "新对话") return;
  item.name = prompt.slice(0, 80);
  const entry = history.value.find(entry => entry.file === item.file);
  if (entry) entry.name = item.name;
}

function setSessionFile(item: OpenConversation, file: string) {
  item.file = file;
  if (item.parentFile) return;
  if (!history.value.some(entry => entry.file === file)) {
    history.value.unshift({ file, name: item.name, modified: new Date().toISOString(), messageCount: 0 });
  }
}

async function newConversation() {
  if (loading.value || historyLoading.value) return;
  const directory = workspaceStore.project?.directory;
  if (!directory) return ElMessage.warning(translate("请先打开项目"));
  const currentRequest = ++requestId;
  loading.value = true;
  try {
    const { data } = await axios.post<{ code: number; data: AgentConversation; message?: string }>("/api/agent/create", {
      directory,
    }, { headers: { "x-miaoimg-workspace": "1" } });
    if (data.code !== 200) throw new Error(data.message || translate("新建对话失败"));
    if (currentRequest !== requestId) return;
    const session = data.data;
    history.value.unshift({ file: session.file, name: session.name, modified: new Date().toISOString(), messageCount: 0 });
    showConversation(session);
    initialized.value = true;
  } catch (error) {
    if (currentRequest === requestId) ElMessage.error(axios.isAxiosError(error)
      ? error.response?.data?.message || translate("新建对话失败")
      : error instanceof Error ? error.message : translate("新建对话失败"));
  } finally {
    if (currentRequest === requestId) loading.value = false;
  }
}

async function readConversation(directory: string, file: string) {
  const { data } = await axios.get<{ code: number; data: AgentConversation; message?: string }>("/api/agent/get", {
    params: { directory, sessionFile: file }, headers: { "x-miaoimg-workspace": "1" },
  });
  if (data.code !== 200) throw new Error(data.message || translate("读取对话失败"));
  return data.data;
}

async function loadHistory(openLatest = false) {
  const directory = workspaceStore.project?.directory;
  if (!directory || loading.value || historyLoading.value) return;
  const currentRequest = ++requestId;
  historyLoading.value = true;
  loading.value = openLatest;
  try {
    if (openLatest) warmMessageRenderer();
    const includeLatest = openLatest && !workspaceStore.pendingAgentMessage;
    const { data } = await axios.get<{ code: number; data: AgentHistory[]; session?: AgentConversation | null; message?: string }>("/api/agent/list", {
      params: { directory, ...(includeLatest ? { includeLatest: "1" } : {}) }, headers: { "x-miaoimg-workspace": "1" },
    });
    if (data.code !== 200) throw new Error(data.message || translate("读取历史对话失败"));
    if (currentRequest !== requestId) return;
    history.value = data.data;
    // History lists root chats only. A missing child is not proof of deletion;
    // keep its draft unless its known root (and therefore its branch) was removed.
    const historyByFile = new Map(data.data.map(item => [item.file, item]));
    const removedFiles = new Set<string>();
    for (const item of [...conversations.value]) if (item.file) {
      const entry = historyByFile.get(item.file);
      if (entry) {
        item.name = entry.name;
        setSessionFile(item, item.file);
      } else if (!item.parentFile && !item.running && !item.admitting) {
        removedFiles.add(item.file);
      }
    }
    for (let size = -1; size !== removedFiles.size;) {
      size = removedFiles.size;
      for (const item of conversations.value) if (item.file && item.parentFile && removedFiles.has(item.parentFile)) removedFiles.add(item.file);
    }
    conversations.value = conversations.value.filter(item => !item.file || !removedFiles.has(item.file));
    if (!openLatest && !selectedConversation.value) {
      showConversation(null);
      initialized.value = true;
    }
    if (openLatest) {
      const session = includeLatest ? data.session ?? null : null;
      if (currentRequest !== requestId) return;
      const latest = conversations.value.find(item => item.file === session?.file)
      if (latest && !latest.running) conversations.value = conversations.value.filter(item => item !== latest)
      showConversation(session);
      initialized.value = true;
    }
  } catch (error) {
    if (currentRequest === requestId) ElMessage.error(error instanceof Error ? error.message : translate("读取历史对话失败"));
  } finally {
    if (currentRequest === requestId) {
      historyLoading.value = false;
      loading.value = false;
    }
  }
}

async function selectConversation(file: string) {
  const directory = workspaceStore.project?.directory;
  if (!directory || loading.value || historyLoading.value || file === sessionFile.value) return;
  const existing = conversations.value.find(item => item.file === file);
  const currentRequest = ++requestId;
  loading.value = true;
  try {
    const session = await readConversation(directory, file);
    if (currentRequest !== requestId) return;
    if (existing) {
      existing.session = session; existing.subAgents = session.subAgents || []; existing.running = !!session.running;
      conversationKey.value = existing.key;
    } else {
      if (existing) conversations.value = conversations.value.filter(item => item !== existing)
      showConversation(session);
    }
    initialized.value = true;
  } catch (error) {
    if (currentRequest === requestId) ElMessage.error(error instanceof Error ? error.message : translate("读取对话失败"));
  } finally {
    if (currentRequest === requestId) loading.value = false;
  }
}

async function renameConversation(file: string, value: string) {
  const directory = workspaceStore.project?.directory;
  const item = history.value.find(item => item.file === file);
  const nextName = value.trim();
  if (!directory || loading.value || historyLoading.value || (!item && file !== sessionFile.value)) return;
  if (!nextName || nextName.length > 80) return ElMessage.warning(translate("请输入 1–80 个字符的对话名称"));
  if (nextName === (file === sessionFile.value ? name.value : item?.name)) return;
  const currentRequest = ++requestId;
  loading.value = true;
  try {
    const { data } = await axios.patch<{ code: number; data: { name: string }; message?: string }>("/api/agent/rename", {
      directory, sessionFile: file, name: nextName,
    }, { headers: { "x-miaoimg-workspace": "1" } });
    if (data.code !== 200) throw new Error(data.message || translate("重命名对话失败"));
    if (currentRequest !== requestId) return;
    if (item) item.name = data.data.name;
    const opened = conversations.value.find(item => item.file === file);
    if (opened) opened.name = data.data.name;
  } catch (error) {
    if (currentRequest === requestId) ElMessage.error(axios.isAxiosError(error)
      ? error.response?.data?.message || translate("重命名对话失败")
      : error instanceof Error ? error.message : translate("重命名对话失败"));
  } finally {
    if (currentRequest === requestId) loading.value = false;
  }
}

async function removeConversation(file: string) {
  const directory = workspaceStore.project?.directory;
  if (!directory || loading.value || historyLoading.value || !history.value.some(item => item.file === file)) return;
  if (!/^agent\/[\w-]{6,80}\.json$/.test(file)) return ElMessage.error(translate("对话文件名无效"));
  const currentRequest = ++requestId;
  loading.value = true;
  try {
    const { data } = await axios.delete<{ code: number; data: { file: string; removed: number; files?: string[] }; message?: string }>("/api/agent/delete", {
      data: { directory, sessionFile: file }, headers: { "x-miaoimg-workspace": "1" },
    });
    if (data.code !== 200) throw new Error(data.message || translate("删除对话失败"));
    if (currentRequest !== requestId) return;
    const removedFiles = new Set(data.data.files?.length ? data.data.files : [file]);
    history.value = history.value.filter(item => !removedFiles.has(item.file));
    conversations.value = conversations.value.filter(item => !removedFiles.has(item.file) && !removedFiles.has(item.parentFile || ""));
    if (!selectedConversation.value) {
      // The deletion is already committed. Keep an editor available even if
      // loading the next chat fails or the server has just removed that one too.
      showConversation(null);
      initialized.value = true;
      const next = history.value[0];
      if (next) {
        let session: AgentConversation;
        try { session = await readConversation(directory, next.file); }
        catch { throw new Error(translate("对话已删除，下一条对话暂时无法读取，请从历史记录重新打开")); }
        if (currentRequest === requestId) showConversation(session);
      }
    }
    if (currentRequest === requestId) ElMessage.success(translate("对话已删除"));
  } catch (error) {
    if (currentRequest === requestId) ElMessage.error(axios.isAxiosError(error)
      ? error.response?.data?.message || translate("删除对话失败")
      : error instanceof Error ? error.message : translate("删除对话失败"));
  } finally {
    if (currentRequest === requestId) loading.value = false;
  }
}

watch(() => workspaceStore.project?.directory, directory => {
  requestId++;
  history.value = [];
  conversations.value = [];
  conversationRefs.clear();
  pendingEvents.clear();
  initialized.value = false;
  loading.value = false;
  historyLoading.value = false;
  showConversation(null);
  if (visible.value && directory) void loadHistory(true);
}, { immediate: true });
watch(visible, active => {
  if (active && !initialized.value) void loadHistory(true);
});
onBeforeUnmount(() => { requestId++; });

</script>

<style scoped lang="scss">
.agent {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  box-sizing: border-box;
  padding-bottom: 0;
  overflow: hidden;
  background: var(--el-bg-color);
  font-size: 13px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;

  :deep(.agentMenu) {
    padding: 12px 16px;
    border-bottom: 1px solid var(--el-border-color-extra-light);
  }
}
</style>
