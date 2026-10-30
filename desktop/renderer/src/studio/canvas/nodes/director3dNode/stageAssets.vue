<template>
  <section class="stageAssets" :aria-label="translate('布景库')">
    <div class="librarySection"><span>{{ translate('角色') }}</span><small>{{ translate('关节人偶') }}</small></div>
    <button class="actorCard" :disabled="disabled" @click="emit('addActor')">
      <svg viewBox="0 0 96 72" aria-hidden="true"><g fill="none" stroke="#d8d8dc" stroke-width="7" stroke-linecap="round"><circle cx="48" cy="14" r="7" fill="#d8d8dc" stroke="none"/><path d="M48 28v19M35 30l-6 17m32-17 6 17M48 47 38 65m10-18 10 18"/></g></svg>
      <span>{{ translate('添加人偶') }}<small>{{ translate('可编辑全部关节') }}</small></span><span>+</span>
    </button>
    <div class="librarySection"><span>{{ translate('场景预设') }}</span><small>{{ translate('添加到当前场景') }}</small></div>
    <div class="setGrid"><button v-for="item in setPresets" :key="item.id" :disabled="disabled" @click="addSet(item.id)">
      <div class="setPreview" :style="{ '--setColor': item.color }"><i/><i/><i/><b v-if="item.id === 'interview' || item.id === 'living'"/><em v-if="item.id === 'living'"/></div>
      <span>{{ translate(item.name) }}</span>
    </button></div>
    <div class="librarySection"><span>{{ translate('道具') }}</span><small>{{ translate('点击添加') }}</small></div>
    <div class="propGrid"><button v-for="item in propPresets" :key="item.id" :disabled="disabled" @click="addProp(item.id)">
      <svg viewBox="0 0 64 52" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round">
        <template v-if="item.symbol === 'sphere'"><circle cx="32" cy="26" r="17"/><ellipse cx="32" cy="26" rx="8" ry="17"/><ellipse cx="32" cy="26" rx="17" ry="6"/></template>
        <template v-else-if="item.symbol === 'chair'"><path d="M20 25V9h23v16L20 31l-8-5 23-7m-23 7v17m8-12v14m23-20v17"/></template>
        <template v-else-if="item.symbol === 'table'"><path d="m7 23 30-13 21 12-29 13ZM7 23v17m22-5v13m29-26v18M37 10v11"/></template>
        <template v-else-if="item.symbol === 'door'"><path d="M17 44V9h30v35M23 44V15h18v29"/></template>
        <template v-else-if="item.symbol === 'stairs'"><path d="M9 43V32h14V21h14V10h17v33ZM9 43h45"/></template>
        <template v-else-if="item.symbol === 'sofa'"><path d="M13 27V14h38v13M8 24h9v12h30V24h9v19H8ZM13 43v4m38-4v4"/></template>
        <template v-else-if="item.symbol === 'cylinder'"><ellipse cx="32" cy="12" rx="17" ry="6"/><path d="M15 12v27c0 8 34 8 34 0V12"/></template>
        <template v-else><path :d="item.symbol === 'wall' ? 'M13 44V14l34-8v30ZM13 14l7 3 34-8-7-3M47 36l7 3V9M13 44l7 3 34-8M20 17v30' : 'm10 20 23-10 22 10-23 11ZM10 20v20l22 11 23-11V20M32 31v20'"/></template>
      </svg><span>{{ translate(item.name) }}</span>
    </button></div>
  </section>
</template>
<script setup lang="ts">
import { translate } from '@miaoimg/i18n/vue';
import { propPresets, setPresets, createProp, createSet, localizeStageObjects, type PropId, type SetId } from './stageLibrary';
import type { SceneDocument } from './scene';
defineProps<{ disabled?: boolean }>();
const emit = defineEmits<{ addActor: []; addObjects: [objects: SceneDocument['objectList']] }>();
const localize = localizeStageObjects;
function addSet(id: SetId) { emit('addObjects', localize(createSet(id))); }
function addProp(id: PropId) { emit('addObjects', localize(createProp(id))); }
</script>
<style scoped>
.stageAssets {
  overflow-y:auto;
  min-height:0;
  padding:0 2px 12px
}
.librarySection {
  display:flex;
  justify-content:space-between;
  align-items:center;
  margin:18px 0 10px;
  font-size:12px;
  font-weight:600
}
.librarySection:first-child {
  margin-top:8px
}
small {
  font-size:10px;
  color:var(--el-text-color-secondary);
  font-weight:400
}
button {
  font:inherit;
  color:var(--el-text-color-regular);
  cursor:pointer;
  border:1px solid transparent;
  background:rgba(255,255,255,.05);
  border-radius:8px;
  transition:border-color .15s,background .15s
}
button:hover {
  border-color:var(--el-color-primary);
  background:var(--el-fill-color)
}
button:disabled {
  opacity:.4;
  cursor:default
}
button:focus-visible {
  outline:2px solid var(--el-color-primary)
}
.actorCard {
  width:100%;
  display:flex;
  align-items:center;
  gap:8px;
  text-align:left;
  padding:8px
}
.actorCard svg {
  width:70px;
  height:60px;
  background:radial-gradient(ellipse,#ffffff14,transparent);
  flex-shrink:0
}
.actorCard span:nth-child(2) {
  flex:1
}
.actorCard small {
  display:block;
  margin-top:6px
}
.actorCard>span:last-child {
  font-size:22px;
  color:var(--el-text-color-secondary)
}
.setGrid {
  display:grid;
  grid-template-columns:1fr 1fr;
  gap:8px
}
.setGrid button {
  overflow:hidden;
  padding:0
}
.setGrid button>span {
  display:block;
  padding:8px;
  font-size:12px;
  text-align:left
}
.setPreview {
  height:66px;
  position:relative;
  overflow:hidden;
  background:linear-gradient(160deg,var(--setColor),#20232c);
  perspective:150px
}
.setPreview i:first-child {
  position:absolute;
  left:15%;
  top:12px;
  width:70%;
  height:42px;
  background:#c1c5d144;
  transform:skewY(-8deg)
}
.setPreview i:nth-child(2) {
  position:absolute;
  left:0;
  bottom:-15px;
  width:100%;
  height:42px;
  background:repeating-linear-gradient(90deg,#ffffff10 0 1px,transparent 1px 15px);
  transform:rotateX(55deg)
}
.setPreview i:nth-child(3) {
  position:absolute;
  left:10%;
  top:20px;
  width:10px;
  height:40px;
  background:#c1c5d133;
  transform:skewY(35deg)
}
.setPreview b {
  position:absolute;
  width:50px;
  height:10px;
  left:30px;
  top:38px;
  background:#d8bc9699;
  transform:skewY(-8deg)
}
.setPreview em {
  position:absolute;
  width:48px;
  height:16px;
  left:18px;
  top:29px;
  background:#7fb8acbb;
  transform:skewY(-8deg)
}
.propGrid {
  display:grid;
  grid-template-columns:repeat(3,1fr);
  gap:6px
}
.propGrid button {
  display:flex;
  align-items:center;
  flex-direction:column;
  padding:8px 2px;
  gap:4px;
  font-size:11px
}
.propGrid svg {
  width:54px;
  height:46px;
  color:#a8a8ad
}
</style>
