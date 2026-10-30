import { PerspectiveCamera, Vector3 } from 'three';
import type { CameraView, SceneDocument } from './scene';
import { bodyTypes } from './mannequin';

type Point = { x: number; y: number; z: number };
/** The framed subject in world space: feet position, facing (radians about +Y, 0 faces +Z) and body height; `other` is the head of the character an over-the-shoulder shot looks at; `origin` is the object's own position, which camera bindings resolve from. */
export interface ShotSubject { id?: string; root: Point; origin?: Point; yaw: number; height: number; other?: Point }
interface ShotSpec {
  id: string; name: string;
  /** Degrees around the subject from its front; 90 is the subject's left side. */
  azimuth: number;
  /** Degrees the camera looks down (negative looks up). */
  elevation: number;
  /** Fraction of body height that fills the frame vertically, and the height the camera aims at. */
  span: number; aim: number;
  focal: number; roll?: number; follow?: boolean; overShoulder?: 1 | -1;
}

export const shotPresets: readonly ShotSpec[] = [
  { id: 'frontMedium', name: '正面中景', azimuth: 0, elevation: 4, span: 0.55, aim: 0.74, focal: 50 },
  { id: 'frontCloseUp', name: '正面特写', azimuth: 0, elevation: 2, span: 0.24, aim: 0.9, focal: 85 },
  { id: 'frontWide', name: '正面全景', azimuth: 0, elevation: 6, span: 1.2, aim: 0.5, focal: 35 },
  { id: 'sideTracking', name: '侧面跟拍', azimuth: 90, elevation: 3, span: 0.95, aim: 0.55, focal: 35, follow: true },
  { id: 'sideClose', name: '侧面近景', azimuth: 90, elevation: 2, span: 0.38, aim: 0.84, focal: 50 },
  { id: 'backMedium', name: '背面中景', azimuth: 180, elevation: 5, span: 0.55, aim: 0.74, focal: 50 },
  { id: 'highWide', name: '俯拍全景', azimuth: 20, elevation: 50, span: 1.4, aim: 0.4, focal: 28 },
  { id: 'high45', name: '45° 俯拍', azimuth: 30, elevation: 45, span: 0.85, aim: 0.6, focal: 35 },
  { id: 'lowAngle', name: '低角度仰拍', azimuth: 15, elevation: -22, span: 0.9, aim: 0.66, focal: 35 },
  { id: 'lowWide', name: '低角度广角', azimuth: 0, elevation: -12, span: 1.15, aim: 0.5, focal: 18 },
  { id: 'overShoulder', name: '过肩镜头', azimuth: 180, elevation: 4, span: 0.6, aim: 0.85, focal: 50, overShoulder: 1 },
  { id: 'overShoulderRight', name: '过肩镜头（右）', azimuth: 180, elevation: 4, span: 0.6, aim: 0.85, focal: 50, overShoulder: -1 },
  { id: 'birdsEye', name: '鸟瞰', azimuth: 0, elevation: 89, span: 1.7, aim: 0.2, focal: 24 },
  { id: 'dutch', name: '荷兰角', azimuth: 20, elevation: 4, span: 0.6, aim: 0.72, focal: 35, roll: 15 },
];
/** Frame shapes the director renders and exports, widest first. */
export const aspectRatios = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'] as const;
/** Approximate subject from the saved document (no live runtime): standing height 1.8 m per build, lowered by the pose preset offset. */
export function documentShotSubject(scene: SceneDocument, objectId?: string, lookAtId?: string): ShotSubject {
  const actors = scene.objectList.filter(object => object.objType === 'mannequin');
  if (objectId && !actors.some(object => object.threeJsonId === objectId)) throw new Error('主体必须是场景中的人偶 objectId');
  if (lookAtId && (lookAtId === objectId || !actors.some(object => object.threeJsonId === lookAtId))) throw new Error('看向的对象必须是另一个人偶 objectId');
  const actor = actors.find(object => object.threeJsonId === objectId) ?? actors[0];
  if (!actor) throw new Error('请先添加人偶');
  const head = (object: typeof actor) => {
    const height = 1.8 * bodyTypes[object.bodyType ?? 'standard'].length * (object.scale?.scaleY ?? 1) + (object.posePresetHeight ?? 0);
    return { height, root: { x: object.position.x, y: object.position.y - (object.posePresetHeight ?? 0), z: object.position.z } };
  };
  const self = head(actor), others = actors.filter(object => object !== actor && (!lookAtId || object.threeJsonId === lookAtId)).map(object => { const value = head(object); return { ...value.root, y: value.root.y + value.height * 0.9 }; });
  const other = others.sort((a, b) => Math.hypot(a.x - self.root.x, a.z - self.root.z) - Math.hypot(b.x - self.root.x, b.z - self.root.z))[0];
  return { id: actor.threeJsonId, root: self.root, origin: { ...actor.position }, yaw: actor.rotation?.rotationY ?? 0, height: self.height, other };
}

