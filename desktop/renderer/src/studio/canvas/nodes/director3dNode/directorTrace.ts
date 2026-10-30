import { translate } from '@miaoimg/i18n/vue';
import { publicError } from '@/lib/publicError';
import { toolActionLabel } from '../../components/agent/toolLabels';
import { stageAssemblies } from './stageGroups';
import { propPresets, setPresets, posePresets } from './stageLibrary';
import type { CameraAnchor } from './motion';
import { shotPresets } from './cameraPresets';
import { bodyTypes, type BodyType } from './mannequin';
import type { SceneDocument } from './scene';
import type { DirectorToolTrace } from './sceneAnimation';

export type DirectorTraceEvent = {
  type: 'start' | 'end'; id: string; name: string; args: Record<string, unknown>; scene: SceneDocument;
  anchors?:CameraAnchor[]; selectedAnchorId?:string; startedAt: number; durationMs?: number; result?: unknown; error?: unknown; interrupted?: boolean;
};
function object(value: unknown): Record<string, any> {
  if (typeof value === 'string') { try { return JSON.parse(value); } catch { return {}; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}
const fieldLabels: Record<string, string> = { name: '名称', position: '位置', rotation: '旋转', scale: '缩放', material: '材质', pose: '姿势', hiddenParts: '身体部位', objectList: '场景物体', sceneConfig: '场景设置', camera: '镜头', controls: '镜头', lights: '光照', tracks: '动作轨道', cameraFrames: '机位关键帧', duration: '时长' };

export function directorTraceText(value: string) {
  const match = /^字段已存在，请使用 replace[：:]([A-Za-z]+)$/.exec(value);
  const field = match && fieldLabels[match[1]!];
  return field ? translate('{0}已存在，请修改现有内容', { 0: translate(field) }) : value;
}

/** Persist human summaries only: never raw arguments, image Base64, URLs or model payloads. */
export function beginDirectorTrace(event: DirectorTraceEvent, selectedIds: string[] = []): DirectorToolTrace {
  const args = event.args, details: string[] = [];
  const id = typeof args.objectId === 'string' ? args.objectId : event.name === 'applyActorPose' && selectedIds.length === 1 ? selectedIds[0] : undefined;
  let target = event.scene.objectList.find(item => item.threeJsonId === id)?.name;
  if (event.name === 'updateStageAsset') target = stageAssemblies(event.scene.objectList).find(group => group.id === args.assetId)?.name;
  if (event.name === 'addStageAsset') {
    const preset = args.kind === 'set' ? setPresets.find(p => p.id === args.presetId) : propPresets.find(p => p.id === args.presetId);
    target = typeof args.name === 'string' ? args.name : args.kind === 'actor' ? translate('人偶') : preset ? translate(preset.name) : undefined;
    const build = args.kind === 'actor' && typeof args.bodyType === 'string' && Object.hasOwn(bodyTypes, args.bodyType) ? bodyTypes[args.bodyType as BodyType] : undefined;
    if (build) details.push(`${translate('体型')}：${translate(build.name)}`);
  }
  if (event.name === 'applyActorPose') {
    const preset = posePresets.find(p => p.id === args.presetId);
    if (preset) details.push(`${translate('姿势')}：${translate(preset.name)}`);
  }
  if(event.name==='readStage'||event.name==='editStage')target=translate('灯光与环境');
  if(event.name==='editStage'){
    if(typeof args.lightingPreset==='string')details.push(`${translate('灯光')}：${translate(args.lightingPreset)}`);
    if(typeof args.aspectRatio==='string')details.push(`${translate('画面比例')}：${args.aspectRatio}`);
    const fields=[...Object.keys(object(args.lighting)),...Object.keys(object(args.settings))];
    if(fields.length)details.push(translate('{0} 项设置',{0:fields.length}));
  }
  if(event.name==='readCameras')target=translate('机位');
  if(event.name==='editCameras'&&Array.isArray(args.operations)){
    const operations=args.operations.map(object);const ids=operations.map(op=>op.anchorId??event.selectedAnchorId).filter(id=>typeof id==='string');
    target=event.anchors?.filter(a=>ids.includes(a.id)).map((a,i)=>a.name??translate('机位 {0}',{0:i+1})).slice(0,3).join(' / ')||undefined;
    details.push(translate('{0} 项修改',{0:operations.length}));
    for(const op of operations){
      const shot=shotPresets.find(preset=>preset.id===op.shotPresetId),nameOf=(id:unknown)=>event.scene.objectList.find(o=>o.threeJsonId===id)?.name;
      if(shot){details.push(`${translate('景别')}：${translate(shot.name)}`);if(nameOf(op.subjectObjectId))details.push(`${translate('主体')}：${nameOf(op.subjectObjectId)}`);if(nameOf(op.shotTargetObjectId))details.push(`${translate('看向')}：${nameOf(op.shotTargetObjectId)}`);}
      for(const [key,label] of [['followObjectId','跟随目标'],['lookAtObjectId','注视目标']])if(op[key]!==undefined){const object=event.scene.objectList.find(o=>o.threeJsonId===op[key]);details.push(`${translate(label!)}：${op[key]===null?translate('无'):object?.name??translate('物体')}`);}
      if(typeof op.focalLengthMm==='number')details.push(`${translate('焦距')}：${op.focalLengthMm} mm`);
      if(typeof op.fov==='number')details.push(`${translate('视野角度')}：${op.fov}°`);
      if(typeof op.rollDegrees==='number')details.push(`${translate('倾斜角')}：${op.rollDegrees}°`);
      if(op.position&&typeof op.position==='object')details.push(`${translate('机位位置')}：X ${Number(op.position.x).toFixed(2)} · Y ${Number(op.position.y).toFixed(2)} · Z ${Number(op.position.z).toFixed(2)}`);
      if(op.target&&typeof op.target==='object')details.push(`${translate('看向位置')}：X ${Number(op.target.x).toFixed(2)} · Y ${Number(op.target.y).toFixed(2)} · Z ${Number(op.target.z).toFixed(2)}`);
    }
  }
  if (Array.isArray(args.operations) && event.name!=='editCameras') {
    const operations = args.operations.map(object);
    const names = [...new Set(operations.flatMap(op => event.scene.objectList.find(item => item.threeJsonId === op.objectId)?.name ?? []))];
    if (names.length) target = names.slice(0, 3).join(' / ');
    const fields = [...new Set(operations.flatMap(op => Array.isArray(op.path) ? op.path.filter((key: unknown) => typeof key === 'string' && fieldLabels[key]).map((key: string) => translate(fieldLabels[key]!)) : []))];
    if (fields.length) details.push(`${translate('修改项')}：${fields.slice(0, 5).join(' / ')}`);
    details.push(translate('{0} 项修改', { 0: operations.length }));
  }
  if (event.name === 'readDocument' && !target) target = translate(args.section === 'plan' ? '动画方案' : args.section === 'history' ? '历史方案' : args.section === 'schema' ? '可编辑参数' : '基础场景');
  if (event.name === 'inspectDocument' && Array.isArray(args.timestamps)) details.push(translate('检查时间：{0} 秒', { 0: args.timestamps.join(' / ') }));
  if (event.name === 'inspectReference' && Number.isInteger(args.referenceIndex)) target = translate('参考素材 {0}', { 0: args.referenceIndex });
  return { id: event.id, name: event.name, label: toolActionLabel({ name: event.name, args }), status: 'running', startedAt: event.startedAt, target, details: details.slice(0, 8) };
}
export function finishDirectorTrace(trace: DirectorToolTrace, event: DirectorTraceEvent): DirectorToolTrace {
  const result = object(event.result), details = [...trace.details];
  if (event.error) {
    const outcome = event.interrupted ? translate('已中断') : publicError(event.error);
    return { ...trace, status: event.interrupted ? 'interrupted' : 'error', outcome, details: [...details, outcome].slice(0, 8), durationMs: event.durationMs };
  }
  let outcome = '';
  let target = trace.target;
  if (event.name === 'addStageAsset' && Array.isArray(result.objectIds) && result.objectIds.length === 1) target = event.scene.objectList.find(item => item.threeJsonId === result.objectIds[0])?.name ?? target;
  if (event.name === 'editDocument' && Array.isArray(event.args.operations)) {
    const operations = event.args.operations.map(object), ids = [...new Set(operations.map(op => op.objectId).filter(id => typeof id === 'string'))];
    if (ids.length === 1) {
      const item = event.scene.objectList.find(value => value.threeJsonId === ids[0]);
      if (item && operations.some(op => Array.isArray(op.path) && op.path.includes('position'))) details.push(`${translate('位置')}：X ${item.position.x.toFixed(2)} · Y ${item.position.y.toFixed(2)} · Z ${item.position.z.toFixed(2)}`);
    }
  }
  if(event.name==='readCameras'&&Array.isArray(result.anchors))outcome=translate('读取 {0} 个机位',{0:result.anchors.length});
  if(event.name==='editStage')outcome=result.changed===false?translate('没有需要应用的修改'):translate('已写入草稿');
  if(event.name==='editCameras')outcome=result.changed===false?translate('没有需要应用的修改'):translate('机位已写入草稿');
  if (event.name === 'getStageLibrary') {
    if (Array.isArray(result.sets)) details.push(translate('{0} 个场景预设', { 0: result.sets.length }));
    if (Array.isArray(result.props)) details.push(translate('{0} 类道具', { 0: result.props.length }));
    if (Array.isArray(result.poses)) details.push(translate('{0} 种姿势', { 0: result.poses.length }));
  }
  if (event.name === 'addStageAsset' && Array.isArray(result.objectIds)) outcome = translate('已加入草稿：{0} 个物体', { 0: result.objectIds.length });
  if (event.name === 'updateStageAsset') {
    const count = Array.isArray(result.objectIds) ? result.objectIds.length : 0;
    outcome = result.changed === false ? translate('没有需要应用的修改') : translate(event.args.action === 'remove' ? '已移除 {0} 个零件' : event.args.action === 'copy' ? '已复制 {0} 个零件' : event.args.action === 'ungroup' ? '已拆开为 {0} 个零件' : '已更新 {0} 个零件', { 0: count });
  }
  if (event.name === 'applyActorPose') {outcome=translate(result.changed===false?'没有需要应用的修改':result.mode==='animation'?'姿势已写入动画关键帧':'姿势已写入草稿');if(result.mode==='animation'&&typeof result.time==='number')details.push(translate('关键帧时间：{0} 秒',{0:result.time}));}
  if (event.name === 'editDocument' && typeof result.applied === 'number') outcome = translate('已更新草稿：{0} 项修改', { 0: result.applied });
  if(typeof result.detachedCameraBindings==='number'&&result.detachedCameraBindings>0)details.push(translate('已解除 {0} 个失效机位绑定',{0:result.detachedCameraBindings}));
  if (result.valid === false) details.push(translate('草稿尚待补齐'));
  if (event.name === 'readDocument') {
    const value = object(result.value);
    if (Array.isArray(value.objectList)) details.push(translate('读取 {0} 个物体', { 0: value.objectList.length }));
    if (typeof value.name === 'string') details.push(`${translate('名称')}：${value.name}`);
  }
  if (Array.isArray(result.frames)) outcome = translate('已检查 {0} 个画面', { 0: result.frames.length });
  return { ...trace, ...(event.name==='applyActorPose'&&result.mode==='animation'?{label:'录入姿势关键帧'}:{}), target, status: 'success', details: details.slice(0, 8), outcome, durationMs: event.durationMs };
}
