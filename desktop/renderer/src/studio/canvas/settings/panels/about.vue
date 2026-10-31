<template>
  <div class="about">
    <div class="brand"><img src="/miaoimg-logo.png" :alt="translate('妙图 Logo')" /><div><h3>{{ translate('妙图') }}</h3><p>{{ translate('AI 无限画布') }}</p></div></div>
    <settings-section :title="translate('应用版本')">
      <p v-if="desktopVersion" class="version">v{{ desktopVersion }}</p>
      <p v-if="canCheck" class="hint">{{ translate(desktopHint) }}</p>
      <div v-if="canCheck" class="updateRow">
        <el-button :icon="actionIcon" :loading="busy" :disabled="busy" :aria-label="translate(actionLabel)" @click="runAction">{{ translate(actionLabel) }}</el-button>
        <p v-if="statusText" class="status" role="status">{{ statusText }}</p>
      </div>
    </settings-section>
    <settings-section :title="translate('帮助与支持')">
      <div class="supportActions">
        <el-button :icon="IconBook" tag="a" :href="manualUrl" target="_blank" rel="noopener noreferrer">{{ translate('打开使用手册') }}</el-button>
      </div>
    </settings-section>
    <a class="website" href="https://miaoimg.cn/" target="_blank" rel="noopener noreferrer"><IconWorld :size="18" aria-hidden="true" /><span>{{ translate('妙图官网') }}</span><IconExternalLink :size="16" aria-hidden="true" /></a>
  </div>
</template>
<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from "vue";
import { translate } from "@miaoimg/i18n/vue";
import { IconWorld, IconExternalLink, IconRefresh, IconDownload, IconPower, IconBook } from "@tabler/icons-vue";
import { MIAO_MANUAL_URL as manualUrl } from "@/lib/productLinks";
import settingsSection from "../components/settingsSection.vue";

type UpdateState = "idle" | "checking" | "latest" | "available" | "downloading" | "ready" | "failed" | "dev";
interface UpdateSnapshot { canCheck: boolean; canInstall: boolean; currentVersion: string; state: UpdateState; version: string | null; percent: number | null }
interface DesktopBridge {
  platform: string;
  updateStatus(): Promise<UpdateSnapshot>;
  checkForUpdates(): Promise<UpdateSnapshot>;
  downloadUpdate(): Promise<UpdateSnapshot>;
  quitAndInstall(): Promise<void>;
  openUpdatePage(): Promise<void>;
  onUpdateStatus(callback: (status: UpdateSnapshot) => void): () => void;
}

const bridge = (window as unknown as { miaoDesktop?: DesktopBridge }).miaoDesktop;
const snapshot = ref<UpdateSnapshot | null>(null);
const action = ref(false);
let disposed = false;
const unsubscribe = bridge?.onUpdateStatus((status) => { if (!disposed) snapshot.value = status; });
onBeforeUnmount(() => { disposed = true; unsubscribe?.(); });

const desktopVersion = computed(() => snapshot.value?.currentVersion || "");
const canCheck = computed(() => snapshot.value?.canCheck !== false);
const desktopHint = computed(() => bridge?.platform === "darwin" ? "桌面版在这里检查并自动更新" : "桌面版在这里检查并安装新版本");
const busy = computed(() => action.value || ["checking", "downloading"].includes(snapshot.value?.state || ""));
const actionLabel = computed(() => {
  const state = snapshot.value;
  if (!state) return "检查更新";
  if (state.state === "available" || state.state === "downloading") return state.canInstall ? "下载更新" : "打开下载页";
  if (state.state === "ready") return state.canInstall ? "立即重启更新" : "打开下载页";
  if (state.state === "failed") return "重试";
  return "检查更新";
});
const actionIcon = computed(() => actionLabel.value === "立即重启更新" ? IconPower : actionLabel.value === "打开下载页" ? IconExternalLink : actionLabel.value === "下载更新" ? IconDownload : IconRefresh);
const statusText = computed(() => {
  const state = snapshot.value;
  if (!state) return "";
  if (state.state === "checking") return translate("正在检查更新") + "…";
  if (state.state === "latest") return translate("当前已是最新版本 v{0}", { 0: state.currentVersion });
  if (state.state === "available") return state.version === state.currentVersion ? translate("当前版本有更新可下载") : translate("发现新版本 v{0}", { 0: state.version || "" });
  if (state.state === "downloading") return translate("正在下载更新 {0}%", { 0: state.percent ?? 0 });
  if (state.state === "ready") return translate("更新已下载，重启后生效");
  if (state.state === "failed") return translate("更新检查失败，请稍后重试");
  if (state.state === "dev") return translate("开发版不检查更新");
  return "";
});

async function runAction() {
  if (!bridge || busy.value) return;
  action.value = true;
  try {
    const state = snapshot.value;
    if (state?.state === "available" && !state.canInstall) await bridge.openUpdatePage();
    else if (state?.state === "ready" && state.canInstall) await bridge.quitAndInstall();
    else {
      const next = state?.state === "available" && state.canInstall
        ? await bridge.downloadUpdate() : await bridge.checkForUpdates();
      if (!disposed) snapshot.value = next;
    }
  } catch {
    if (!disposed && snapshot.value) snapshot.value = { ...snapshot.value, state: "failed" };
  } finally { if (!disposed) action.value = false; }
}

onMounted(async () => {
  if (!bridge) return;
  try { const next = await bridge.updateStatus(); if (!disposed) snapshot.value = next; } catch {}
});
</script>
<style scoped lang="scss">
.about { display: flex; flex-direction: column; gap: 28px; }
.brand { display: flex; align-items: center; gap: 14px; img { width: 48px; height: 48px; object-fit: contain; } h3 { margin: 0; font-size: 18px; } p { margin: 6px 0 0; font-size: 13px; color: var(--el-text-color-secondary); } }
.version { margin: 4px 0 8px; font-size: 22px; }
.hint { margin: 0; color: var(--el-text-color-secondary); font-size: 13px; line-height: 1.7; }
.updateRow { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin-top: 14px; }
.status { margin: 0; color: var(--el-text-color-secondary); font-size: 13px; line-height: 1.7; }
.supportActions { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
.website { display: flex; align-items: center; gap: 10px; width: fit-content; color: var(--el-text-color-primary); text-decoration: none; padding: 10px 14px; background: rgba(255, 255, 255, .035); border-radius: 10px; &:hover { background: rgba(255, 255, 255, .07); } &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 2px; } }
</style>
