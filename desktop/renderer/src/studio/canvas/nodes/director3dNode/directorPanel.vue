<template>
  <section class="directorPanel" :class="{ stagedComposer: !!historyTarget, chatOpen: historyVisible }" :aria-label="translate('导演助手')">
    <teleport :to="historyTarget || 'body'" :disabled="!historyTarget">
      <div v-show="historyVisible !== false" class="directorPanel directorHistory">
    <header class="chatHeader"><icon-sparkles :size="16" aria-hidden="true" /><span>{{ translate('导演助手') }}</span></header>
    <div class="modeSwitch" role="radiogroup" :aria-label="translate('操作类型')">
      <button type="button" role="radio" :aria-checked="mode === 'scene'" :class="{ active: mode === 'scene' }" :disabled="initializing" @click="mode = 'scene'">{{ translate('编辑场景') }}</button>
      <button type="button" role="radio" :aria-checked="mode === 'animation'" :class="{ active: mode === 'animation' }" :disabled="initializing" @click="mode = 'animation'">{{ translate('生成动画') }}</button>
    </div>
    <div class="currentPlanControls">
      <div class="planPickerRow">
        <el-select class="planPicker" size="small" popper-class="directorPlanPickerPopper" :title="selectedPlan?names.get(selectedPlan.id):translate('基础场景')" :modelValue="selectedPlanId" :aria-label="translate('当前方案')" :disabled="initializing||planBusy" filterable @update:modelValue="emit('selectPlan',String($event))">
          <el-option :value="''" :label="translate('基础场景')"/>
          <el-option v-for="plan in plans" :key="plan.id" :value="plan.id" :label="names.get(plan.id)??plan.name"/>
        </el-select>
        <el-dropdown v-if="selectedPlan" class="planMenu" trigger="click" placement="bottom-end" :persistent="false" :showArrow="false" popper-class="directorPlanMenu" :disabled="initializing||planBusy" @command="command=>selectedPlan&&planAction(String(command),selectedPlan)"><button type="button" :disabled="initializing||planBusy" :aria-label="translate('方案操作 {0}',{0:names.get(selectedPlan.id)??selectedPlan.name})"><icon-dots :size="16"/></button><template #dropdown><el-dropdown-menu><el-dropdown-item command="rename">{{ translate('重命名方案') }}</el-dropdown-item><el-dropdown-item command="copy">{{ translate('复制方案') }}</el-dropdown-item><el-dropdown-item command="remove" divided>{{ translate('删除方案') }}</el-dropdown-item></el-dropdown-menu></template></el-dropdown>
      </div>
      <form v-if="selectedPlan&&renaming===selectedPlan.id" class="planRenameForm" @submit.prevent="renamePlan(selectedPlan)"><el-input ref="renameInput" v-model="renameName" size="small" :maxlength="80" :disabled="initializing||planBusy" :aria-label="translate('方案名称')" @keydown.esc.prevent="renaming=''"/><button type="submit" :disabled="initializing||planBusy||!renameName.trim()" :aria-label="translate('保存方案名称')"><icon-check :size="15"/></button><button type="button" :disabled="planBusy" :aria-label="translate('取消改名')" @click="renaming=''"><icon-x :size="15"/></button></form>
      <div v-else-if="selectedPlan" class="planInfoRow">
        <details :key="selectedPlan.id" class="currentPlanDetails">
          <summary>{{ translate('方案详情') }}</summary>
          <div class="planDetailsBody"><small>{{ translate('{0} 秒 · {1} 条动作轨道',{0:selectedPlan.duration,1:selectedPlan.tracks.length}) }}</small><p class="planInstruction">{{ selectedPlan.instruction||translate('此旧方案未保存输入提示词') }}</p><messageMarkdown v-if="selectedPlan.summary&&!summaryInHistory" class="planSummaryDetails" :content="selectedPlan.summary" :directory="workspaceDirectory?.()"/></div>
        </details>
        <button v-if="selectedTask" class="planHistoryLink" type="button" @click="focusTask(selectedTask.id)">{{ translate('查看生成记录') }}</button>
      </div>
    </div>
    <div ref="content" class="planContent" role="log" :aria-label="translate('导演操作记录')">
      <div class="itemList taskVirtualList" :style="{height:taskVirtualizer.getTotalSize()+'px'}">
        <template v-for="{row,task} in visibleTasks" :key="task.id">
        <div :ref="measureTask" :data-index="row.index" :data-task-id="task.id" class="planItem taskItem" :class="{linkedTask:focusedTaskId===task.id}" :style="{position:'absolute',top:0,left:0,width:'100%',transform:`translateY(${row.start}px)`}" :aria-busy="isDirectorGenerationPending(task)">
          <icon-loader-2 v-if="isDirectorGenerationPending(task)" class="loadingIcon" :size="18" aria-hidden="true" /><icon-check v-else-if="task.state === 'succeeded'" :size="18" aria-hidden="true" /><icon-player-stop v-else-if="task.state === 'cancelled'" :size="18" aria-hidden="true" /><icon-alert-circle v-else :size="18" aria-hidden="true" />
          <div class="itemContent"><strong class="taskInstruction">{{ task.instruction }}</strong><span v-if="task.error" class="generationError" role="alert">{{ task.error }}</span><span v-else role="status">{{ task.status || translate('后台生成中…') }}</span></div>
          <div class="taskActions">
            <el-button v-if="task.state === 'running'" text :icon="IconPlayerStop" :aria-label="translate('停止当前操作')" @click="emit('cancelTask', task.id)" />
            <template v-else-if="!isDirectorGenerationPending(task)"><el-button v-if="task.state !== 'succeeded'" text :icon="IconArrowBackUp" :aria-label="translate('重新编辑指令')" @click="emit('editInstruction', task.instruction)" /><el-button text :icon="IconX" :aria-label="translate('移除操作记录')" @click="emit('dismissTask', task.id)" /></template>
          </div>
          <p v-if="task.referenceHistory?.length" class="taskReferenceHistory" :aria-label="translate('本轮参考素材')">{{ translate('本轮参考素材') }}：{{ task.referenceHistory.map(item=>`${item.index}. ${item.name||translate(item.kind==='IMAGE'?'图片':item.kind==='VIDEO'?'视频':'文本')}`).join('、') }}</p>
          <directorTrace :traces="task.traces" :running="isDirectorGenerationPending(task)" />
          <messageMarkdown v-if="task.summary" class="taskSummary taskReply" :content="task.summary" :directory="workspaceDirectory?.()"/>
        </div>
        </template>
      </div>
      <p v-if="!tasks.length">{{ mode === 'scene' ? translate('描述场景或角色调整') : translate('描述模型动作和运镜要求') }}</p>
    </div>
    <button v-if="tasks.length&&!atLatestTask" type="button" class="latestTaskButton" @click="taskVirtualizer.scrollToEnd()">{{ translate('回到最新消息') }}</button>
    <p v-if="selectedObjectName" class="selectionContext">{{ translate('当前选择：{0}', { 0: selectedObjectName }) }}</p>
    <p class="instructionHint">{{ mode === 'scene' ? translate('调整当前场景与角色') : referenceCount ? translate('已记录 {0} 个机位，可按需用于运镜', { 0: referenceCount }) : result ? translate('参考：{0}', { 0: names.get(selectedPlanId)??result.name }) : translate('模型动画与运镜同步生成') }}</p>
      </div>
    </teleport>
    <footer class="chatFooter">
      <el-popover @after-leave="finishAddReference" v-model:visible="referencesOpen" trigger="click" role="dialog" :persistent="true" placement="top-start" :width="360" popper-class="directorReferencePopover" :showArrow="false"><template #reference><button type="button" class="attachmentButton" :class="{open:referencesOpen}" @focusin.stop :aria-label="mediaReferenceCount?translate('{0} 项参考素材',{0:mediaReferenceCount}):translate('参考素材')" :aria-expanded="referencesOpen"><icon-paperclip :size="15"/><span v-if="mediaReferenceCount">{{ mediaReferenceCount }}</span></button></template><div class="directorReferenceGallery" :aria-label="translate('参考素材')"><header><strong>{{ translate('参考素材') }}</strong><el-button text size="small" :disabled="initializing||mediaReferenceCount>=8" :title="mediaReferenceCount>=8?translate('每次最多引用 8 项素材'):undefined" @click="addReference">{{ translate('添加引用') }}</el-button></header><p v-if="!mediaReferenceCount" class="referenceEmpty">{{ translate('从画布选择图片、视频或文本作为参考') }}</p><slot name="references"/></div></el-popover>
      <div class="inputContent"><slot name="input" /></div>
      <div class="inputActions">
        <el-select :modelValue="modelAvailable ? model : undefined" @update:modelValue="selectModel" class="modelSelect" popper-class="modelSelectPopper directorModelSelectPopper" size="small" clearable :disabled="initializing" :loading="modelsLoading" filterable :placeholder="translate('选择模型')" :aria-label="translate('生成模型')" @visibleChange="$event && emit('loadModels')">
          <template #prefix><modelIcon :model="nodeModelValueId(model)" :size="16" /></template>
          <el-option-group v-for="provider in modelGroups" :key="provider.id" :label="provider.label"><el-option v-for="item in provider.models" :key="item.modelId" :label="item.label" :value="JSON.stringify([item.providerId, item.modelId])"><span class="modelOptionContent"><modelIcon :model="item.modelId" :size="16" /><span class="modelOptionText">{{ item.label }}</span></span></el-option></el-option-group>
        </el-select>
        <el-button class="sendButton" type="primary" round :disabled="initializing || !prompt.trim() || !modelAvailable" :aria-label="mode === 'scene' ? translate('编辑场景') : translate('生成动画')" @click="sendInstruction"><icon-sparkles :size="14" /><span class="sendLabel">{{ mode === 'scene' ? translate('发送') : translate('生成方案') }}</span></el-button>
      </div>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, inject, nextTick, ref, watch, type ComponentPublicInstance } from 'vue';