const rad = Math.PI / 180;
function fovFor(focal: number, aspect: number) { const camera = new PerspectiveCamera(50, aspect); camera.setFocalLength(focal); return camera.fov; }

/**
 * A camera view for a named shot, framed on the subject.
 * Over-the-shoulder looks past the subject at `other` (or 3 m ahead of it); side tracking binds follow and look-at to the subject.
 */
export function shotPresetView(id: string, subject: ShotSubject, aspect: number): CameraView {
  const spec = shotPresets.find(preset => preset.id === id);
  if (!spec) throw new Error(`unknown shot preset ${id}`);
  const height = Math.max(0.2, subject.height);
  const root = new Vector3(subject.root.x, subject.root.y, subject.root.z);
  const forward = new Vector3(Math.sin(subject.yaw), 0, Math.cos(subject.yaw));
  const left = new Vector3(forward.z, 0, -forward.x);
  const fov = fovFor(spec.focal, aspect);
  let position: Vector3, target: Vector3;
  if (spec.overShoulder) {
    const shoulder = root.clone().setY(root.y + height * 0.86);
    target = subject.other ? new Vector3(subject.other.x, subject.other.y, subject.other.z) : shoulder.clone().addScaledVector(forward, 3);
    const toTarget = target.clone().sub(shoulder).setY(0);
    const look = toTarget.lengthSq() > 1e-6 ? toTarget.normalize() : forward.clone();
    const side = new Vector3(look.z, 0, -look.x);
    position = shoulder.clone().addScaledVector(look, -0.9).addScaledVector(side, spec.overShoulder * 0.45).setY(root.y + height * 0.8);
  } else {
    target = root.clone().setY(root.y + height * spec.aim);
    const distance = height * spec.span / 2 / Math.tan(fov * rad / 2) / 0.9;
    const around = forward.clone().multiplyScalar(Math.cos(spec.azimuth * rad)).addScaledVector(left, Math.sin(spec.azimuth * rad));
    const elevation = Math.min(89.5, spec.elevation) * rad;
    position = target.clone().addScaledVector(around, distance * Math.cos(elevation)).setY(target.y + distance * Math.sin(elevation));
    // Keep low angles above the floor.
    if (position.y < root.y + 0.12) position.y = root.y + 0.12;
    // Looking straight down needs a hint of offset so lookAt keeps a stable up vector.
    if (spec.elevation >= 89) position.addScaledVector(around, 0.02);
  }
  const origin = subject.origin ?? subject.root, offset = (point: Vector3) => ({ x: point.x - origin.x, y: point.y - origin.y, z: point.z - origin.z });
  return {
    camera: {
      position: { x: position.x, y: position.y, z: position.z }, fov, near: 0.05, far: 2000,
      ...(spec.roll ? { roll: spec.roll * rad } : {}),
      ...(spec.follow && subject.id ? { tracking: { follow: { objectId: subject.id, point: 'root' as const, offset: offset(position) }, lookAt: { objectId: subject.id, point: 'root' as const, offset: offset(target) } } } : {}),
    },
    controls: { target: { x: target.x, y: target.y, z: target.z } },
  };
}
