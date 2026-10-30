<template>
  <section class="cameraInspector" :aria-label="translate('机位属性')">
    <p v-if="recording" class="cameraRecordHint">{{ translate('镜头录帧中：参数写入当前时间，基础机位保持不变') }}</p>
    <p v-if="recordError" class="cameraRecordError" role="alert">{{ recordError }}</p>
    <div class="cameraActions"><el-button size="small" :disabled="disabled" @click="emit('lookThrough')"><icon-camera :size="14"/>{{ translate('查看取景') }}</el-button><el-button size="small" :disabled="disabled" :aria-label="translate('聚焦机位')" @click="emit('focus')"><icon-focus-2 :size="14"/></el-button><el-button size="small" :disabled="disabled||recording" :aria-label="translate('复制机位')" @click="emit('copy')"><icon-copy :size="14"/></el-button><el-button size="small" :disabled="disabled||recording" :aria-label="translate('删除机位')" @click="emit('remove')"><icon-trash :size="14"/></el-button></div>
    <div v-if="preview" class="cameraPreview"><img :src="preview" :alt="translate('机位预览')"/><span>FOV {{ anchor.camera.fov.toFixed(1) }}°</span></div>
    <label>{{ translate('名称') }}</label><el-input v-model="draft.name" size="small" :disabled="disabled||recording" :maxlength="100" :aria-label="translate('机位名称')" @change="commit('name')" />
    <template v-for="field in fields" :key="field.key"><label>{{ translate(field.label) }}</label><div class="cameraVector"><el-input-number v-for="axis in axes" :key="axis" v-number-a11y v-model="draft[field.key][axis]" :controls="false" size="small" :step=".1" :precision="2" :min="-10000" :max="10000" :disabled="disabled || !!anchor.camera.tracking?.[field.key === 'position' ? 'follow' : 'lookAt']" :aria-label="`${translate(field.label)} ${axis.toUpperCase()}`" @change="commit(field.key,axis)"><template #prefix>{{ axis.toUpperCase() }}</template></el-input-number></div>
      <label>{{ translate(field.key === 'position' ? '跟随目标' : '注视目标') }}</label>
      <select class="trackingSelect" :value="anchor.camera.tracking?.[field.key === 'position' ? 'follow' : 'lookAt']?.objectId ?? ''" :disabled="disabled" :aria-label="translate(field.key === 'position' ? '跟随目标' : '注视目标')" @change="emit('bind',field.key === 'position' ? 'follow' : 'lookAt',($event.target as HTMLSelectElement).value)"><option value="">{{ translate(field.key === 'position' ? '不跟随' : '手动坐标') }}</option><option v-for="object in objects" :key="object.threeJsonId" :value="object.threeJsonId">{{ targetLabels.get(object.threeJsonId) }}</option></select>
      <template v-if="anchor.camera.tracking?.[field.key === 'position' ? 'follow' : 'lookAt']">
        <label>{{ translate(field.key === 'position' ? '跟随偏移' : '注视偏移') }}</label>
        <div class="cameraVector"><el-input-number v-for="axis in axes" :key="axis" v-number-a11y :modelValue="anchor.camera.tracking?.[field.key === 'position' ? 'follow' : 'lookAt']?.offset[axis]" :controls="false" size="small" :step=".1" :precision="2" :min="-10000" :max="10000" :disabled="disabled" :aria-label="`${translate(field.key === 'position' ? '跟随偏移' : '注视偏移')} ${axis.toUpperCase()}`" @change="setOffset(field.key === 'position' ? 'follow' : 'lookAt',axis,$event)"><template #prefix>{{ axis.toUpperCase() }}</template></el-input-number></div>
      </template>
    </template>
    <label>{{ translate('焦距') }} <small>mm</small></label><el-input-number v-number-a11y v-model="draft.focalLength" size="small" :min="focalRange.min" :max="focalRange.max" :step="1" :precision="1" :disabled="disabled" :aria-label="translate('机位焦距')" @change="commit('focalLength')" />
    <label>{{ translate('视野角度') }} <small>°</small></label><el-input-number v-number-a11y :modelValue="anchor.camera.fov" size="small" :min="10" :max="120" :step="1" :precision="1" :disabled="disabled" :aria-label="translate('机位视野角度')" @change="setFov" />
    <label>{{ translate('倾斜角') }} <small>°</small></label><el-input-number v-number-a11y v-model="draft.roll" size="small" :min="-180" :max="180" :step="1" :precision="1" :disabled="disabled" :aria-label="translate('机位倾斜角')" @change="commit('roll')" />
    <label>{{ translate(recording?'当前录帧时间':'取景时间') }} <small>{{ translate('秒') }}</small></label><el-input-number v-number-a11y v-model="draft.time" size="small" :min="0" :max="300" :step=".1" :precision="2" :disabled="disabled||recording" :aria-label="translate('取景时间')" @change="commit('time')" />
    <el-button size="small" :disabled="disabled" @click="emit('useCurrentView')">{{ translate('使用当前视角') }}</el-button>
    <el-button v-if="recording" size="small" :disabled="disabled" @click="emit('recordFrame')">{{ translate('录入此刻镜头') }}</el-button>
    <el-button type="primary" size="small" :disabled="disabled" @click="emit('snapshot')">{{ translate('导出机位截图') }}</el-button>
  </section>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ElButton, ElInput, ElInputNumber } from 'element-plus';
