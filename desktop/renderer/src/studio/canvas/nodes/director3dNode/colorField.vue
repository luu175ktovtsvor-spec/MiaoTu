<template>
  <div class="colorField" :class="{ disabled }">
    <el-color-picker :modelValue="modelValue" :clearable="false" :teleported="true" popper-class="directorColorPanel" colorFormat="hex" :disabled="disabled" :aria-label="label" @update:modelValue="$event && emit('input', $event)" @change="$event && emit('change', $event)" />
    <label class="hexInput"><span aria-hidden="true">#</span><input :value="text" :disabled="disabled" maxlength="7" spellcheck="false" :aria-label="label" @input="text = ($event.target as HTMLInputElement).value" @change="commitText" @keydown.enter="($event.target as HTMLInputElement).blur()" /></label>
  </div>
</template>
<script setup lang="ts">
import { ref, watch } from 'vue';
import { ElColorPicker } from 'element-plus';
// A swatch plus an editable hex value; invalid text snaps back instead of committing.
const props = defineProps<{ modelValue?: string; disabled?: boolean; label?: string }>();
const emit = defineEmits<{ input: [color: string]; change: [color: string] }>();
const plain = (color?: string) => (color ?? '').replace(/^#/, '').toUpperCase();
const text = ref(plain(props.modelValue));
watch(() => props.modelValue, value => text.value = plain(value));
function commitText() {
  const value = text.value.trim().replace(/^#/, '');
  if (!/^[0-9a-f]{6}$/i.test(value)) { text.value = plain(props.modelValue); return; }
  const color = `#${value.toLowerCase()}`;
  text.value = value.toUpperCase();
  if (color !== props.modelValue?.toLowerCase()) emit('change', color);
}
</script>
<style scoped>
.colorField { display:flex; align-items:center; gap:8px; min-width:0; width:100%; box-sizing:border-box; }
.colorField :deep(.el-color-picker__trigger) { width:28px; height:28px; padding:0; border:0; border-radius:6px; }
.colorField :deep(.el-color-picker__color) { border:0; border-radius:6px; }
.colorField :deep(.el-color-picker__color-inner) { border-radius:6px; box-shadow:inset 0 0 0 1px rgba(255,255,255,.12); }
.colorField :deep(.el-color-picker__icon) { display:none; }
.hexInput { flex:1; min-width:0; display:flex; align-items:center; gap:2px; height:28px; padding:0 8px; border-radius:8px; background:rgba(255,255,255,.1); color:var(--el-text-color-secondary); font-size:12px; }
.hexInput input { flex:1; min-width:0; border:0; outline:0; padding:0; background:transparent; color:var(--el-text-color-primary); font:inherit; font-variant-numeric:tabular-nums; text-transform:uppercase; }
.hexInput:focus-within { box-shadow:inset 0 0 0 1px var(--el-color-primary); }
.colorField.disabled .hexInput { opacity:.5; }
</style>
