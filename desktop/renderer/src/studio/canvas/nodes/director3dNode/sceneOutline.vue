<template>
  <aside class="sceneOutline" :class="{ inspectorOnly: view === 'inspector', outlineOnly: view === 'outline' }" :aria-label="translate('场景物体')">
    <div v-if="!view" class="outlineTabs"><button :class="{ active: tab === 'scene' }" @click="tab = 'scene'">{{ translate('场景') }}</button><button :class="{ active: tab === 'assets' }" @click="tab = 'assets'">{{ translate('布景库') }}</button></div>
    <stageAssets v-if="view !== 'inspector' && tab === 'assets'" :disabled="disabled" @addActor="emit('addActor')" @addObjects="emit('addObjects', $event)" />
    <template v-else>
    <template v-if="view !== 'inspector'">
    <div class="outlineHeader"><span>{{ translate('场景') }} <small>{{ entries.length + (cameraCount ?? 0) }}</small></span><slot name="actions" /></div>
    <el-input v-model="query" class="outlineSearch" :prefix-icon="IconSearch" clearable size="small" :placeholder="translate('搜索物体')" :aria-label="translate('搜索物体')" />
    <div class="outlineList" role="listbox" :aria-label="translate('场景物体')">
      <slot name="cameras" :query="query" />
      <template v-for="object in filtered" :key="object.threeJsonId">
        <div class="outlineEntry">
          <button v-if="object.assemblyEntry" class="expandParts" :aria-label="translate('展开道具零件')" :aria-expanded="expanded.has(object.threeJsonId)" @click="toggleParts(object.threeJsonId)"><icon-chevron-right :size="12" :class="{ expanded: expanded.has(object.threeJsonId) }" /></button>
          <button type="button" role="option" class="outlineItem" :disabled="selectionDisabled" :class="{ selected: object.threeJsonId === selectedId }" :aria-selected="object.threeJsonId === selectedId" @click="selectedId = selectedId === object.threeJsonId ? '' : object.threeJsonId">
            <component :is="object.objType === 'mannequin' ? IconWalk : IconCube" :size="15" aria-hidden="true" /><span>{{ displayName(object) }}</span><small v-if="object.assemblyEntry">{{ object.partCount }}</small>
          </button>
        </div>
        <template v-if="object.assemblyEntry && (expanded.has(object.threeJsonId) || query.trim())">
          <button v-for="part in objects.filter(part => part.assembly?.id === object.threeJsonId)" :key="part.threeJsonId" class="outlineItem partItem" role="option" :disabled="selectionDisabled" :aria-selected="part.threeJsonId === selectedId" :class="{ selected: part.threeJsonId === selectedId }" @click="selectedId = part.threeJsonId"><icon-cube :size="12"/><span>{{ displayName(part) }}</span></button>
        </template>
      </template>
      <p v-if="!filtered.length && !cameraCount" class="outlineEmpty">{{ objects.length ? translate('没有匹配的物体') : translate('添加人偶或生成场景后，物体会列在这里') }}</p>
    </div>

    </template>
    <section v-if="view !== 'outline' && selected && draft" class="objectProperties" :aria-label="translate('物体属性')">
      <div class="propertyTitle"><div class="inspectorTabs"><button :class="{ active: inspectorTab === 'properties' || selected.objType !== 'mannequin' }" @click="inspectorTab = 'properties'">{{ translate('属性') }}</button><button v-if="selected.objType === 'mannequin'" :class="{ active: inspectorTab === 'pose' }" @click="inspectorTab = 'pose'">{{ translate('姿势') }}</button></div><div class="objectActions"><button :disabled="disabled" :title="translate('聚焦物体')" :aria-label="translate('聚焦物体')" @click="emit('focus', selectedId)"><icon-focus-2 :size="15" /></button><button :disabled="disabled" :title="translate('复制物体')" :aria-label="translate('复制物体')" @click="emit('duplicate', selectedId)"><icon-copy :size="15" /></button><button :disabled="disabled" :title="translate('删除物体')" :aria-label="translate('删除物体')" @click="emit('remove', selectedId)"><icon-trash :size="15" /></button></div></div>
      <el-button v-if="selected.assemblyEntry" size="small" :disabled="disabled" @click="emit('ungroup', selectedId)">{{ translate('拆开道具') }}</el-button>
      <p v-if="animationEditing||animated" class="propertyHint">{{ translate(animationEditing?'角色录帧中：变换与姿势会写入当前时间':'这是基础场景属性；动作关键帧请在时间轴中编辑') }}</p>
      <template v-if="inspectorTab === 'properties' || selected.objType !== 'mannequin'">
      <label class="propertyLabel">{{ translate('名称') }}</label>
      <el-input v-model="draft.name" size="small" :maxlength="100" :disabled="disabled||animationEditing" @change="commit" />
      <template v-for="group in propertyVectors" :key="group.key">
        <label class="propertyLabel">{{ translate(group.label) }}</label>
        <div class="vectorRow">
          <el-input-number v-number-a11y
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
        <el-input-number v-number-a11y v-model="uniformScale" size="small" :controls="false" :min="0.01" :step="0.1" :precision="2" :disabled="disabled" :aria-label="translate('统一缩放')" @change="commit" />
      </div>
      <label class="propertyLabel">{{ translate('颜色') }}</label>
      <div class="colorPalette"><button v-for="color in actorColors" :key="color" :style="{ background: color }" :class="{ chosen: !mixedColor && draft.color === color }" :disabled="disabled||animationEditing" :aria-label="translate('颜色 {0}', { 0: color })" @click="setColor(color)" /></div>
      <colorField :modelValue="mixedColor ? undefined : draft.color" :disabled="disabled||animationEditing" :label="translate('物体颜色')" @input="draft.color = $event" @change="draft.color = $event; commitColor()" />
      <small v-if="mixedColor" class="mixedColor">{{ translate('多种颜色') }}</small>
      <label class="propertyLabel">{{ translate('材质') }}</label>
      <div class="materialButtons"><button v-for="material in materials" :key="material.name" :disabled="disabled||animationEditing" @click="setMaterial(material)">{{ translate(material.name) }}</button></div>
      </template>
      <template v-if="selected.objType === 'mannequin' && inspectorTab === 'pose'">
        <div class="poseGrid"><button v-for="pose in posePresets" :key="pose.id" :disabled="disabled" @click="applyPose(pose.id)">{{ translate(pose.name) }}</button></div>
        <label class="propertyLabel">{{ translate('关节') }}</label>
        <select v-model="joint" class="jointSelect" :aria-label="translate('关节')"><option v-for="name in mannequinJoints" :key="name" :value="name">{{ translate(jointLabels[name]!) }}</option></select>
        <div v-for="control in jointControls" :key="control.axis" class="jointRow"><span :title="control.label">{{ control.label }}</span><el-slider :modelValue="Math.max(-180,Math.min(180,jointAngleDegrees(control,draft.pose?.[joint]?.[control.axis])))" :min="-180" :max="180" :step="1" :disabled="disabled" :aria-label="`${translate(jointLabels[joint]!)} ${control.label}`" @update:modelValue="setJoint(control,Number($event))" @change="commit" /><el-input-number v-number-a11y :modelValue="jointAngleDegrees(control,draft.pose?.[joint]?.[control.axis])" size="small" :controls="false" :precision="2" :step="1" :disabled="disabled" :aria-label="translate('{0} {1}角度',{0:translate(jointLabels[joint]!),1:control.label})" @change="commitJoint(control,$event)"><template #suffix>°</template></el-input-number></div>
      </template>
    </section>
    <slot v-if="view !== 'outline' && !selected" name="scene" />
    </template>
  </aside>
