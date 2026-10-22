<template>
  <div class="canvasShortcuts">
    <settings-section :title="translate('画布快捷键')" :description="bindHint">
      <template #actions>
        <el-dropdown trigger="click" @command="changeBindMode">
          <el-button text size="small" :aria-label="translate('快捷键绑定方式')">
            {{ bindMode === 'listen' ? translate('按键录制') : translate('手动输入') }}
            <icon-chevron-down :size="14" />
          </el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="listen" :icon="IconKeyboard">{{ translate('按键录制') }}</el-dropdown-item>
              <el-dropdown-item command="input" :icon="IconEdit">{{ translate('手动输入') }}</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <el-button text size="small" :icon="IconRestore" @click="resetShortcuts">{{ translate('恢复默认') }}</el-button>
      </template>

      <settings-row
        v-for="field in canvasShortcutFields"
        :key="`${field.id}:${resetKey}`"
        :label="translate(field.label)"
        :description="gestureHint(field.gesture, field.hold)"
        control-width="300px">
        <template v-if="issues[field.id]" #info>
          <span class="rowIssue">{{ issues[field.id] }}</span>
        </template>
        <key-input
          :code="generalSettings.canvasShortcuts[field.id]"
          :mode="bindMode"
          :label="translate('{0}快捷键', { 0: translate(field.label) })"
          :hold="field.hold"
          @change="setShortcut(field.id, $event)" />
      </settings-row>
    </settings-section>

    <settings-section :title="translate('触摸板与鼠标')">
      <settings-row :label="translate('触摸板缩放')" control-width="300px">
        <span class="gestureValue"><icon-hand-two-fingers :size="16" aria-hidden="true" />{{ translate('双指捏合') }}</span>
      </settings-row>
      <settings-row :label="translate('触摸板平移')" control-width="300px">
        <span class="gestureValue"><icon-hand-two-fingers :size="16" aria-hidden="true" />{{ translate('双指滑动') }}</span>
      </settings-row>
      <settings-row :label="translate('鼠标平移')" control-width="300px">
        <span class="gestureValue"><icon-mouse :size="16" aria-hidden="true" />{{ translate('滚轮 / 中键拖动') }}</span>
      </settings-row>
    </settings-section>
  </div>
</template>

<script setup lang="ts">
import { translate } from "@miaoimg/i18n/vue";
import { computed, ref } from "vue";
import { IconRestore, IconChevronDown, IconKeyboard, IconEdit, IconHandTwoFingers, IconMouse } from "@tabler/icons-vue";
import settingsRow from "../../components/settingsRow.vue";
import settingsSection from "../../components/settingsSection.vue";
import { generalSettings, updateGeneralSettings } from "@/stores/settings";
import { canvasShortcutFields, defaultCanvasShortcuts, getShortcutBindings, isShortcutAllowed, normalizeShortcut, type CanvasShortcutAction } from "@/lib/canvasShortcuts";
import keyInput from "./keyInput.vue";

const bindMode = ref<"listen" | "input">("listen");
const resetKey = ref(0);
const issues = ref<Partial<Record<CanvasShortcutAction, string>>>({});

const bindHint = computed(() => bindMode.value === "listen"
  ? translate("点键帽后按下新按键，Esc 退出；右侧 × 取消绑定。")
  : translate("填按键代号，如 Ctrl+KeyG；回车或移开焦点保存，留空即不绑定。"));

function gestureHint(gesture: "drag" | "wheel" | undefined, hold: boolean | undefined) {
  if (!hold) return "";
  if (gesture === "drag") return translate("按住并拖动节点");
  if (gesture === "wheel") return translate("按住并滚动");
  return translate("按住并拖动画布");
}

function changeBindMode(mode: "listen" | "input") {
  bindMode.value = mode;
  issues.value = {};
}

function setShortcut(action: CanvasShortcutAction, value: string) {
  const binding = normalizeShortcut(value);
  const field = canvasShortcutFields.find(field => field.id === action)!;
  if (binding === undefined || !isShortcutAllowed(field, binding)) {
    issues.value[action] = binding === undefined ? translate("请输入有效按键，例如 Ctrl+KeyG。")
      : field.gesture === "drag" ? translate("拖拽操作只绑定修饰键，例如 Alt 或 Ctrl+Alt。") : translate("此操作需要普通按键，例如 KeyP 或 Ctrl+KeyZ。");
    return;
  }
  const bindings = getShortcutBindings(binding);
  const conflict = canvasShortcutFields.find(other => other.id !== action && other.gesture === field.gesture
    && getShortcutBindings(generalSettings.value.canvasShortcuts[other.id]).some(value => bindings.includes(value)));
  if (conflict) {
    issues.value[action] = translate("与「{0}」重复，请换一个快捷键。", { 0: translate(conflict.label) });
    return;
  }
  delete issues.value[action];
  updateGeneralSettings({ canvasShortcuts: { ...generalSettings.value.canvasShortcuts, [action]: binding } });
}

function resetShortcuts() {
  issues.value = {};
  resetKey.value++;
  updateGeneralSettings({ canvasShortcuts: { ...defaultCanvasShortcuts } });
}
</script>

<style lang="scss" scoped>
.canvasShortcuts {
  display: flex;
  flex-direction: column;
  gap: var(--settings-gap-section);

  :deep(.el-dropdown) { line-height: 1; }
}

// 快捷键冲突提示跟在行说明后面，单独起一行时也要有组内的那点间距，不能贴着上面的说明。
.rowIssue {
  display: block;
  margin-top: var(--settings-gap-group);
  color: var(--el-color-danger);
  font-size: 12px;
  line-height: 1.6;
}

.gestureValue {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  color: var(--el-text-color-regular);
  font-size: 13px;
}
</style>
