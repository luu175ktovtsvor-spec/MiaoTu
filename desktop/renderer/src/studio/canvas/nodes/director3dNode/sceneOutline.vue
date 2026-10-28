<template>
  <aside class="sceneOutline" :aria-label="translate('场景物体')">
    <div class="outlineHeader">{{ translate('场景') }} <small>{{ objects.length }}</small></div>
    <el-input v-model="query" class="outlineSearch" :prefix-icon="IconSearch" clearable size="small" :placeholder="translate('搜索物体')" :aria-label="translate('搜索物体')" />
    <div class="outlineList" role="listbox" :aria-label="translate('场景物体')">
      <button
        v-for="object in filtered"
        :key="object.threeJsonId"
        type="button"
        role="option"
        class="outlineItem"
        :class="{ selected: object.threeJsonId === selectedId }"
        :aria-selected="object.threeJsonId === selectedId"
        @click="selectedId = selectedId === object.threeJsonId ? '' : object.threeJsonId">
        <component :is="object.objType === 'mannequin' ? IconWalk : IconCube" :size="15" aria-hidden="true" />
        <span>{{ displayName(object) }}</span>
      </button>
      <p v-if="!filtered.length" class="outlineEmpty">{{ objects.length ? translate('没有匹配的物体') : translate('添加人偶或生成场景后，物体会列在这里') }}</p>
    </div>

    <section v-if="selected && draft" class="objectProperties" :aria-label="translate('物体属性')">
      <div class="propertyTitle">{{ translate('属性') }}</div>
      <p v-if="animated" class="propertyHint">{{ translate('当前方案有这个物体的动画，播放和预览以动画为准') }}</p>
      <label class="propertyLabel">{{ translate('名称') }}</label>
      <el-input v-model="draft.name" size="small" :maxlength="100" :disabled="disabled" @change="commit" />
      <template v-for="group in vectorGroups" :key="group.key">
        <label class="propertyLabel">{{ translate(group.label) }}</label>
        <div class="vectorRow">
          <el-input-number
            v-for="axis in (['x', 'y', 'z'] as const)"
            :key="axis"
            v-model="draft[group.key][axis]"
            size="small"
            :controls="false"
            :step="group.step"
            :precision="group.precision"
            :min="group.min"
            :disabled="disabled"
            :aria-label="`${translate(group.label)} ${axis.toUpperCase()}`"
            @change="commit">
            <template #prefix>{{ axis.toUpperCase() }}</template>
          </el-input-number>
        </div>
      </template>
      <label class="propertyLabel">{{ translate('统一缩放') }}</label>
      <div class="uniformRow">
        <el-slider v-model="uniformScale" :min="0.1" :max="5" :step="0.01" :disabled="disabled" :aria-label="translate('统一缩放')" @change="commit" />
        <el-input-number v-model="uniformScale" size="small" :controls="false" :min="0.01" :step="0.1" :precision="2" :disabled="disabled" :aria-label="translate('统一缩放')" @change="commit" />
      </div>
      <label class="propertyLabel">{{ translate('颜色') }}</label>
      <el-color-picker v-model="draft.color" size="small" :teleported="false" colorFormat="hex" :disabled="disabled" :aria-label="translate('物体颜色')" @change="commit" />
    </section>
  </aside>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ElColorPicker, ElInput, ElInputNumber, ElSlider } from "element-plus";
import { IconCube, IconSearch, IconWalk } from "@tabler/icons-vue";
import { translate } from "@miaoimg/i18n/vue";
import type { ObjectPatch, SceneDocument } from "./scene";

type SceneObject = SceneDocument["objectList"][number];

const props = defineProps<{ objects: SceneObject[]; animatedIds?: string[]; disabled?: boolean }>();
const emit = defineEmits<{ preview: [id: string, patch: ObjectPatch]; commit: [id: string, patch: ObjectPatch] }>();
const selectedId = defineModel<string>("selectedId", { default: "" });
const query = ref("");

const typeNames: Record<SceneObject["objType"], string> = {
  mannequin: "人偶", box: "立方体", sphere: "球体", cylinder: "圆柱", cone: "圆锥", ring: "圆环", torus: "圆环体", capsule: "胶囊", plane: "平面",
};
function baseName(object: SceneObject) {
  return object.name?.trim() || translate(typeNames[object.objType]);
}
// 重名的物体（如旧场景里的多个“关节人偶”）在列表中按顺序编号，不改场景数据。
const displayNames = computed(() => {
  const totals = new Map<string, number>();
  for (const object of props.objects) totals.set(baseName(object), (totals.get(baseName(object)) ?? 0) + 1);
  const seen = new Map<string, number>();
  return new Map(props.objects.map(object => {
    const name = baseName(object);
    const index = (seen.get(name) ?? 0) + 1;
    seen.set(name, index);
    return [object.threeJsonId, totals.get(name)! > 1 ? `${name} ${index}` : name];
  }));
});
function displayName(object: SceneObject) {
  return displayNames.value.get(object.threeJsonId) ?? baseName(object);
}
const filtered = computed(() => {
  const keyword = query.value.trim().toLocaleLowerCase();
  return props.objects.filter(object => !keyword || `${displayName(object)} ${translate(typeNames[object.objType])}`.toLocaleLowerCase().includes(keyword));
});
const selected = computed(() => props.objects.find(object => object.threeJsonId === selectedId.value));
const animated = computed(() => Boolean(selected.value && props.animatedIds?.includes(selected.value.threeJsonId)));
watch(() => props.objects, objects => { if (selectedId.value && !objects.some(object => object.threeJsonId === selectedId.value)) selectedId.value = ""; });

