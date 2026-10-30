import { type SceneDocument, type LightingSettings } from './scene';
import { assembleStageObjects, offsetStageObjects } from './stageGroups';
import { translate } from '@miaoimg/i18n/vue';
import { bodyTypes } from './mannequin';

type SceneObject = SceneDocument['objectList'][number];
type Pose = NonNullable<SceneObject['pose']>;
const turn = (x = 0, y = 0, z = 0) => ({ x: x * Math.PI / 180, y: y * Math.PI / 180, z: z * Math.PI / 180 });
export const actorColors = ['#7196ef', '#e8ab83', '#bc8cdb', '#79b6a2', '#e0c57c', '#d48092', '#d4d6dc', '#596779'];
export const posePresets: { id: string; name: string; pose: Pose; height?: number }[] = [
  { id: 'stand', name: '自然站立', pose: {} },
  { id: 'walk', name: '行走', pose: { leftHip: turn(-28), rightHip: turn(28), leftKnee: turn(15), rightKnee: turn(25), leftShoulder: turn(25), rightShoulder: turn(-25) } },
  { id: 'run', name: '奔跑', pose: { spine: turn(14), leftHip: turn(-55), rightHip: turn(38), leftKnee: turn(65), rightKnee: turn(85), leftShoulder: turn(40), rightShoulder: turn(-45), leftElbow: turn(-85), rightElbow: turn(-85) } },
  { id: 'sit', name: '坐姿', pose: { leftHip: turn(-90), rightHip: turn(-90), leftKnee: turn(90), rightKnee: turn(90), leftElbow: turn(-25), rightElbow: turn(-25) }, height: -0.43 },
  { id: 'wave', name: '挥手', pose: { rightShoulder: turn(0, 0, -125), rightElbow: turn(-35), rightWrist: turn(0, 0, -20) } },
  { id: 'point', name: '指向', pose: { rightShoulder: turn(-85), rightElbow: turn(-10), head: turn(0, -15) } },
  { id: 'talk', name: '交谈', pose: { leftShoulder: turn(-25, 0, 15), leftElbow: turn(-65), rightShoulder: turn(-15, 0, -15), rightElbow: turn(-45), head: turn(0, -10) } },
  { id: 'arms', name: '平举双臂', pose: { leftShoulder: turn(0, 0, 90), rightShoulder: turn(0, 0, -90) } },
  { id: 'crouch', name: '下蹲', pose: { spine: turn(25), leftHip: turn(-85), rightHip: turn(-85), leftKnee: turn(115), rightKnee: turn(115), leftAnkle: turn(-30), rightAnkle: turn(-30), leftShoulder: turn(-45), rightShoulder: turn(-45) }, height: -0.5 },
  { id: 'look', name: '回头', pose: { spine: turn(0, 25), neck: turn(0, 25), head: turn(0, 35) } },
];
export const jointLabels: Record<string, string> = { hips: '骨盆', spine: '躯干', neck: '颈部', head: '头部', leftShoulder: '左肩', leftElbow: '左肘', leftWrist: '左腕', rightShoulder: '右肩', rightElbow: '右肘', rightWrist: '右腕', leftHip: '左髋', leftKnee: '左膝', leftAnkle: '左踝', rightHip: '右髋', rightKnee: '右膝', rightAnkle: '右踝' };