</template>

<script setup lang="ts">
import { vNumberA11y } from './numberInputA11y';
import { computed, ref, watch } from "vue";
import { ElInput, ElInputNumber, ElSlider, ElButton } from "element-plus";
import { IconCube, IconSearch, IconWalk, IconCopy, IconTrash, IconFocus2, IconChevronRight } from "@tabler/icons-vue";
import { translate } from "@miaoimg/i18n/vue";
import stageAssets from "./stageAssets.vue";
import colorField from "./colorField.vue";
import { actorColors, posePresets, jointLabels, applyActorPosePreset } from "./stageLibrary";
import { mannequinJoints } from "./mannequin";
import { jointAngleControls, jointAngleDegrees, jointAngleRadians, type JointAngleControl } from './jointControls';
import { stageAssemblies } from './stageGroups';
import type { ObjectPatch, SceneDocument } from "./scene";

type SceneObject = SceneDocument["objectList"][number];

const props = defineProps<{ cameraCount?: number; view?: 'outline' | 'inspector'; animationEditing?:boolean; objects: SceneObject[]; animatedIds?: string[]; disabled?: boolean; selectionDisabled?: boolean }>();
const emit = defineEmits<{ preview: [id: string, patch: ObjectPatch]; commit: [id: string, patch: ObjectPatch]; addActor: []; addObjects: [objects: SceneObject[]]; focus: [id: string]; duplicate: [id: string]; ungroup: [id: string]; remove: [id: string] }>();
const selectedId = defineModel<string>("selectedId", { default: "" });
const query = ref("");
const tab = ref('scene');
const inspectorTab = ref('properties');
const joint = ref<typeof mannequinJoints[number]>('head');
const jointControls=computed(()=>jointAngleControls(joint.value));
const materials = [{ name: '哑光', roughness: 0.9, metalness: 0 }, { name: '光泽', roughness: 0.2, metalness: 0 }, { name: '金属', roughness: 0.3, metalness: 0.85 }];
watch(selectedId, () => { if (selectedId.value) tab.value = 'scene'; const group = props.objects.find(object => object.threeJsonId === selectedId.value)?.assembly; if (group) expanded.value = new Set([...expanded.value, group.id]); });

