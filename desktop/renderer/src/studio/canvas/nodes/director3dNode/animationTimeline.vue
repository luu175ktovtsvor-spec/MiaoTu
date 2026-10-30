<template>
<section class="animationTimeline" :aria-label="translate('动画关键帧')">
  <header class="timelineHeader">
    <slot name="lead"/>
    <span class="barDivider" aria-hidden="true"/>
    <button type="button" class="barIcon" :disabled="disabled||busy" :aria-label="translate('新建动画方案')" :title="translate('新建动画方案')" @click="create"><icon-plus :size="15"/></button>
    <template v-if="plan"><el-input v-model="planName" class="planName" size="small" :aria-label="translate('动画方案名称')" :maxlength="80" :disabled="disabled||busy" @change="rename"/><button type="button" class="barIcon" :disabled="disabled||busy" :aria-label="translate('复制当前方案')" :title="translate('复制当前方案')" @click="manage('copy')"><icon-copy :size="14"/></button><button type="button" class="barIcon" :disabled="disabled||busy" :aria-label="translate('删除当前方案')" :title="translate('删除当前方案')" @click="manage('remove')"><icon-trash :size="14"/></button><label class="durationField">{{ translate('总时长') }}<el-input-number v-number-a11y :modelValue="plan.duration" size="small" :min=".2" :max="300" :step=".1" :precision="2" :controls="false" :disabled="disabled||busy" :aria-label="translate('动画总时长')" @change="duration"/>s</label><button type="button" class="recordToggle" :class="{active:recording}" :aria-pressed="recording" :disabled="disabled||busy||!canRecord&&!recording" :aria-label="translate(recordKind==='camera'?'镜头录帧模式':'角色录帧模式')" :title="translate(recordKind==='camera'?'开启后，机位调整会记录到当前播放头':'开启后，舞台变换与关节调整会记录到当前播放头')" @click="recording=!recording"><i aria-hidden="true"/>{{ translate(recordKind==='camera'?'镜头录帧':'角色录帧') }}</button></template>
    <span class="barSpacer"/>
    <div v-if="plan" class="timelineViewTools" :aria-label="translate('时间轴视图')">
      <input type="range" :value="zoom" :title="Math.round(zoom*100)+'%'" :aria-valuetext="Math.round(zoom*100)+'%'" min="1" max="8" step=".25" :disabled="!!drag" :aria-label="translate('时间轴缩放')" @input="setZoom(Number(($event.target as HTMLInputElement).value))"/>
      <button type="button" :disabled="!!drag" :aria-label="translate('适配全部关键帧')" :title="translate('适配全部关键帧')" @click="fitTimeline"><icon-maximize :size="13"/></button>
      <button type="button" :aria-label="translate('定位播放头')" :title="translate('定位播放头')" @click="revealTime(time,true)"><icon-focus-2 :size="13"/></button>
      <button type="button" :class="{active:followPlayhead}" :aria-pressed="followPlayhead" :aria-label="translate('跟随播放头')" :title="translate('跟随播放头')" @click="followPlayhead=!followPlayhead"><icon-arrow-right :size="13"/></button>
    </div>
    <slot name="trail"/>
  </header>
  <template v-if="plan">
    <div ref="trackViewport" class="timelineTracks" :style="{'scroll-padding-left':(metrics.labelWidth+10)+'px'}" :aria-label="translate('时间轴轨道视图')" @scroll="rememberScroll" @wheel="zoomWheel">
    <div class="timelineSurface" :style="{width:metrics.surfaceWidth+'px','--trackLabelWidth':metrics.labelWidth+'px'}">
      <div class="rulerRow"><span class="rulerLabel"><el-popover trigger="click" placement="top-start" :width="248" :persistent="false" :showArrow="false" popper-class="directorTrackPopover"><template #reference><button type="button" class="addTrack" :disabled="disabled||busy"><icon-plus :size="12"/>{{ translate('添加动作轨道') }}</button></template><div class="trackTools"><select v-model="objectId" :disabled="disabled||busy" :aria-label="translate('轨道物体')"><option value="" disabled>{{ translate('选择物体') }}</option><option v-for="object in scene.objectList" :key="object.threeJsonId" :value="object.threeJsonId">{{ object.name||translate('物体') }}</option></select><select v-model="joint" :disabled="disabled||busy" :aria-label="translate('轨道关节')"><option value="">{{ translate('整体变换') }}</option><template v-if="object?.objType==='mannequin'"><option v-for="name in mannequinJoints" :key="name" :value="name">{{ translate(jointLabels[name]!) }}</option></template></select><el-button size="small" type="primary" :disabled="disabled||busy||!object" @click="addTrack">{{ translate('添加动作轨道') }}</el-button></div></el-popover></span><div class="ruler" role="slider" tabindex="0" :aria-label="translate('时间刻度定位')" :aria-valuemin="0" :aria-valuemax="plan.duration" :aria-valuenow="time" @pointerdown.self="scrub($event)" @keydown.left.prevent="emit('seek',Math.max(0,time-.1))" @keydown.right.prevent="emit('seek',Math.min(plan.duration,time+.1))" @keydown.home.prevent="emit('seek',0)" @keydown.end.prevent="emit('seek',plan.duration)"><span v-for="tick in rulerTicks" :key="tick" :style="{left:(tick/plan.duration*100)+'%'}">{{ number(tick) }}s</span></div></div>
      <div v-for="row in rows" :key="row.key" class="timelineRow" :class="{selected:selected?.key===row.key}">
        <div class="trackLabel"><button :title="row.label" @click="choose(row,0)">{{ row.label }}</button><button v-if="row.target.kind==='object'" class="removeTrack" :disabled="disabled||busy" :aria-label="translate('移除动作轨道 {0}',{0:row.label})" @click="removeTrack(row)"><icon-trash :size="12"/></button></div>
        <div class="laneWrap"><div class="timelineLane" :title="translate('拖动菱形改时，双击轨道添加关键帧')" @pointerdown.self="scrub($event)" @dblclick.self="insert(row,pointerTime($event))"><i class="playhead" :style="{left:(time/plan.duration*100)+'%'}"/>
          <button v-for="(frame,index) in row.frames" :key="index" class="keyframe" :class="{active:selected?.key===row.key&&Math.abs(selected.time-frame.time)<1e-6,locked:index===0}" :style="{left:((drag?.key===row.key&&drag.index===index?drag.time:frame.time)/plan.duration*100)+'%'}" :disabled="disabled||busy" :aria-label="translate('{0} 第 {1} 帧，{2} 秒',{0:row.label,1:index+1,2:number(frame.time)})" @keydown.enter.prevent="choose(row,index)" @keydown.space.prevent="choose(row,index)" @pointerdown="startDrag($event,row,index)" @pointermove="moveDrag($event)" @pointerup="endDrag($event)" @pointercancel="drag=undefined" @keydown.delete.prevent.stop="deleteKey(row,index)" @keydown.left.prevent="nudge(row,index,-.1)" @keydown.right.prevent="nudge(row,index,.1)"><span/></button>
        </div></div>
      </div>
    </div></div>
    <div v-if="chosen" class="frameEditor">
      <header><strong>{{ chosen.row.label }}</strong><label>{{ translate('关键帧时间') }}<el-input-number v-number-a11y :modelValue="chosen.frame.time" size="small" :min="0" :max="plan.duration" :step=".1" :precision="2" :controls="false" :disabled="disabled||busy||chosen.index===0" :aria-label="translate('关键帧时间')" @change="moveTime"/>s</label><el-button size="small" :disabled="disabled||busy" @click="insert(chosen.row,time)">{{ translate('在播放头添加帧') }}</el-button><el-button size="small" :disabled="disabled||busy||chosen.index===0||chosen.row.frames.length<=(chosen.row.target.kind==='camera'?1:2)" @click="removeFrame">{{ translate('删除关键帧') }}</el-button><template v-if="chosen.row.target.kind==='camera'"><label>{{ translate('过渡') }}<select v-model="draft.easing" :disabled="disabled||busy" :aria-label="translate('关键帧过渡')" @change="updateFrame"><option value="smooth">{{ translate('平滑') }}</option><option value="linear">{{ translate('匀速') }}</option><option value="cut">{{ translate('切镜') }}</option></select></label><el-button size="small" :disabled="disabled||busy" @click="choose(chosen.row,chosen.index)">{{ translate('编辑镜头属性') }}</el-button></template></header>
      <div v-if="chosen.row.target.kind!=='camera'" class="frameVectors">
        <label v-for="field in visibleFields" :key="field.key">{{ translate(field.label) }}<small v-if="field.key==='rotation'">°</small><div class="vectorInputs"><el-input-number v-for="axis in axes" :key="axis" v-number-a11y v-model="draft[field.key][axis]" :controls="false" :precision="2" :step="field.key==='rotation'?5:.1" :min="field.key==='scale'?.01:-10000" :max="10000" size="small" :disabled="disabled||busy" :aria-label="`${translate(field.label)} ${axis.toUpperCase()}`" @change="updateFrame"><template #prefix>{{ axis.toUpperCase() }}</template></el-input-number></div></label>

      </div>
    </div>
  </template>
  <p v-else class="timelineEmpty">{{ translate('新建动画方案后，可为角色与镜头添加关键帧') }}</p>