// 面板里旋转用角度，场景文件保存弧度，与参考工具的输入习惯一致。
const degrees = (radians = 0) => Math.round(radians * 180 / Math.PI * 100) / 100;
const radians = (value: number) => value * Math.PI / 180;
interface Draft { name: string; position: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number }; scale: { x: number; y: number; z: number }; color: string }
const draft = ref<Draft>();
watch(selected, object => {
  draft.value = object && {
    name: object.name ?? "",
    position: { ...object.position },
    rotation: { x: degrees(object.rotation?.rotationX), y: degrees(object.rotation?.rotationY), z: degrees(object.rotation?.rotationZ) },
    scale: { x: object.scale?.scaleX ?? 1, y: object.scale?.scaleY ?? 1, z: object.scale?.scaleZ ?? 1 },
    color: object.material.color,
  };
}, { immediate: true });

const vectorGroups = [
  { key: "position", label: "位置", step: 0.1, precision: 2, min: -10000 },
  { key: "rotation", label: "旋转", step: 5, precision: 1, min: -10000 },
  { key: "scale", label: "缩放", step: 0.1, precision: 2, min: 0.01 },
] as const;

// 统一缩放按当前 X 缩放为基准等比改三轴。
const uniformScale = computed({
  get: () => draft.value?.scale.x ?? 1,
  set: value => { if (draft.value && Number.isFinite(value) && value > 0) draft.value.scale = { x: value, y: value, z: value }; },
});

function patch(): ObjectPatch | undefined {
  const value = draft.value;
  if (!value) return;
  const number = (input: number | undefined, fallback: number) => Number.isFinite(input) ? input! : fallback;
  return {
    name: value.name.trim(),
    position: { x: number(value.position.x, 0), y: number(value.position.y, 0), z: number(value.position.z, 0) },
    rotation: { rotationX: radians(number(value.rotation.x, 0)), rotationY: radians(number(value.rotation.y, 0)), rotationZ: radians(number(value.rotation.z, 0)) },
    scale: { scaleX: Math.max(0.01, number(value.scale.x, 1)), scaleY: Math.max(0.01, number(value.scale.y, 1)), scaleZ: Math.max(0.01, number(value.scale.z, 1)) },
    color: /^#[\da-f]{6}$/i.test(value.color) ? value.color : selected.value!.material.color,
  };
}
// 编辑时即时预览到三维画面；数值确认（回车、失焦、松开滑块）后再保存，避免每个按键都写盘。
watch(draft, () => {
  const value = patch();
  if (value && selected.value) emit("preview", selected.value.threeJsonId, value);
}, { deep: true });
function commit() {
  const value = patch();
  if (value && selected.value) emit("commit", selected.value.threeJsonId, value);
}
</script>

<style lang="scss" scoped>
.sceneOutline {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  font-size: 13px;
}
.outlineHeader, .propertyTitle { color: var(--el-text-color-primary); font-weight: 500; small { margin-left: 4px; color: var(--el-text-color-secondary); font-weight: 400; } }
.outlineList {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-height: 72px;
  max-height: 34%;
  overflow-y: auto;
  flex-shrink: 0;
}
.outlineItem {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 30px;
  padding: 0 8px;
  border: 0;
  border-radius: var(--el-border-radius-base);
  background: transparent;
  color: var(--el-text-color-regular);
  text-align: left;
  cursor: pointer;
  span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  &:hover { background: var(--el-fill-color-light); }
  &.selected { background: var(--el-fill-color); color: var(--el-text-color-primary); }
}
.outlineEmpty, .propertyHint { margin: 4px 8px; color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.5; }
.objectProperties {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 0;
  padding-top: 8px;
  overflow-y: auto;
}
.propertyLabel { margin-top: 4px; color: var(--el-text-color-secondary); font-size: 12px; }
.vectorRow { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px; }
.vectorRow :deep(.el-input-number) { width: 100%; }
.vectorRow :deep(.el-input__prefix) { color: var(--el-text-color-secondary); font-size: 11px; }
.uniformRow { display: grid; grid-template-columns: minmax(0, 1fr) 64px; align-items: center; gap: 10px; padding-left: 6px; }
.uniformRow :deep(.el-input-number) { width: 100%; }
</style>