const typeNames: Record<SceneObject["objType"], string> = {
  mannequin: "人偶", box: "立方体", sphere: "球体", cylinder: "圆柱", cone: "圆锥", ring: "圆环", torus: "圆环体", capsule: "胶囊", plane: "平面",
};
function baseName(object: SceneObject) {
  return object.name?.trim() || translate(typeNames[object.objType]);
}
// 重名的物体（如旧场景里的多个“关节人偶”）在列表中按顺序编号，不改场景数据。
const displayNames = computed(() => {
  const totals = new Map<string, number>();
  for (const object of [...props.objects, ...assemblyEntries.value]) totals.set(baseName(object), (totals.get(baseName(object)) ?? 0) + 1);
  const seen = new Map<string, number>();
  return new Map([...props.objects, ...assemblyEntries.value].map(object => {
    const name = baseName(object);
    const index = (seen.get(name) ?? 0) + 1;
    seen.set(name, index);
    return [object.threeJsonId, totals.get(name)! > 1 ? `${name} ${index}` : name];
  }));
});
function displayName(object: SceneObject) {
  return displayNames.value.get(object.threeJsonId) ?? baseName(object);
}
type Entry = SceneObject & { assemblyEntry?: boolean; partCount?: number };
const assemblies = computed(() => stageAssemblies(props.objects));
const assemblyEntries = computed<Entry[]>(() => assemblies.value.map(group => ({
  threeJsonId: group.id, name: group.name, objType: 'box', geometry: {}, position: group.position, rotation: group.rotation,
  scale: { scaleX: group.scale, scaleY: group.scale, scaleZ: group.scale }, material: props.objects.find(object => object.assembly?.id === group.id)!.material,
  assemblyEntry: true, partCount: group.objectIds.length,
})));
const expanded = ref(new Set<string>());
function toggleParts(id: string) { const value = new Set(expanded.value); if (value.has(id)) value.delete(id); else value.add(id); expanded.value = value; }
const entries = computed<Entry[]>(() => [...props.objects.filter(object => !object.assembly), ...assemblyEntries.value]);
const filtered = computed(() => {
  const keyword = query.value.trim().toLocaleLowerCase();
  return entries.value.filter(object => !keyword || `${displayName(object)} ${translate(typeNames[object.objType])}`.toLocaleLowerCase().includes(keyword)
    || props.objects.some(part => part.assembly?.id === object.threeJsonId && displayName(part).toLocaleLowerCase().includes(keyword)));
});
const selected = computed<Entry | undefined>(() => assemblyEntries.value.find(object => object.threeJsonId === selectedId.value) ?? props.objects.find(object => object.threeJsonId === selectedId.value));
const animated = computed(() => Boolean(selected.value && (selected.value.assemblyEntry ? props.objects.filter(object => object.assembly?.id === selectedId.value).some(object => props.animatedIds?.includes(object.threeJsonId)) : props.animatedIds?.includes(selected.value.threeJsonId))));
watch(() => props.objects, objects => { if (selectedId.value && !objects.some(object => object.threeJsonId === selectedId.value || object.assembly?.id === selectedId.value)) selectedId.value = ''; });
const colorEdited = ref(false), materialEdited = ref(false);
const mixedColor = computed(() => Boolean(selected.value?.assemblyEntry && !colorEdited.value && new Set(props.objects.filter(object => object.assembly?.id === selectedId.value).map(object => object.material.color)).size > 1));
// 面板里旋转用角度，场景文件保存弧度，与参考工具的输入习惯一致。
const degrees = (radians = 0) => Math.round(radians * 180 / Math.PI * 100) / 100;
const radians = (value: number) => value * Math.PI / 180;
interface Draft { name: string; position: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number }; scale: { x: number; y: number; z: number }; color: string; pose: SceneObject["pose"]; posePresetHeight: number; roughness: number; metalness: number }
const draft = ref<Draft>();
let syncingDraft=false;
watch(selected, object => {
  syncingDraft=true;
  colorEdited.value = false; materialEdited.value = false;
  draft.value = object && {
    name: object.name ?? "",
    position: { ...object.position },
    rotation: { x: degrees(object.rotation?.rotationX), y: degrees(object.rotation?.rotationY), z: degrees(object.rotation?.rotationZ) },
    scale: { x: object.scale?.scaleX ?? 1, y: object.scale?.scaleY ?? 1, z: object.scale?.scaleZ ?? 1 },
    color: object.material.color,
    pose: JSON.parse(JSON.stringify(object.pose ?? {})), posePresetHeight: object.posePresetHeight ?? posePresets.find(p => JSON.stringify(p.pose) === JSON.stringify(object.pose ?? {}))?.height ?? 0, roughness: object.material.roughness ?? 0.75, metalness: object.material.metalness ?? 0,
  };
  syncingDraft=false;
}, { immediate: true,flush:'sync' });

