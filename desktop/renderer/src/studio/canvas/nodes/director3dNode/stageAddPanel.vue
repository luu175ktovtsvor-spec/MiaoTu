<template>
  <section class="stageAddPanel" :aria-label="title">
    <header>{{ title }}</header>
    <div v-if="panel === 'actors'" class="actorList">
      <button v-for="(build, id) in bodyTypes" :key="id" type="button" :disabled="disabled" @click="emit('addActor', id, false)"><icon-walk :size="15" aria-hidden="true"/><span>{{ translate(build.name) }}</span></button>
      <button type="button" :disabled="disabled" @click="emit('addActor', 'standard', true)"><icon-users :size="15" aria-hidden="true"/><span>{{ translate('群众 (3x3)') }}</span></button>
      <button type="button" :disabled="disabled" @click="emit('openAssets')"><icon-cube :size="15" aria-hidden="true"/><span>{{ translate('布景库') }}</span><icon-chevron-right class="trail" :size="14" aria-hidden="true"/></button>
    </div>
    <div v-else-if="panel === 'cameras'" class="cardGrid">
      <button type="button" :disabled="disabled" @click="emit('addCamera', 'current')"><icon-camera :size="18" aria-hidden="true"/><span>{{ translate('当前视角') }}</span></button>
      <button v-for="preset in shotPresets" :key="preset.id" type="button" :disabled="disabled || !hasSubject" @click="emit('addCamera', preset.id)"><icon-camera :size="18" aria-hidden="true"/><span>{{ translate(preset.name) }}</span></button>
    </div>
    <div v-else class="cardGrid" role="radiogroup" :aria-label="title">
      <button v-for="ratio in aspectRatios" :key="ratio" type="button" role="radio" :aria-checked="aspectRatio === ratio" :class="{ active: aspectRatio === ratio }" :disabled="disabled" @click="aspectRatio = ratio"><i class="ratioShape" :style="ratioShape(ratio)" aria-hidden="true"/><span>{{ ratio }}</span></button>
    </div>
  </section>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { IconCamera, IconChevronRight, IconCube, IconUsers, IconWalk } from '@tabler/icons-vue';
import { translate } from '@miaoimg/i18n/vue';
import { bodyTypes, type BodyType } from './mannequin';
import { aspectRatios, shotPresets } from './cameraPresets';

const props = defineProps<{ panel: 'actors' | 'cameras' | 'ratio'; disabled?: boolean; hasSubject?: boolean }>();
const aspectRatio = defineModel<string>('aspectRatio', { required: true });
const emit = defineEmits<{ addActor: [bodyType: BodyType, crowd: boolean]; addCamera: [presetId: string]; openAssets: [] }>();
const title = computed(() => translate(props.panel === 'actors' ? '添加角色' : props.panel === 'cameras' ? '添加机位' : '画面比例'));
// A small outline of the frame, longest side 16px.
function ratioShape(ratio: string) {
  const [width, height] = ratio.split(':').map(Number) as [number, number];
  const scale = 16 / Math.max(width, height);
  return { width: `${Math.round(width * scale)}px`, height: `${Math.round(height * scale)}px` };
}
</script>
<style scoped>
.stageAddPanel { display:flex; flex-direction:column; min-height:0; flex:1; padding:12px 8px; overflow-y:auto; }
header { padding:0 4px 12px; font-size:12px; color:var(--el-text-color-primary); }
.actorList { display:flex; flex-direction:column; gap:2px; }
.actorList button { display:flex; align-items:center; gap:8px; height:32px; padding:0 8px; border:0; border-radius:8px; background:transparent; color:var(--el-text-color-regular); font:inherit; font-size:12px; text-align:left; cursor:pointer; }
.actorList button:hover:not(:disabled) { background:rgba(255,255,255,.06); color:var(--el-text-color-primary); }
.actorList .trail { margin-left:auto; color:var(--el-text-color-secondary); }
.cardGrid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
.cardGrid button { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:6px; height:72px; padding:0 4px; border:1px solid rgba(255,255,255,.1); border-radius:10px; background:transparent; color:var(--el-text-color-regular); font:inherit; font-size:12px; cursor:pointer; }
.cardGrid button span { max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.cardGrid button:hover:not(:disabled) { border-color:rgba(255,255,255,.28); color:var(--el-text-color-primary); }
.cardGrid button.active { border-color:#f2f2f3; color:var(--el-text-color-primary); }
.ratioShape { display:block; border:1.5px solid currentColor; border-radius:3px; box-sizing:border-box; }
button:disabled { opacity:.4; cursor:default; }
button:focus-visible { outline:1px solid #f2f2f3; outline-offset:1px; }
</style>
