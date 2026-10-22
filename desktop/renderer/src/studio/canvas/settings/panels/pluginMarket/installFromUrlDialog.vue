<template>
  <el-dialog
    v-model="visible"
    :title="translate('从链接安装')"
    width="min(560px, calc(100vw - 32px))"
    alignCenter
    appendToBody
    destroyOnClose
    :closeOnClickModal="false"
    :closeOnPressEscape="!installing"
    :showClose="!installing">
    <el-form labelPosition="top" :disabled="installing">
      <el-form-item :label="translate('文件链接')">
        <el-input v-model="url" dir="ltr" :placeholder="placeholder" :aria-label="translate('文件链接')" @keyup.enter="install" />
      </el-form-item>
      <el-form-item v-if="kind === 'skill'" :label="translate('文件名')">
        <el-input v-model="fileName" dir="ltr" :placeholder="translate('留空则用链接里的文件名')" :aria-label="translate('文件名')" />
      </el-form-item>
    </el-form>
    <p class="urlHint">{{ translate('填写 http / https 直链，单个文件不超过 20 MB；链接会先下载校验再安装。') }}</p>
    <el-alert v-if="error" :title="error" type="error" :closable="false" showIcon />
    <template #footer>
      <el-button :disabled="installing" @click="visible = false">{{ translate('取消') }}</el-button>
      <el-button type="primary" :loading="installing" :disabled="!url.trim()" @click="install">{{ translate('下载并安装') }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { translate } from "@miaoimg/i18n/vue";
import { forceInstall } from "../../installOptions";
import { captureWorkspaceScope, assertWorkspaceScope } from "@/lib/workspaceRemote";

const props = defineProps<{ kind: "node" | "skill" | "ext" }>();
const emit = defineEmits<{ installed: [{ name: string }] }>();
const visible = defineModel<boolean>({ default: false });

const url = ref("");
const fileName = ref("");
const installing = ref(false);
const error = ref("");
let installSession: { kind: typeof props.kind; scope: ReturnType<typeof captureWorkspaceScope>; controller: AbortController } | undefined;

function releaseInstaller() {
  installSession?.controller.abort();
  installSession = undefined;
  installing.value = false;
}
onBeforeUnmount(releaseInstaller);

const placeholder = computed(() => props.kind === "skill"
  ? "https://example.com/storyboard.zip"
  : props.kind === "ext" ? "https://example.com/ext-myEditor.umd.js" : "https://example.com/audioNode.umd.js");

function reset() {
  url.value = "";
  fileName.value = "";
  error.value = "";
}

watch([visible, () => props.kind], ([open]) => {
  releaseInstaller();
  if (!open) return;
  installSession = { kind: props.kind, scope: captureWorkspaceScope(), controller: new AbortController() };
  reset();
}, { immediate: true, flush: "sync" });

async function install() {
  const edit = installSession;
  if (!edit || installing.value || !url.value.trim()) return;
  installing.value = true;
  error.value = "";
  try {
    assertWorkspaceScope(edit.scope);
    const path = edit.kind === "skill" ? "/api/nodes/skill/install" : edit.kind === "ext" ? "/api/ext/install" : "/api/nodes/install";
    const body = edit.kind === "skill"
      ? { url: url.value.trim(), fileName: fileName.value.trim(), force: forceInstall.value }
      : { url: url.value.trim(), force: forceInstall.value };
    const response = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "x-miaoimg-workspace": "1", "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.any([edit.controller.signal, AbortSignal.timeout(60_000)]),
    });
    if (installSession !== edit || edit.controller.signal.aborted) { await response.body?.cancel().catch(() => {}); return; }
    try { assertWorkspaceScope(edit.scope); }
    catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
    const data = await response.json().catch(() => undefined);
    if (installSession !== edit || edit.controller.signal.aborted) return;
    assertWorkspaceScope(edit.scope);
    if (!response.ok) throw new Error(data?.error || data?.message || translate("请求失败（{0}）", { 0: response.status }));
    const installed = data?.data;
    if (data?.code !== 200 || typeof installed?.name !== "string" || !installed.name.trim()
      || (edit.kind === "skill" ? !Number.isSafeInteger(installed.files) || installed.files < 1 : installed.installed !== true)) throw new Error(translate("操作结果尚未确认，请保留当前内容并核对后再继续"));
    emit("installed", installed);
    visible.value = false;
  } catch (installError) {
    if (installSession === edit && !edit.controller.signal.aborted) error.value = installError instanceof Error ? installError.message : translate("安装失败，请检查链接");
  } finally {
    if (installSession === edit) installing.value = false;
  }
}
</script>

<style scoped lang="scss">
.urlHint {
  margin: 0 0 12px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--el-text-color-secondary);
}
</style>