const vectorGroups = [
  { key: "position", label: "位置", step: 0.1, precision: 2, min: -10000 },
  { key: "rotation", label: "旋转", step: 5, precision: 1, min: -10000 },
  { key: "scale", label: "缩放", step: 0.1, precision: 2, min: 0.01 },
] as const;

const propertyVectors = computed(() => selected.value?.assemblyEntry ? vectorGroups.filter(group => group.key !== 'scale') : vectorGroups);
function setColor(color: string) { if (!draft.value) return; colorEdited.value = true; draft.value.color = color; commit(); }
function commitColor() { colorEdited.value = true; commit(); }
function setMaterial(material: { roughness: number; metalness: number }) { if (!draft.value) return; materialEdited.value = true; draft.value.roughness = material.roughness; draft.value.metalness = material.metalness; commit(); }
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
    ...(selected.value?.objType === "mannequin" ? { pose: value.pose, posePresetHeight: value.posePresetHeight } : {}), roughness: value.roughness, metalness: value.metalness,
    position: { x: number(value.position.x, 0), y: number(value.position.y, 0), z: number(value.position.z, 0) },
    rotation: { rotationX: radians(number(value.rotation.x, 0)), rotationY: radians(number(value.rotation.y, 0)), rotationZ: radians(number(value.rotation.z, 0)) },
    scale: { scaleX: Math.max(0.01, number(value.scale.x, 1)), scaleY: Math.max(0.01, number(value.scale.y, 1)), scaleZ: Math.max(0.01, number(value.scale.z, 1)) },
    assemblyColor: colorEdited.value, assemblyMaterial: materialEdited.value,
    color: /^#[\da-f]{6}$/i.test(value.color) ? value.color : selected.value!.material.color,
  };
}
function applyPose(id: string) {
  if (!draft.value || !selected.value) return;
  const posed = applyActorPosePreset({ ...selected.value, position: draft.value.position, pose: draft.value.pose, posePresetHeight: draft.value.posePresetHeight }, id);
  draft.value.pose = posed.pose;
  draft.value.position = posed.position;
  draft.value.posePresetHeight = posed.posePresetHeight ?? 0;
  commit();
}