import { defaultRangeExtractor, observeElementRect, useVirtualizer } from '@tanstack/vue-virtual';
import { ElButton, ElPopover, ElInput, ElDropdown, ElDropdownMenu, ElDropdownItem, ElOption, ElOptionGroup, ElSelect } from 'element-plus';
import { IconDots, IconPaperclip, IconLoader2, IconSparkles, IconCheck, IconAlertCircle, IconArrowBackUp, IconPlayerStop, IconX } from '@tabler/icons-vue';
import { modelIcon } from '@miaoimg/model-icons';
import { type NodeAiModel } from '@miaoimg/nodes-scaffold/runtime';
import { groupNodeModels } from '../../scaffold/nodeAi';
import { nodeModelValueId } from '../../scaffold/localModelLabel';
import { isDirectorGenerationPending, type DirectorPlan, type DirectorPlanItem, type DirectorGeneration } from './sceneAnimation';
import directorTrace from './directorTrace.vue';
import { messageMarkdown } from '../../components/agent/messageRenderer';
import { planDisplayNames, type PlanManagementRequest } from './planManagement';
import type { DirectorMode } from './agentTools';
import { translate } from '@miaoimg/i18n/vue';
const workspaceDirectory=inject<(()=>string)|undefined>('workspaceDirectory',undefined);
const props = defineProps<{ mediaReferenceCount:number;managePlan:(request:PlanManagementRequest)=>Promise<boolean>;historyTarget?: HTMLElement; historyVisible?: boolean; selectedObjectName?: string; result?: DirectorPlan; referenceCount: number; initializing: boolean; plans: DirectorPlanItem[]; selectedPlanId: string; tasks: DirectorGeneration[]; models: NodeAiModel[]; modelsLoading: boolean }>();
const referencesOpen=ref(false),addingReference=ref(false);
function addReference(){addingReference.value=true;referencesOpen.value=false;}
function finishAddReference(){if(addingReference.value){addingReference.value=false;emit('addReference');}}
watch(()=>props.mediaReferenceCount,count=>{if(!count)referencesOpen.value=false;});
const names=computed(()=>planDisplayNames(props.plans)),renaming=ref(''),renameName=ref(''),planBusy=ref(false),renameInput=ref<InstanceType<typeof ElInput>>();
const selectedPlan=computed(()=>props.plans.find(plan=>plan.id===props.selectedPlanId));
const selectedTask=computed(()=>props.tasks.find(task=>task.id===props.selectedPlanId));
const summaryInHistory=computed(()=>!!selectedPlan.value?.summary&&selectedTask.value?.summary?.trim()===selectedPlan.value.summary.trim());
watch(()=>props.selectedPlanId,()=>{renaming.value='';focusedTaskId.value='';});
async function planAction(command:string,plan:DirectorPlanItem){if(planBusy.value||props.initializing)return;if(command==='rename'){renaming.value=plan.id;renameName.value=plan.name;await nextTick();renameInput.value?.focus();return;}if(command!=='copy'&&command!=='remove')return;planBusy.value=true;try{await props.managePlan({action:command,planId:plan.id});}finally{planBusy.value=false;}}
async function renamePlan(plan:DirectorPlanItem){if(!renameName.value.trim()||planBusy.value)return;planBusy.value=true;try{if(await props.managePlan({action:'rename',planId:plan.id,name:renameName.value.trim()}))renaming.value='';}finally{planBusy.value=false;}}
const emit = defineEmits<{ addReference:[];editInstruction: [value: string]; selectPlan: [id: string]; send: []; loadModels: []; cancelTask: [id: string]; dismissTask: [id: string] }>();
const prompt = defineModel<string>('prompt', { default: '' });
const model = defineModel<string>('model', { default: '' });
const mode = defineModel<DirectorMode>('mode', { default: 'animation' });
const modelGroups = computed(() => groupNodeModels(props.models));
const modelAvailable = computed(() => props.models.some(item => JSON.stringify([item.providerId, item.modelId]) === model.value));
function selectModel(value: unknown) { model.value = typeof value === 'string' ? value : ''; }
const content=ref<HTMLElement>(),atLatestTask=ref(true),focusedTaskId=ref('');
let historyInitialized=false,historyScrollOffset=0;
const taskKeys=computed(()=>props.tasks.map(task=>task.id));
const retainedTasks=computed(()=>props.tasks.flatMap((task,index)=>isDirectorGenerationPending(task)?[index]:[]));
const taskVirtualizer=useVirtualizer<HTMLElement,HTMLDivElement>(computed(()=>({
 count:taskKeys.value.length,getScrollElement:()=>content.value??null,getItemKey:(index:number)=>taskKeys.value[index]!,estimateSize:()=>220,overscan:2,gap:8,paddingEnd:8,
 anchorTo:'end' as const,followOnAppend:true,scrollEndThreshold:48,useAnimationFrameWithResizeObserver:true,useCachedMeasurements:props.historyVisible===false,
 observeElementRect:(instance,onChange)=>observeElementRect(instance,rect=>{if(!rect.height)return;const follow=atLatestTask.value;onChange(rect);if(follow)void nextTick(()=>{if(props.historyVisible!==false&&content.value?.isConnected)instance.scrollToEnd();});}),
 rangeExtractor:range=>[...new Set([...defaultRangeExtractor(range),...retainedTasks.value])].sort((a,b)=>a-b),
 onChange(instance){if(!historyInitialized||props.historyVisible===false||!content.value?.clientHeight)return;atLatestTask.value=instance.isAtEnd();historyScrollOffset=instance.scrollOffset??0;},
})));
const visibleTasks=computed(()=>taskVirtualizer.value.getVirtualItems().map(row=>({row,task:props.tasks[row.index]!})));
function measureTask(element:Element|ComponentPublicInstance|null){taskVirtualizer.value.measureElement(element instanceof HTMLDivElement?element:null);}
watch([()=>props.historyVisible!==false,content],async([active,element])=>{if(!active||!element)return;await nextTick();if(props.historyVisible===false)return;if(!historyInitialized||atLatestTask.value)taskVirtualizer.value.scrollToEnd();else taskVirtualizer.value.scrollToOffset(historyScrollOffset);historyInitialized=true;},{immediate:true,flush:'post'});
function focusTask(id:string){const index=props.tasks.findIndex(task=>task.id===id);if(index<0)return;focusedTaskId.value=id;taskVirtualizer.value.scrollToIndex(index,{align:'start'});}
async function sendInstruction(){if(!props.initializing&&prompt.value.trim()&&modelAvailable.value){emit('send');await nextTick();taskVirtualizer.value.scrollToEnd();}}

