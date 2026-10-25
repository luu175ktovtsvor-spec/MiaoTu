<template></template>
<script setup lang="ts">
import { h, useSlots, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { userFacingError } from '../../../../../../server/user-errors.ts'

const props = withDefaults(defineProps<{ message: string; action?: string; disabled?: boolean; error?: boolean }>(), { error: true })
const emit = defineEmits<{ action: []; close: [] }>()
const slots = useSlots()
watch(() => [props.message, props.action, props.disabled, props.error] as const, (_, __, onCleanup) => {
  if (!props.message) return
  let active = true
  const notice = ElMessage({
    message: h('div', { class: 'feedback-notice-content' }, [
      h('span', props.error ? userFacingError(props.message) : props.message),
      ...(props.action ? [h('button', { type: 'button', class: 'feedback-notice-action', disabled: props.disabled, onClick: () => emit('action') }, props.action)] : []),
      ...(slots.default ? slots.default() : []),
    ]),
    type: props.error ? 'error' : 'info', offset: 64, duration: props.error ? 0 : 4000, showClose: props.error,
    onClose: () => { if (active) emit('close') },
  })
  onCleanup(() => { active = false; notice.close() })
}, { immediate: true })
</script>