function setJoint(control:JointAngleControl,value:number) {
  if (!draft.value||!Number.isFinite(value)) return;
  const axis=control.axis;
  const pose = draft.value.pose ?? {};
  draft.value.pose = { ...pose, [joint.value]: { x: 0, y: 0, z: 0, ...pose[joint.value], [axis]: jointAngleRadians(control,value) } };
}
function commitJoint(control:JointAngleControl,value:number|undefined){if(value===undefined||!Number.isFinite(value))return;setJoint(control,value);commit();}
// 编辑时即时预览到三维画面；数值确认（回车、失焦、松开滑块）后再保存，避免每个按键都写盘。
watch(draft, () => {
  if(syncingDraft)return;
  const value = patch();
  if (value && selected.value) emit("preview", selected.value.threeJsonId, value);
}, { deep: true,flush:'sync' });
function commit() {
  const value = patch();
  if (value && selected.value) emit("commit", selected.value.threeJsonId, value);
}
defineExpose({ showAssets: () => { tab.value = 'assets'; }, showScene: () => { tab.value = 'scene'; } });
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
.outlineOnly .outlineList { flex:1; max-height:none; }
.inspectorOnly .objectProperties { flex:1; padding:8px 4px; }
.inspectorOnly { overflow-y:auto; }
.outlineHeader, .propertyTitle { color: var(--el-text-color-primary); font-weight: 500; small { margin-left: 4px; color: var(--el-text-color-secondary); font-weight: 400; } }
.outlineHeader { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 28px; }
.outlineList {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-height: 34px;
  max-height: 27%;
  overflow-y: auto;
  flex-shrink: 0;
}
.outlineEntry { display:flex; min-width:0; align-items:center; }
.outlineEntry .outlineItem { flex:1; min-width:0; }
.outlineItem small { margin-left:auto; color:var(--el-text-color-secondary); font-size:10px; }
.expandParts { width:20px; flex-shrink:0; padding:2px; border:0; background:transparent; color:var(--el-text-color-secondary); cursor:pointer; }
.expandParts svg.expanded { transform:rotate(90deg); }
.partItem { margin-left:20px; font-size:11px; }
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
  padding: 8px 3px 4px;
  scroll-padding: 72px 0 8px;
  overflow-y: auto;
}
.objectProperties > * { flex-shrink: 0; }
.propertyLabel { margin-top: 4px; color: var(--el-text-color-secondary); font-size: 12px; }
.vectorRow { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px; }
.vectorRow :deep(.el-input-number) { width: 100%; }
.vectorRow :deep(.el-input__prefix) { color: var(--el-text-color-secondary); font-size: 11px; }
.uniformRow { display: grid; grid-template-columns: minmax(0, 1fr) 64px; align-items: center; gap: 10px; padding-left: 6px; }
.uniformRow :deep(.el-input-number) { width: 100%; }

