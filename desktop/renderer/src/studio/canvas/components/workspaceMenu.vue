<template>
  <div class="workspaceMenu">
    <el-card shadow="never" :bodyStyle="{ padding: '5px 10px' }">
      <div class="menuContent">
        <!-- 库还没迁移到多项目时不渲染这个入口：只有默认项目、也没有任何可用动作，
             多一个点了会报错的按钮不如不出现（也不写「暂未开放」这类解释）。迁移完 scoped 自动变 true。 -->
        <el-dropdown v-if="scoped" trigger="click" :hideOnClick="true" @command="handleCommand" @visible-change="refreshWhenOpened">
          <el-button class="toolButton projectButton" text :disabled="disabled || busy" :aria-label="translate('项目')" :title="currentName">
            <icon-folders :size="17" aria-hidden="true" />
          </el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item v-for="item in projects" :key="item.id" :command="`switch:${item.id}`" :disabled="item.id === currentProject">
                <span class="projectRow">
                  <span class="projectName">{{ displayName(item) }}</span>
                  <span v-if="item.lastOpenedAt" class="projectTime">{{ openedLabel(item.lastOpenedAt) }}</span>
                </span>
              </el-dropdown-item>
              <el-dropdown-item divided command="create">{{ translate('新建项目') }}</el-dropdown-item>
              <el-dropdown-item command="rename" :disabled="!currentProject">{{ translate('重命名') }}</el-dropdown-item>
              <el-dropdown-item v-if="canRemove" class="deleteAction" command="remove">{{ translate('删除') }}</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <el-button class="toolButton" text :disabled="disabled || busy" :aria-label="translate('退出项目')" :title="translate('退出项目')" @click="exitVisible = true">
          <icon-x :size="17" aria-hidden="true" />
        </el-button>
      </div>
    </el-card>
    <el-dialog v-model="exitVisible" class="exitProjectDialog" :title="translate('退出项目')" width="min(320px, calc(100vw - 32px))" alignCenter appendToBody>
      <span>{{ translate('是否退出当前项目并返回首页？') }}</span>
      <template #footer>
        <el-button @click="exitVisible = false">{{ translate('取消') }}</el-button>
        <el-button type="primary" :loading="leaving || disabled" :disabled="busy" @click="exitProject">{{ translate('退出项目') }}</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, onMounted, onScopeDispose, ref } from "vue";
import { IconX, IconFolders } from "@tabler/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { locale, translate } from "@miaoimg/i18n/vue";
import { captureWorkspaceScope, assertWorkspaceScope } from "@/lib/workspaceRemote";

type ProjectItem = { id: string; name: string; createdAt: string | null; lastOpenedAt: string | null; fileCount: number };

const props = defineProps<{ disabled?: boolean }>();
const emit = defineEmits<{ exit: []; switchProject: [id: string]; projectRemoved: [id: string] }>();
const binding = captureWorkspaceScope();
const lifetime = new AbortController();
onScopeDispose(() => lifetime.abort());
let refreshRequest = 0;
const csrf = inject<string | undefined>("miaoModelCsrf", undefined);
const control = inject<{ current: string; switch: (id: string) => void } | undefined>("workspaceProjectControl", undefined);
const scoped = ref(false);
const exitVisible = ref(false);
const leaving = ref(false);
const projects = ref<ProjectItem[]>([]);
const currentProject = ref(control?.current || "default");
const busy = ref(false);

// 项目名有两种来源：服务端建默认项目时写进库的 `默认项目`，和用户自己起的名字。
// **库里存的值不动**（存量数据里就是这个中文），只在显示时把默认项目名映射到词典键——
// 否则英文/日文界面下会露中文。用户改过名的原样显示。
const DEFAULT_PROJECT_NAME = '默认项目'
function displayName(item?: ProjectItem | null) {
  if (!item) return translate('项目')
  return item.name === DEFAULT_PROJECT_NAME ? translate(DEFAULT_PROJECT_NAME) : item.name
}
const currentName = computed(() => displayName(projects.value.find(item => item.id === currentProject.value)));
// 默认项目不给删——按钮直接不出现，不写「不可删除」这类文案。
const canRemove = computed(() => currentProject.value !== "default" && projects.value.some(item => item.id === currentProject.value));

function openedLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale.value, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

async function request(path: string, init: RequestInit = {}) {
  assertCurrent();
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    ...init,
    signal: init.signal ? AbortSignal.any([lifetime.signal, init.signal]) : lifetime.signal,
    headers: { "content-type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}), ...(init.headers || {}) },
  });
  const text = await response.text();
  assertCurrent();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(translate('未收到有效的项目响应，请刷新后重试')); }
  if (!response.ok) throw new Error(typeof data?.error === 'string' && data.error ? data.error : translate('项目操作失败'));
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(translate('未收到有效的项目响应，请刷新后重试'));
  return data;
}

function assertCurrent() { lifetime.signal.throwIfAborted(); assertWorkspaceScope(binding); }
function isCurrent() { try { assertCurrent(); return true; } catch { return false; } }
function readProject(data: Record<string, any>, name: string, id?: string) {
  if (!data.project || typeof data.project.id !== 'string' || !data.project.id
    || data.project.name !== name || (id !== undefined && data.project.id !== id)) throw new Error(translate('未收到有效的项目响应，请刷新后重试'));
}