import { IconCamera, IconCopy, IconTrash, IconFocus2 } from '@tabler/icons-vue';
import { translate } from '@miaoimg/i18n/vue';
import type { CameraView, SceneDocument } from './scene';
import { anchorSchema, type CameraAnchor } from './motion';
import { cameraFocalLength, cameraFov } from './cameraRig';
import { vNumberA11y } from './numberInputA11y';
const props=defineProps<{recording?:boolean;recordError?:string;objects:SceneDocument['objectList'];resolvedView?:CameraView;preview?:string;anchor:CameraAnchor;name:string;aspect:number;disabled:boolean}>();
const targetLabels=computed(()=>{const counts=new Map<string,number>(),seen=new Map<string,number>();for(const o of props.objects){const name=o.name||translate('物体');counts.set(name,(counts.get(name)??0)+1);}return new Map(props.objects.map(o=>{const name=o.name||translate('物体'),index=(seen.get(name)??0)+1;seen.set(name,index);return [o.threeJsonId,counts.get(name)!>1?`${name} ${index}`:name];}));});
const emit=defineEmits<{bind:[kind:'follow'|'lookAt',id:string];update:[anchor:CameraAnchor];lookThrough:[];focus:[];copy:[];remove:[];snapshot:[];recordFrame:[];useCurrentView:[]}>();
const focalRange = computed(() => ({ min: cameraFocalLength({ ...props.anchor, camera: { ...props.anchor.camera, fov:120 } },props.aspect), max:cameraFocalLength({ ...props.anchor, camera: { ...props.anchor.camera, fov:10 } },props.aspect) }));
function setFov(value: number | undefined) { if (typeof value === 'number' && Number.isFinite(value)) emit('update', { ...props.anchor, camera: { ...props.anchor.camera, fov:value } }); }
const axes=['x','y','z'] as const, fields=[{key:'position',label:'机位位置'},{key:'target',label:'看向位置'}] as const;
const draft=ref({name:'',position:{x:0,y:0,z:0},target:{x:0,y:0,z:0},focalLength:35,roll:0,time:0});
watch(()=>[props.anchor,props.aspect,props.resolvedView] as const,()=>{draft.value={name:props.anchor.name||props.name,position:{...(props.resolvedView??props.anchor).camera.position},target:{...(props.resolvedView??props.anchor).controls.target},focalLength:cameraFocalLength(props.anchor,props.aspect),roll:(props.anchor.camera.roll??0)*180/Math.PI,time:props.anchor.time??0};},{immediate:true});
function setOffset(kind:'follow'|'lookAt',axis:'x'|'y'|'z',value:number|undefined){const binding=props.anchor.camera.tracking?.[kind];if(!binding||typeof value!=='number'||!Number.isFinite(value))return;emit('update',anchorSchema.parse({...props.anchor,camera:{...props.anchor.camera,tracking:{...props.anchor.camera.tracking,[kind]:{...binding,offset:{...binding.offset,[axis]:value}}}}}));}
function commit(field:'name'|'position'|'target'|'focalLength'|'roll'|'time',axis?:'x'|'y'|'z'){
 const value=draft.value,base=props.anchor;let updated=base;
 if(field==='name')updated={...base,name:value.name.trim()||props.name};
 else if((field==='position'||field==='target')&&axis){const n=value[field][axis];if(!Number.isFinite(n))return;updated=field==='position'?{...base,camera:{...base.camera,position:{...base.camera.position,[axis]:n}}}:{...base,controls:{...base.controls,target:{...base.controls.target,[axis]:n}}};}
 else if(field==='focalLength'&&Number.isFinite(value.focalLength))updated={...base,camera:{...base.camera,fov:Math.min(120,Math.max(10,cameraFov(value.focalLength,props.aspect)))}};
 else if(field==='roll'&&Number.isFinite(value.roll))updated={...base,camera:{...base.camera,roll:value.roll*Math.PI/180}};
 else if(field==='time'&&Number.isFinite(value.time))updated={...base,time:value.time};
 const parsed=anchorSchema.safeParse(updated);if(parsed.success)emit('update',parsed.data);
}

</script>
<style scoped>
.trackingSelect{width:100%;height:28px;box-sizing:border-box;border:0;border-radius:8px;background:rgba(255,255,255,.1);color:var(--el-text-color-primary);padding:0 8px;font:inherit;font-size:12px;color-scheme:dark}.trackingSelect:focus-visible{outline:1px solid var(--el-color-primary)}.cameraInspector{display:flex;flex-direction:column;gap:8px;padding:14px;min-height:0;overflow-y:auto;height:100%;box-sizing:border-box}.cameraInspector>*{flex-shrink:0;min-width:0}.cameraPreview{position:relative}.cameraPreview img{display:block;width:100%;border-radius:8px}.cameraPreview span{position:absolute;bottom:5px;left:6px;color:#eee;font-size:10px;text-shadow:0 1px 3px #000}.cameraInspector label{font-size:12px;color:var(--el-text-color-secondary);margin-top:5px}.cameraInspector small{font-size:11px}.cameraActions{display:flex;align-items:center;gap:4px}.cameraActions .el-button{margin:0}.cameraVector{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px}.cameraVector .el-input-number{width:100%}.cameraInspector>.el-input-number{width:100%}.cameraInspector>.el-button{margin:4px 0 0}
</style>

<style scoped>
.cameraRecordHint,.cameraRecordError { margin:0; font-size:11px; line-height:1.6; overflow-wrap:anywhere; }
.cameraRecordHint { color:var(--el-text-color-secondary); }
.cameraRecordError { color:var(--el-color-danger); }
</style>