</section>
</template>
<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { ElButton, ElInput, ElInputNumber, ElPopover } from 'element-plus';
import { IconTrash, IconCopy, IconPlus, IconMaximize, IconFocus2, IconArrowRight } from '@tabler/icons-vue';
import { translate } from '@miaoimg/i18n/vue';
import { mannequinJoints } from './mannequin';
import { jointLabels } from './stageLibrary';
import { timelineKey, type TimelineTarget, type TimelineOperation, type TimelineRequest } from './timeline';
import type { DirectorPlan } from './sceneAnimation';
import type { SceneDocument } from './scene';
import { vNumberA11y } from './numberInputA11y';
import {clampTimelineZoom,timelineViewportMetrics,timelinePointerTime,timelineAnchorScroll,timelineRulerTicks} from './timelineViewport';
const props=defineProps<{planId:string;managePlan:(request:import('./planManagement').PlanManagementRequest)=>Promise<boolean>;plan?:DirectorPlan;scene:SceneDocument;time:number;selectedObjectId:string;playing?:boolean;recordKind?:'actor'|'camera';canRecord:boolean;disabled:boolean;apply:(request:TimelineRequest)=>Promise<boolean>}>();
const recording=defineModel<boolean>('recording',{default:false});
const emit=defineEmits<{seek:[time:number];selectFrame:[selection:{target:TimelineTarget;index:number;time:number}]}>();
const busy=ref(false),planName=ref(''),objectId=ref(''),joint=ref(''),selected=ref<{key:string;time:number}>(),drag=ref<{key:string;index:number;time:number;start:number;lane:HTMLElement;target:TimelineTarget}>();
const axes=['x','y','z'] as const,number=(n:number)=>Number(n.toFixed(2)).toString();
const trackViewport=ref<HTMLElement>(),viewportWidth=ref(400),zoom=ref(1),scrollLeft=ref(0),followPlayhead=ref(true);
const metrics=computed(()=>timelineViewportMetrics(viewportWidth.value,zoom.value)),rulerTicks=computed(()=>timelineRulerTicks(props.plan?.duration??1,metrics.value.laneWidth));
let layoutVersion=0;
function rememberScroll(){if(trackViewport.value?.clientWidth)scrollLeft.value=trackViewport.value.scrollLeft;}
function scrollTo(value:number){const view=trackViewport.value;if(!view||!view.clientWidth)return;view.scrollLeft=Math.max(0,Math.min(metrics.value.maxScroll,value));scrollLeft.value=view.scrollLeft;}
function zoomAnchor(){const m=metrics.value,offset=props.time/(props.plan?.duration??1)*m.laneWidth-scrollLeft.value;return offset>=0&&offset<=m.visibleLaneWidth?{time:props.time,offset}:{time:(scrollLeft.value+m.visibleLaneWidth/2)/m.laneWidth*(props.plan?.duration??1),offset:m.visibleLaneWidth/2};}
async function setZoom(value:number,anchor=zoomAnchor()){
 if(drag.value)return;const next=clampTimelineZoom(value);if(next===zoom.value)return;const version=++layoutVersion;zoom.value=next;await nextTick();if(version===layoutVersion)scrollTo(timelineAnchorScroll(anchor.time,props.plan?.duration??1,metrics.value.laneWidth,metrics.value.visibleLaneWidth,anchor.offset));
}
async function fitTimeline(){const version=++layoutVersion;zoom.value=1;scrollLeft.value=0;await nextTick();if(version===layoutVersion)scrollTo(0);}
function revealTime(time:number,center=false){const m=metrics.value,point=time/(props.plan?.duration??1)*m.laneWidth;if(center)scrollTo(timelineAnchorScroll(time,props.plan?.duration??1,m.laneWidth,m.visibleLaneWidth));else if(point<scrollLeft.value+12||point>scrollLeft.value+m.visibleLaneWidth-12)scrollTo(timelineAnchorScroll(time,props.plan?.duration??1,m.laneWidth,m.visibleLaneWidth,point<scrollLeft.value?20:m.visibleLaneWidth-20));}
function zoomWheel(event:WheelEvent){if(!(event.ctrlKey||event.metaKey)||!event.deltaY)return;event.preventDefault();event.stopPropagation();if(drag.value)return;const view=trackViewport.value;if(!view)return;const m=metrics.value,offset=Math.max(0,Math.min(m.visibleLaneWidth,event.clientX-view.getBoundingClientRect().left-m.labelWidth-10));void setZoom(zoom.value+(event.deltaY<0?.5:-.5),{time:(scrollLeft.value+offset)/m.laneWidth*(props.plan?.duration??1),offset});}
watch(trackViewport,(view,_previous,cleanup)=>{if(!view)return;const resize=new ResizeObserver(async()=>{const width=view.clientWidth;if(!width)return;if(Math.abs(width-viewportWidth.value)<1){scrollTo(scrollLeft.value);return;}const old=metrics.value,time=(scrollLeft.value+old.visibleLaneWidth/2)/old.laneWidth*(props.plan?.duration??1),version=++layoutVersion;viewportWidth.value=width;await nextTick();if(version===layoutVersion)scrollTo(timelineAnchorScroll(time,props.plan?.duration??1,metrics.value.laneWidth,metrics.value.visibleLaneWidth));});resize.observe(view);cleanup(()=>resize.disconnect());},{flush:'post'});
watch(()=>props.planId,()=>{layoutVersion++;zoom.value=1;scrollLeft.value=0;selected.value=undefined;drag.value=undefined;void nextTick(()=>scrollTo(0));});
watch(()=>props.time,time=>{if(props.playing&&followPlayhead.value)revealTime(time);},{flush:'post'});