async function readProjectList() {
  // Listing belongs to the account. A just-deleted active project must not make
  // the desktop runtime reject this recovery read before it reaches the list.
  const data = await request("/api/imagine/workspace/projects", { method: "GET" });
  if (!Array.isArray(data.projects) || typeof data.scoped !== 'boolean'
    || data.projects.some(item => !item || typeof item.id !== 'string' || !item.id || typeof item.name !== 'string')) throw new Error(translate('未收到有效的项目响应，请刷新后重试'));
  return data;
}

async function refresh() {
  if (!isCurrent()) return;
  const requestId = ++refreshRequest;
  try {
    const data = await readProjectList();
    if (requestId !== refreshRequest || !isCurrent()) return;
    projects.value = data.projects;
    // 能力标记由服务端给：未迁移的库是 false，前端不渲染多项目入口（也不写任何「暂未开放」文案）。
    scoped.value = data.scoped === true;
  } catch { /* 拉不到列表就先不显示，不打断画布 */ }
}

onMounted(refresh);
function refreshWhenOpened(open: boolean) { if (open && !busy.value && !props.disabled) void refresh(); }

// 名字规则和服务端一致（去空白、长度上限、同账号重名），先在这里即时拦一道。
function nameValidator(value: string) {
  const name = String(value ?? "").trim();
  if (!name) return translate('项目名称不能为空');
  if ([...name].length > 40) return translate('项目名称不能超过 40 个字符');
  if (projects.value.some(item => item.name === name && item.id !== currentProject.value)) return translate('已有同名项目');
  return true;
}

async function createProject() {
  const result = await ElMessageBox.prompt(translate('新项目里会是一个空的画布列表，可以随时切回来。'), translate('新建项目'), {
    confirmButtonText: translate('创建'),
    cancelButtonText: translate('取消'),
    inputPlaceholder: translate('项目名称'),
    inputValidator: nameValidator,
  });
  const name = String(result.value).trim();
  readProject(await request("/api/imagine/workspace/projects", { method: "POST", body: JSON.stringify({ name }) }), name);
  await refresh();
}

async function renameProject() {
  const item = projects.value.find(entry => entry.id === currentProject.value);
  if (!item) return;
  const result = await ElMessageBox.prompt(translate('项目名称'), translate('重命名'), {
    confirmButtonText: translate('保存'),
    cancelButtonText: translate('取消'),
    inputValue: item.name,
    inputValidator: nameValidator,
  });
  const name = String(result.value).trim();
  readProject(await request("/api/imagine/workspace/projects/rename", { method: "POST", body: JSON.stringify({ id: item.id, name }) }), name, item.id);
  await refresh();
}

async function removeProject() {
  const item = projects.value.find(entry => entry.id === currentProject.value);
  if (!item || !canRemove.value) return;
  await ElMessageBox.confirm(translate('项目里的画布和素材会一起删除。'), translate('删除项目'), {
    confirmButtonText: translate('删除'),
    cancelButtonText: translate('取消'),
    type: "warning",
  });
  try {
    const data = await request("/api/imagine/workspace/projects/remove", { method: "POST", body: JSON.stringify({ id: item.id }) });
    if (data.ok !== true || !Number.isSafeInteger(data.rows) || data.rows < 0 || !Number.isFinite(data.bytes) || data.bytes < 0) throw new Error(translate('未收到有效的项目响应，请刷新后重试'));
  } catch (error) {
    if (!isCurrent()) throw error;
    const latest = await readProjectList().catch(() => undefined);
    if (!latest?.scoped || !latest.projects.some(project => project.id === 'default')
      || latest.projects.some(project => project.id === item.id)) throw error;
  }
  assertCurrent();
  // 删除确认与普通切换分开：父组件取消保存，不能再刷新已删除的文件。
  emit("projectRemoved", item.id);
}

async function switchTo(id: string) {
  if (id === currentProject.value) return;
  // 交给外壳：先把画布刷盘，再换项目重新挂载。
  emit("switchProject", id);
}

async function handleCommand(command: string) {
  if (busy.value || props.disabled || !isCurrent()) return;
  busy.value = true;
  ++refreshRequest;
  try {
    if (command.startsWith("switch:")) await switchTo(command.slice("switch:".length));
    else if (command === "create") await createProject();
    else if (command === "rename") await renameProject();
    else if (command === "remove") await removeProject();
  } catch (error) {
    // 用户点「取消」不是错误，只有真的失败才提示。
    const message = error instanceof Error ? error.message : "";
    if (isCurrent() && message && !/cancel/i.test(error?.toString?.() || "")) ElMessage.error(message);
  } finally {
    busy.value = false;
  }
}

async function exitProject() {
  if (leaving.value || busy.value || props.disabled || !isCurrent()) return;
  leaving.value = true;
  try {
    emit("exit");
  } finally {
    leaving.value = false;
  }
}
</script>

<style scoped lang="scss">
.workspaceMenu {
  .menuContent {
    display: flex;
    align-items: center;
    gap: 10px;

    .toolButton {
      width: 28px;
      height: 28px;
      margin: 0;
      padding: 0;
    }
  }

  .projectRow {
    display: flex;
    align-items: baseline;
    gap: 8px;

    .projectTime {
      color: var(--el-text-color-secondary);
      font-size: 12px;
    }
  }
}
</style>

<style>
body:has(.studio-app) .exitProjectDialog { height: auto; flex: none; padding: 18px; }
body:has(.studio-app) .exitProjectDialog .el-dialog__body { flex: none; padding: 8px 0 16px; font-size: 13px; }
body:has(.studio-app) .exitProjectDialog .el-dialog__footer { padding-top: 0; }
</style>