.outlineTabs {
  display:flex;
  gap:4px;
  padding:4px;
  background:var(--el-fill-color-light);
  border-radius:8px;
  margin-bottom:4px
}
.outlineTabs button {
  flex:1;
  border:0;
  border-radius:5px;
  background:transparent;
  color:var(--el-text-color-secondary);
  padding:7px;
  cursor:pointer;
  font:inherit
}
.outlineTabs button.active {
  background:var(--el-bg-color-overlay);
  color:var(--el-text-color-primary);
  box-shadow:0 1px 4px #0002
}
.propertyTitle {
  display:flex;
  justify-content:space-between;
  align-items:center;
  flex-wrap:wrap;
  gap:6px
}
.objectActions {
  display:flex;
  flex-shrink:0;
  margin-left:auto;
  gap:3px
}
.objectActions button {
  border:0;
  background:transparent;
  color:var(--el-text-color-secondary);
  padding:4px;
  cursor:pointer;
  border-radius:4px
}
.objectActions button:hover {
  background:var(--el-fill-color);
  color:var(--el-text-color-primary)
}
.mixedColor { color:var(--el-text-color-secondary); font-size:11px; }
.colorPalette {
  display: grid;
  grid-template-columns: repeat(auto-fill, 24px);
  gap: 4px;
  min-width: 0;
  flex-shrink: 0;
  box-sizing: border-box;
  padding: 5px;
  margin: 0;
}
.colorPalette button {
  flex:0 0 19px;
  width:19px;
  height:19px;
  padding:0;
  border:2px solid transparent;
  border-radius:50%;
  cursor:pointer
}
.colorPalette button.chosen {
  outline:1px solid var(--el-text-color-primary);
  outline-offset:2px
}
.materialButtons,.poseGrid {
  display:grid;
  gap:5px;
  grid-template-columns:repeat(3,1fr)
}
.materialButtons button,.poseGrid button {
  font:inherit;
  font-size:12px;
  border:0;
  border-radius:8px;
  height:28px;
  padding:0 4px;
  background:rgba(255,255,255,.1);
  color:var(--el-text-color-regular);
  cursor:pointer
}
.poseGrid {
  grid-template-columns:repeat(2,1fr)
}
.poseGrid button:hover,.materialButtons button:hover {
  border-color:var(--el-color-primary)
}
button:disabled {
  opacity:.4;
  cursor:default
}

.jointRow {
  display:flex;
  gap:12px;
  align-items:center;
  padding:0 8px;
  font-size:11px
}
.jointRow .el-slider {
  flex:1
}
button:focus-visible {
  outline:2px solid var(--el-color-primary)
}
.objectProperties > .propertyTitle { position: sticky; top: 0; z-index: 1; background: var(--el-bg-color); padding: 4px 0; }
.inspectorTabs { display: flex; gap: 4px; }
.inspectorTabs button { font: inherit; font-size: 12px; color: var(--el-text-color-secondary); background: transparent; border: 0; border-radius: 5px; padding: 5px 8px; cursor: pointer; }
.inspectorTabs button.active { color: var(--el-text-color-primary); background: var(--el-fill-color); }
</style>

<style scoped>
.jointSelect { width:100%; height:28px; padding:0 8px; border:0; border-radius:8px; background:rgba(255,255,255,.1); color:var(--el-text-color-primary); color-scheme:dark; font:inherit; font-size:12px; }
.objectProperties .jointRow { display:grid; grid-template-columns:42px minmax(0,1fr) 72px; gap:8px; align-items:center; }
.jointRow > span { font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.jointRow .el-input-number { width:72px; min-width:0; }
.jointRow .el-slider { min-width:0; }
</style>