function box(name: string, x: number, y: number, z: number, w: number, h: number, d: number, color = '#9399a5'): SceneObject {
  return { threeJsonId: crypto.randomUUID(), name, objType: 'box', geometry: { width: w, height: h, depth: d }, position: { x, y, z }, material: { type: 'standard', color, roughness: 0.8 } };
}
function chair(x = 0, z = 0): SceneObject[] {
  return assembleStageObjects([box('椅面', x, 0.46, z, 0.5, 0.08, 0.5, '#a88b72'), box('椅背', x, 0.8, z - 0.23, 0.5, 0.65, 0.06, '#a88b72'), ...[-0.19, 0.19].flatMap(dx => [-0.19, 0.19].map(dz => box('椅腿', x + dx, 0.22, z + dz, 0.045, 0.44, 0.045, '#555b65')))], '椅子', { x, y: 0, z });
}
function table(): SceneObject[] {
  return assembleStageObjects([box('桌面', 0, 0.76, 0, 1.8, 0.09, 0.85, '#ae9278'), ...[-0.78, 0.78].flatMap(x => [-0.3, 0.3].map(z => box('桌腿', x, 0.36, z, 0.06, 0.72, 0.06, '#505663')))], '桌子');
}
/** Living-room coffee table: knee height, so it does not hide a seated actor from a front camera. */
function coffeeTable(): SceneObject[] {
  return assembleStageObjects([box('茶几面', 0, 0.4, 0, 1.2, 0.06, 0.6, '#ae9278'), ...[-0.54, 0.54].flatMap(x => [-0.24, 0.24].map(z => box('茶几腿', x, 0.185, z, 0.05, 0.37, 0.05, '#505663')))], '茶几');
}
export const propPresets = [
  { id: 'box', name: '立方体', symbol: 'box' }, { id: 'sphere', name: '球体', symbol: 'sphere' },
  { id: 'cylinder', name: '圆柱', symbol: 'cylinder' }, { id: 'wall', name: '墙体', symbol: 'wall' },
  { id: 'chair', name: '椅子', symbol: 'chair' }, { id: 'table', name: '桌子', symbol: 'table' },
  { id: 'sofa', name: '沙发', symbol: 'sofa' }, { id: 'door', name: '门框', symbol: 'door' },
  { id: 'stairs', name: '台阶', symbol: 'stairs' }, { id: 'platform', name: '舞台', symbol: 'platform' },
] as const;
export type PropId = typeof propPresets[number]['id'];
export function createProp(id: PropId): SceneObject[] {
  switch (id) {
    case 'chair': return chair();
    case 'table': return table();
    // Seat 0.45 m high and 0.6 m deep: an actor seated at the cushion centre has knees past the front edge.
    case 'sofa': return assembleStageObjects([box('沙发坐垫', 0, 0.3, 0.02, 2.1, 0.3, 0.6, '#738b97'), box('沙发靠背', 0, 0.75, -0.34, 2.1, 0.66, 0.2, '#738b97'), ...[-1.05, 1.05].map(x => box('沙发扶手', x, 0.55, 0, 0.2, 0.6, 0.9, '#738b97'))], '沙发');
    case 'door': return assembleStageObjects([box('门框左侧', -0.6, 1.2, 0, 0.12, 2.4, 0.2), box('门框右侧', 0.6, 1.2, 0, 0.12, 2.4, 0.2), box('门框上沿', 0, 2.4, 0, 1.32, 0.12, 0.2)], '门框');
    case 'stairs': return assembleStageObjects([0, 1, 2, 3].map(i => box('台阶', 0, (i + 1) * 0.1, -i * 0.35, 2, (i + 1) * 0.2, 0.35)), '台阶');
    case 'platform': return [box('舞台', 0, 0.15, 0, 4, 0.3, 3)];
    case 'wall': return [box('墙体', 0, 1.5, -2, 4, 3, 0.15, '#c8c3ba')];
    case 'sphere': return [{ ...box('球体', 0, 0.5, 0, 1, 1, 1), objType: 'sphere', geometry: { radius: 0.5, widthSegments: 32, heightSegments: 24 } }];
    case 'cylinder': return [{ ...box('圆柱', 0, 0.5, 0, 1, 1, 1), objType: 'cylinder', geometry: { radiusTop: 0.4, radiusBottom: 0.4, height: 1, radialSegments: 32 } }];
    default: return [box('立方体', 0, 0.5, 0, 1, 1, 1)];
  }
}
export const setPresets = [
  { id: 'studio', name: '摄影棚', color: '#353c4b' }, { id: 'interview', name: '双人访谈', color: '#705d4b' },
  { id: 'living', name: '客厅', color: '#69817d' }, { id: 'corridor', name: '走廊', color: '#707d96' },
] as const;
export type SetId = typeof setPresets[number]['id'];
export function createSet(id: SetId): SceneObject[] {
  if (id === 'studio') return [box('背景墙', 0, 2, -3, 8, 4, 0.12, '#afb3bf'), box('摄影台', 0, 0.1, 0, 4, 0.2, 3, '#777d8b')];
  if (id === 'interview') return [...chair(-1.2, 0), ...chair(1.2, 0), ...offsetStageObjects(table(), { x: 0, y: 0, z: 1.1 }), box('访谈背景', 0, 1.7, -2, 7, 3.4, 0.15, '#7f736c')];
  if (id === 'living') return [...createProp('sofa'), ...offsetStageObjects(coffeeTable(), { x: 0, y: 0, z: 1.25 }), box('客厅后墙', 0, 1.5, -2, 7, 3, 0.15, '#c5c0b4'), box('客厅侧墙', -3.5, 1.5, 0.5, 0.15, 3, 5, '#afbbb5')];
  return [box('走廊左墙', -1.7, 1.6, 0, 0.18, 3.2, 10, '#b4b9c4'), box('走廊右墙', 1.7, 1.6, 0, 0.18, 3.2, 10, '#b4b9c4'), ...[-3, 0, 3].map(z => box('横梁', 0, 3.15, z, 3.5, 0.15, 0.2, '#7b8596'))];
}
export const lightingPresets: { name: string; color: string; settings: Partial<LightingSettings> }[] = [
  { name: '日光', color: '#fff5e8', settings: { color: '#fff5e8', azimuth: 45, elevation: 45, intensity: 2.4, globalIntensity: 0.65 } },
  { name: '黄金时刻', color: '#ffba73', settings: { color: '#ffba73', azimuth: 110, elevation: 12, intensity: 3, globalIntensity: 0.35 } },
  { name: '月光', color: '#8caaff', settings: { color: '#8caaff', azimuth: 210, elevation: 35, intensity: 1.8, globalIntensity: 0.15 } },
  { name: '柔光', color: '#e6edff', settings: { color: '#e6edff', azimuth: 10, elevation: 65, intensity: 1, globalIntensity: 1.2 } },
];

/** Shared by the inspector and both AI entry points; preserve manual height offsets. */
export function applyActorPosePreset<T extends Pick<SceneObject, 'objType' | 'pose' | 'position' | 'posePresetHeight' | 'bodyType'>>(object: T, presetId: string): T {
  if (object.objType !== 'mannequin') throw new Error('只有人偶支持姿势预设');
  const preset = posePresets.find(item => item.id === presetId);
  if (!preset) throw new Error('姿势预设不存在');
  // Preset heights are measured on the standard build; shorter bodies drop proportionally less.
  const length = bodyTypes[object.bodyType ?? 'standard'].length, height = (preset.height ?? 0) * length;
  const previousHeight = object.posePresetHeight ?? (posePresets.find(item => JSON.stringify(item.pose) === JSON.stringify(object.pose ?? {}))?.height ?? 0) * length;
  return { ...object, pose: structuredClone(preset.pose), position: { ...object.position, y: object.position.y + height - previousHeight }, posePresetHeight: height };
}

export function localizeStageObjects(objects: SceneObject[]): SceneObject[] {
  return objects.map(object => ({ ...object, name: translate(object.name!), ...(object.assembly ? { assembly: { ...object.assembly, name: translate(object.assembly.name) } } : {}) }));
}