</script>

<style scoped lang="scss">
.directorPanel {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  color: var(--el-text-color-primary);

  .chatHeader {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 8px;
    padding: 4px 12px 14px;
    font-size: 14px;
    font-weight: 500;
    small { color: var(--el-text-color-secondary); font-weight: 400; }
  }

  .modeSwitch { display: flex; flex-shrink: 0; gap: 3px; padding: 3px; margin: 0 8px 10px; border-radius: 7px; background: var(--el-fill-color-light); }
  .modeSwitch button { flex: 1; padding: 7px; border: 0; border-radius: 5px; background: transparent; color: var(--el-text-color-secondary); cursor: pointer; font: inherit; font-size: 12px; }
  .modeSwitch button.active { background: var(--el-bg-color-overlay); color: var(--el-text-color-primary); }
  .modeSwitch button:disabled { opacity: .5; cursor: default; }
  .planContent .itemList .planItem.taskItem {
    display: grid;
    grid-template-columns: 18px minmax(0, 1fr) auto;
    align-items: start;
    column-gap: 8px;
    row-gap: 6px;
  }
  .taskActions { display: flex; align-items: center; gap: 2px; }
  .taskActions .el-button { width: 24px; height: 24px; padding: 3px; margin: 0; }
  .taskItem > .directorTrace, .taskReply { grid-column: 2 / -1; min-width: 0; }
  .taskItem > .directorTrace { margin-top: 0; }
  .taskItem > svg { margin-top: 3px; }
  .taskItem .taskSummary { margin: 6px 0 0; font-size: 12px; line-height: 1.6; }
  .taskInstruction { white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
  .taskSummary { white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }

  .planContent {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 8px;
    color: var(--el-text-color-secondary);
    font-size: 13px;
    line-height: 1.7;

    .itemList {
      display: flex; flex-direction: column; gap: 8px;
      .planItem {
        display: flex; flex-shrink: 0; box-sizing: border-box; align-items: center; gap: 10px; width: 100%; padding: 12px;
        border: 0; border-radius: calc(var(--el-border-radius-base) * 2);
        background: transparent; color: var(--el-text-color-regular); text-align: left; font: inherit;
        &:is(button) { cursor: pointer; }
        &:disabled { cursor: default; opacity: .6; }
        &:is(button):hover { background: var(--el-fill-color); }
        &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }
        &.selected { background: var(--el-fill-color); color: var(--el-text-color-primary); }
        > svg { flex-shrink: 0; }
        .itemContent { flex: 1; min-width: 0; overflow-wrap: anywhere;
          strong { display: block; font-size: 13px; font-weight: 500; overflow-wrap: anywhere; }
          span { display: block; margin-top: 3px; color: var(--el-text-color-secondary); font-size: 11px; }
          .planInstruction { margin: 4px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; user-select: text; }
          .generationError { color: var(--el-color-danger); overflow-wrap: anywhere; }
        }
      }
    }
    h3 { margin: 8px 0; color: var(--el-text-color-primary); font-size: 16px; font-weight: 500; overflow-wrap: anywhere; }
    p { margin: 16px 0; }
    .loadingIcon { animation: directorLoading 1.2s linear infinite; }
  }

  .selectionContext { flex-shrink: 0; max-height: 72px; overflow-y: auto; overflow-wrap: anywhere; margin: 8px 12px 0; padding: 7px 9px; border: 1px solid var(--el-border-color-lighter); border-radius: 6px; color: var(--el-text-color-regular); font-size: 11px; }

  .instructionHint { flex-shrink: 0; margin: 12px; font-size: 11px; line-height: 1.5; color: var(--el-text-color-secondary); overflow-wrap: anywhere; }

  .chatFooter {
    flex-shrink: 0;
    margin: 0 8px 4px;
    padding: 4px;
    border: 1px solid var(--el-border-color-light);
    border-radius: calc(var(--ui-radius, 4px) * 2.75);
    background: var(--el-bg-color);

    &:focus-within { border-color: var(--el-color-primary-light-5); }

    .inputContent {
      padding: 8px;
      min-width: 0;
      :deep(.referenceList) { margin-bottom: 8px; }
    }

    .inputActions {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      justify-content: space-between;
      gap: 8px;
      padding: 4px;

      .modelSelect {
        flex: 1 1 120px;
        min-width: 100px;
        max-width: 100%;

        :deep(.el-select__wrapper) {
          background: transparent;
          box-shadow: none;
          border-radius: var(--el-border-radius-base);

          &:hover:not(.is-disabled) { background: var(--el-fill-color-light); }
          &.is-focused { box-shadow: 0 0 0 1px var(--el-color-primary-light-5) inset; }
        }

        :deep(.el-select__selected-item) { color: var(--el-text-color-regular); }
      }

      .sendButton {
        flex-shrink: 0;
        padding: 0 12px;
        height: 32px;
        margin: 0 0 0 auto;
      }
    }
  }
}


