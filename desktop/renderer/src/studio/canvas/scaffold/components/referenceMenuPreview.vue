<template>
  <span class="referenceMenuPreview" aria-hidden="true">
    <img v-if="url && !failed" :src="url" alt="" loading="lazy" draggable="false" @error="onError" />
    <component v-else :is="icon" :size="17" />
  </span>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { IconFileText, IconMusic, IconPhoto, IconVideo } from "@tabler/icons-vue";
import { useNodeFiles } from "../workspaceFiles";
import type { ReferenceMenuItem } from "../referenceMenu";

const props = defineProps<{ item: ReferenceMenuItem }>();
const failed = ref(false), original = ref(false);
const media = computed(() => !props.item.avatar && ["IMAGE", "VIDEO"].includes(props.item.kind || "") ? props.item.media : undefined);
watch(() => JSON.stringify([props.item.id, props.item.avatar, props.item.media]), () => { failed.value = false; original.value = false; });
const { useFileUrl } = useNodeFiles();
const thumbnail = useFileUrl(media, () => onError(), 320);
const source = useFileUrl(computed(() => original.value ? media.value : undefined), () => { failed.value = true; });
const url = computed(() => props.item.avatar ? String(props.item.avatar) : original.value ? source.value : thumbnail.value);
const icon = computed(() => ({ IMAGE: IconPhoto, VIDEO: IconVideo, AUDIO: IconMusic, STRING: IconFileText })[props.item.kind || "IMAGE"]);
function onError() {
  if (!props.item.avatar && props.item.kind === "IMAGE" && !original.value) original.value = true;
  else failed.value = true;
}
</script>

<style scoped>
.referenceMenuPreview { display: grid; place-items: center; flex: none; width: 24px; height: 24px; overflow: hidden; border-radius: 5px; background: var(--el-fill-color); color: var(--el-text-color-secondary); }
.referenceMenuPreview img { width: 100%; height: 100%; object-fit: cover; }
</style>