watch(()=>props.plan?.name,v=>planName.value=v??'',{immediate:true});watch(()=>props.selectedObjectId,id=>{objectId.value=props.scene.objectList.some(o=>o.threeJsonId===id)?id:'';},{immediate:true});
const object=computed(()=>props.scene.objectList.find(o=>o.threeJsonId===objectId.value));watch(object,()=>joint.value='');
type Row={key:string;target:TimelineTarget;label:string;frames:{time:number}[]};
const rows=computed<Row[]>(()=>props.plan?[{key:'camera',target:{kind:'camera'},label:translate('镜头'),frames:props.plan.cameraFrames},...props.plan.tracks.map(t=>{const o=props.scene.objectList.find(o=>o.threeJsonId===t.objectId);const target:TimelineTarget={kind:'object',objectId:t.objectId,joint:t.joint};return{key:timelineKey(target),target,label:`${o?.name||translate('物体')} · ${t.joint?translate(jointLabels[t.joint]!):translate('整体变换')}`,frames:t.frames};})]:[]);
const chosen=computed(()=>{const row=rows.value.find(r=>r.key===selected.value?.key),index=row?.frames.findIndex(f=>Math.abs(f.time-(selected.value?.time??-1))<1e-6)??-1;return row&&index>=0?{row,index,frame:row.frames[index]!}:undefined;});
const draft=ref({position:{x:0,y:0,z:0},rotation:{x:0,y:0,z:0},scale:{x:1,y:1,z:1},easing:'smooth' as 'smooth'|'linear'|'cut'});
watch(chosen,value=>{if(!value||!props.plan)return;const t=value.row.target;if(t.kind==='camera'){const f=props.plan.cameraFrames[value.index]!;draft.value={...draft.value,easing:f.easing};}else{const track=props.plan.tracks.find(t0=>t0.objectId===t.objectId&&t0.joint===t.joint)!,frame=track.frames[value.index]!,base=props.scene.objectList.find(o=>o.threeJsonId===t.objectId)!;draft.value={...draft.value,position:{...(frame.position??base.position)},rotation:{x:frame.rotation.x*180/Math.PI,y:frame.rotation.y*180/Math.PI,z:frame.rotation.z*180/Math.PI},scale:{...(frame.scale??{x:base.scale?.scaleX??1,y:base.scale?.scaleY??1,z:base.scale?.scaleZ??1})}};}},{immediate:true});
const visibleFields=computed(()=>{if(chosen.value?.row.target.kind==='camera')return[];return chosen.value?.row.target.joint?[{key:'rotation' as const,label:'关键帧旋转'}]:[{key:'position' as const,label:'关键帧位置'},{key:'rotation' as const,label:'关键帧旋转'},{key:'scale' as const,label:'关键帧缩放'}];});
async function apply(operations:TimelineOperation[],time?:number){if(busy.value||props.disabled)return false;busy.value=true;try{const ok=await props.apply({action:'edit',operations});if(ok){await nextTick();if(time!==undefined)emit('seek',time);}return ok;}finally{busy.value=false;}}
async function manage(action:'copy'|'remove'){if(busy.value||props.disabled||!props.planId)return;busy.value=true;try{if(await props.managePlan({action,planId:props.planId}))selected.value=undefined;}finally{busy.value=false;}}
async function create(){if(busy.value)return;busy.value=true;try{if(await props.apply({action:'create'})){selected.value=undefined;await nextTick();emit('seek',0);}}finally{busy.value=false;}}
function rename(){if(planName.value.trim())void apply([{action:'rename',name:planName.value.trim()}]);else planName.value=props.plan?.name??'';}
async function duration(value:number|undefined){if(typeof value!=='number'||!props.plan)return;const ratio=value/props.plan.duration,selection=selected.value;if(await apply([{action:'duration',duration:value,rescale:true}],props.time*ratio)&&selection)selected.value={...selection,time:Math.round(selection.time*ratio*1e9)/1e9};}
async function addTrack(){if(!object.value)return;const target:TimelineTarget={kind:'object',objectId:object.value.threeJsonId,...(joint.value?{joint:joint.value as typeof mannequinJoints[number]}:{})};if(await apply([{action:'addTrack',objectId:target.objectId!,joint:target.joint}],0))selected.value={key:timelineKey(target),time:0};}
function choose(row:Row,index:number){if(props.disabled||busy.value)return;selected.value={key:row.key,time:row.frames[index]!.time};emit('seek',row.frames[index]!.time);emit('selectFrame',{target:{...row.target},index,time:row.frames[index]!.time});revealTime(row.frames[index]!.time);}
async function insert(row:Row,time:number){if(await apply([{action:'insert',target:row.target,time}],time)){selected.value={key:row.key,time};if(row.target.kind==='camera')emit('selectFrame',{target:{...row.target},index:props.plan!.cameraFrames.findIndex(f=>Math.abs(f.time-time)<1e-6),time});}}
async function moveTime(value:number|undefined){const frame=chosen.value;if(!frame||typeof value!=='number')return;if(await apply([{action:'move',target:frame.row.target,index:frame.index,time:value}],value))selected.value={key:frame.row.key,time:value};}
async function removeFrame(){const frame=chosen.value;if(frame&&await apply([{action:'remove',target:frame.row.target,index:frame.index}]))selected.value=undefined;}
async function removeTrack(row:Row){if(await apply([{action:'removeTrack',objectId:row.target.objectId!,joint:row.target.joint}]))selected.value=undefined;}
async function updateFrame(){const value=chosen.value;if(!value||!props.plan)return;const target=value.row.target;if(visibleFields.value.some(field=>axes.some(axis=>!Number.isFinite(draft.value[field.key][axis]))))return;if(target.kind==='camera'){await apply([{action:'update',target,index:value.index,easing:draft.value.easing}],value.frame.time);}else{const rotation=Object.fromEntries(axes.map(k=>[k,draft.value.rotation[k]*Math.PI/180])) as {x:number;y:number;z:number};await apply([{action:'update',target,index:value.index,rotation,...(!target.joint?{position:{...draft.value.position},scale:{...draft.value.scale}}:{})}],value.frame.time);}}
function pointerTime(event:PointerEvent|MouseEvent){const rect=(event.currentTarget as HTMLElement).getBoundingClientRect();return timelinePointerTime(event.clientX,rect.left,rect.width,props.plan!.duration);}
function scrub(event:PointerEvent){emit('seek',pointerTime(event));}
function startDrag(event:PointerEvent,row:Row,index:number){choose(row,index);if(index===0)return;const button=event.currentTarget as HTMLElement;button.setPointerCapture(event.pointerId);drag.value={key:row.key,index,time:row.frames[index]!.time,start:row.frames[index]!.time,lane:button.parentElement!,target:row.target};}
function moveDrag(event:PointerEvent){const d=drag.value;if(d){const rect=d.lane.getBoundingClientRect();d.time=timelinePointerTime(event.clientX,rect.left,rect.width,props.plan!.duration);}}
async function endDrag(event:PointerEvent){const d=drag.value;drag.value=undefined;if(!d)return;(event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);if(Math.abs(d.time-d.start)<.005)return;if(await apply([{action:'move',target:d.target,index:d.index,time:d.time}],d.time))selected.value={key:d.key,time:d.time};}
async function deleteKey(row:Row,index:number){choose(row,index);if(index>0&&row.frames.length>(row.target.kind==='camera'?1:2))await removeFrame();}
function nudge(row:Row,index:number,step:number){choose(row,index);if(index>0)void moveTime(Math.round((row.frames[index]!.time+step)*100)/100);}
function getViewContext(){const m=metrics.value,plan=props.plan,frame=chosen.value;if(!plan)return null;return{zoom:zoom.value,followPlayhead:followPlayhead.value,visibleTimeRange:{start:Math.max(0,scrollLeft.value/m.laneWidth*plan.duration),end:Math.min(plan.duration,(scrollLeft.value+m.visibleLaneWidth)/m.laneWidth*plan.duration)},selectedFrame:frame?{target:{...frame.row.target},index:frame.index,time:frame.frame.time,label:frame.row.label}:null};}
defineExpose({getViewContext});
</script>
<style scoped>
.animationTimeline{min-width:0;font-size:12px}
.timelineHeader,.frameEditor>header{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.timelineHeader{min-height:40px;padding:6px 0}
.timelineHeader .planName{width:132px}
.barDivider{width:1px;height:16px;margin:0 4px;background:rgba(255,255,255,.1);flex-shrink:0}
.barSpacer{flex:1}
.barIcon{width:28px;height:28px;display:grid;place-items:center;flex-shrink:0;border:0;border-radius:8px;background:transparent;color:var(--el-text-color-secondary);cursor:pointer}
.barIcon:hover:not(:disabled){background:rgba(255,255,255,.08);color:var(--el-text-color-primary)}
.barIcon:disabled{opacity:.35;cursor:default}
.durationField,.frameEditor header label{display:flex;gap:6px;align-items:center;color:var(--el-text-color-secondary);white-space:nowrap}
.timelineHeader .el-input-number,.frameEditor header .el-input-number{width:60px}
.recordToggle{display:flex;align-items:center;gap:6px;height:28px;padding:0 10px;border:0;border-radius:8px;background:rgba(255,255,255,.1);color:var(--el-text-color-primary);font:inherit;font-size:12px;white-space:nowrap;cursor:pointer}
.recordToggle i{width:8px;height:8px;border-radius:50%;background:#8a8a90}
.recordToggle.active{background:#f2f2f3;color:#151515}
.recordToggle.active i{background:#151515}
.recordToggle:disabled{opacity:.4;cursor:default}
.trackTools{display:flex;flex-direction:column;gap:8px}
select{width:100%;min-width:0;height:28px;padding:0 8px;border:0;border-radius:8px;background:rgba(255,255,255,.1);color:var(--el-text-color-primary);font:inherit;font-size:12px;color-scheme:dark}
.timelineTracks{max-height:190px;overflow:auto;scrollbar-gutter:stable;border-top:1px solid rgba(255,255,255,.06)}
.rulerRow,.timelineRow{display:grid;grid-template-columns:minmax(76px,120px) minmax(120px,1fr);min-height:30px;align-items:center}
.rulerRow{height:28px;color:var(--el-text-color-secondary);font-size:10px}
.ruler,.timelineLane{position:relative;margin:0 10px;min-height:26px}
.ruler span{position:absolute;transform:translateX(-50%);top:5px}
.addTrack{display:flex;align-items:center;gap:4px;height:24px;padding:0 6px;border:0;border-radius:6px;background:transparent;color:var(--el-text-color-secondary);font:inherit;font-size:11px;white-space:nowrap;cursor:pointer}
.addTrack:hover:not(:disabled){background:rgba(255,255,255,.08);color:var(--el-text-color-primary)}
.trackLabel{min-width:0;display:flex;align-items:center}
.trackLabel>button:first-child{flex:1;min-width:0;text-overflow:ellipsis;overflow:hidden;white-space:nowrap;text-align:left;padding:0 8px}
.trackLabel button{height:28px;background:transparent;border:0;color:var(--el-text-color-regular);cursor:pointer;font:inherit;font-size:12px}
.removeTrack{opacity:0;width:24px}
.timelineRow:hover .removeTrack,.timelineRow:focus-within .removeTrack{opacity:1}
.timelineRow{border-top:1px solid rgba(255,255,255,.04)}
.timelineRow.selected{background:rgba(255,255,255,.05)}
.timelineLane{background:linear-gradient(transparent 13px,rgba(255,255,255,.08) 13px,rgba(255,255,255,.08) 14px,transparent 14px);cursor:crosshair;touch-action:none}
.keyframe{position:absolute;top:2px;transform:translateX(-50%);width:20px;height:22px;padding:0;border:0;background:transparent;cursor:ew-resize;touch-action:none}
.keyframe span{display:block;width:8px;height:8px;transform:rotate(45deg);background:#8d8d93;margin:auto;border-radius:1px}
.keyframe:hover span{background:#c4c4c8}
.keyframe.active span{background:#fff;box-shadow:0 0 0 2px rgba(255,255,255,.2)}
.keyframe.locked{cursor:pointer}
.keyframe:focus-visible{outline:1px solid #fff;border-radius:4px}
.playhead{position:absolute;top:0;bottom:0;width:1px;background:#fff;pointer-events:none}
.frameEditor{margin-top:8px;padding:8px 10px;border-radius:10px;background:rgba(255,255,255,.04)}
.frameEditor strong{font-size:12px;font-weight:500;margin-right:4px}
.frameVectors{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
.frameVectors>label{flex:1 1 150px;min-width:0;color:var(--el-text-color-secondary);font-size:12px}
.frameVectors small{margin-left:4px}
.vectorInputs{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px;margin-top:4px}
.vectorInputs .el-input-number{width:100%}
.frameEditor header select{width:auto}
.timelineEmpty{font-size:12px;color:var(--el-text-color-secondary);margin:4px 0 0}
.animationTimeline .el-button{margin:0}
</style>

<style scoped>
.timelineViewTools { display:flex; align-items:center; gap:2px; min-width:0; }
.timelineViewTools button { width:26px; height:26px; flex-shrink:0; display:grid; place-items:center; border:0; border-radius:6px; color:var(--el-text-color-secondary); background:transparent; cursor:pointer; }
.timelineViewTools button:hover,.timelineViewTools button.active { background:var(--el-fill-color); color:var(--el-text-color-primary); }
.timelineViewTools button:disabled { opacity:.35; cursor:default; }
.timelineViewTools input { width:72px; height:18px; margin-right:4px; accent-color:#f2f2f3; }
.timelineTracks { overscroll-behavior-x:contain; user-select:none; }
.timelineSurface { min-width:100%; }
.rulerRow,.timelineRow { grid-template-columns:var(--trackLabelWidth,120px) minmax(0,1fr); }
.rulerRow { position:sticky; top:0; z-index:3; background:#18191b; }
.trackLabel,.rulerLabel { position:sticky; left:0; z-index:2; height:100%; background:#18191b; }
.rulerLabel { display:flex; align-items:center; z-index:4; }
.ruler { cursor:crosshair; touch-action:none; }
.ruler span { pointer-events:none; white-space:nowrap; }
.ruler span:first-child { transform:none; }
.ruler span:last-child { transform:translateX(-100%); }
.keyframe { scroll-margin-inline:12px; }
.timelineViewTools button:focus-visible,.ruler:focus-visible { outline:1px solid #fff; outline-offset:-1px; }
.timelineRow.selected .trackLabel { background:#1f2022; }
</style>