.currentPlanControls{flex-shrink:0;min-width:0;margin:0 8px 6px}.planPickerRow{display:flex;align-items:center;gap:5px;min-width:0}.planPicker{flex:1;min-width:0}.planPicker :deep(.el-select__wrapper){min-height:28px;border-radius:8px}.planPickerRow>.planMenu{flex-shrink:0}.planMenu>button,.planRenameForm>button{display:grid;place-items:center;width:24px;height:24px;border:0;border-radius:6px;background:transparent;color:var(--el-text-color-secondary);cursor:pointer}.planMenu>button:hover,.planRenameForm>button:hover{background:var(--el-fill-color)}.planRenameForm{display:flex;align-items:center;gap:4px;padding:8px 0;min-width:0}.planRenameForm .el-input{flex:1;min-width:0}.planRenameForm>button{flex-shrink:0}.planInfoRow{display:flex;align-items:flex-start;gap:8px;margin-top:5px}.currentPlanDetails{flex:1;min-width:0;max-height:min(180px,24dvh);overflow-y:auto;font-size:11px;color:var(--el-text-color-secondary)}.currentPlanDetails>summary{cursor:pointer;padding:3px 0}.planDetailsBody{padding:5px 0;overflow-wrap:anywhere}.planDetailsBody>small{font-size:11px}.planDetailsBody .planInstruction{margin:5px 0;white-space:pre-wrap;overflow-wrap:anywhere}.planHistoryLink,.latestTaskButton{border:0;background:transparent;color:var(--el-text-color-secondary);font:inherit;font-size:11px;cursor:pointer;padding:3px 0}.planHistoryLink{flex-shrink:0}.planHistoryLink:hover,.latestTaskButton:hover{color:var(--el-color-primary)}.latestTaskButton{align-self:center;flex-shrink:0;margin:2px 8px;padding:4px 9px;border-radius:8px;background:var(--el-fill-color)}.currentPlanControls :focus-visible,.latestTaskButton:focus-visible{outline:1px solid var(--el-color-primary);outline-offset:1px}.directorPanel .planContent .taskVirtualList{display:block;position:relative}.taskItem.linkedTask{box-shadow:inset 2px 0 var(--el-color-primary);border-radius:8px}.directorPanel .planContent>p{margin:8px 4px}
.directorPanel.stagedComposer { height:auto; width:100%; }
.directorPanel.stagedComposer .chatFooter { display:flex; align-items:center; flex-wrap:wrap; gap:4px; margin:0; padding:6px; border-radius:22px; background:color-mix(in srgb,var(--el-bg-color-overlay) 94%,transparent); }
.directorPanel.stagedComposer .inputContent { flex:1 1 160px; padding:2px 5px; }
.directorPanel.stagedComposer .inputContent :deep(.promptInputWrap) { margin:0; }
.directorPanel.stagedComposer .inputActions { flex:0 1 auto; padding:0; gap:4px; }
.directorPanel.stagedComposer .modelSelect { width:160px; min-width:120px; max-width:180px; }
.directorPanel.stagedComposer:not(.chatOpen) .modelSelect { display:none; }
.directorPanel.stagedComposer .sendButton { width:32px; padding:0; }
.directorPanel.stagedComposer .sendLabel { display:none; }
.directorHistory .chatHeader { display:none; }
@keyframes directorLoading { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .directorPanel .planContent .loadingIcon { animation: none; }
}
</style>

<style scoped>
.attachmentButton { display:flex; flex-shrink:0; align-items:center; justify-content:center; gap:3px; min-width:34px; height:28px; padding:0 4px; border:0; border-radius:8px; background:transparent; color:var(--el-text-color-secondary); cursor:pointer; font-size:11px; }
.attachmentButton:hover,.attachmentButton.open { color:var(--el-text-color-primary); background:var(--el-fill-color); }
.attachmentButton:focus-visible { outline:1px solid var(--el-color-primary); }
.taskReferenceHistory { grid-column:2/-1; margin:2px 0 0!important; font-size:11px; line-height:1.6; color:var(--el-text-color-secondary); white-space:pre-wrap; overflow-wrap:anywhere; user-select:text; }
.directorReferenceGallery { max-height:min(280px,calc(100dvh - 80px)); overflow-y:auto; }
.directorReferenceGallery > header { display:flex; align-items:center; justify-content:space-between; gap:8px; margin:0 0 8px; }
.directorReferenceGallery strong { font-size:12px; font-weight:500; }
.referenceEmpty { margin:4px 0; color:var(--el-text-color-secondary); font-size:12px; line-height:1.6; }
.directorReferenceGallery :deep(.referenceList) { flex-wrap:wrap; overflow:visible; min-height:0; gap:8px; padding:2px; }
</style>

<style scoped>
.taskItem > .taskReply { white-space:normal; min-width:0; }
.taskReply :deep(p) { margin:6px 0; overflow-wrap:anywhere; }
.taskReply :deep(ul),.taskReply :deep(ol) { margin:6px 0; padding-left:18px; }
.taskReply :deep(pre),.taskReply :deep(table) { max-width:100%; overflow-x:auto; }
</style>

<style scoped>
.planSummaryDetails { min-width:0; padding:0; color:var(--el-text-color-regular); font-size:12px; line-height:1.6; }
.planSummaryDetails :deep(p) { margin:6px 0; overflow-wrap:anywhere; }
.planSummaryDetails :deep(ul),.planSummaryDetails :deep(ol) { padding-left:18px; }
</style>
