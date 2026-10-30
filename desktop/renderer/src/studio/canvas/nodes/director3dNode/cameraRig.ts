import { BoxGeometry, BufferGeometry, Float32BufferAttribute, Group, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { cameraRoll } from './cameraOrientation';
import { applyCamera, type CameraAnchor } from './motion';
import type { CameraView } from './scene';

export function cameraFocalLength(anchor: CameraView, aspect: number) {
  const camera = new PerspectiveCamera(anchor.camera.fov, aspect); return camera.getFocalLength();
}
export function cameraFov(focalLength: number, aspect: number) {
  const camera = new PerspectiveCamera(55, aspect); camera.setFocalLength(focalLength); return camera.fov;
}
export function cameraViewFromTransform(anchor: CameraAnchor, position: Vector3, quaternion: Quaternion): CameraView {
  const distance = Math.max(.1, new Vector3(anchor.controls.target.x, anchor.controls.target.y, anchor.controls.target.z).distanceTo(new Vector3(anchor.camera.position.x, anchor.camera.position.y, anchor.camera.position.z)));
  const target = new Vector3(0, 0, -1).applyQuaternion(quaternion).multiplyScalar(distance).add(position);
  return { camera: { ...anchor.camera, roll: cameraRoll(position,quaternion), position: { x: position.x, y: position.y, z: position.z } }, controls: { target: { x: target.x, y: target.y, z: target.z } } };
}
/** Editor-only helper: a real camera pose and a short, correctly projected frustum. */
export function createCameraRig(anchor: CameraAnchor, aspect: number, selected: boolean) {
  const group = new Group(); group.name = 'directorCamera'; group.userData.cameraAnchorId = anchor.id;
  const body = new Mesh(new BoxGeometry(.28, .18, .26), new MeshBasicMaterial({ color: selected ? 0xffffff : 0xd8d8dc, transparent: true, opacity: selected ? 0.9 : 0.35, depthWrite: false }));
  body.name = 'directorCameraBody'; body.position.z = .13; group.add(body);
  const camera = new PerspectiveCamera(); applyCamera(camera, anchor); group.position.copy(camera.position); group.quaternion.copy(camera.quaternion);
  const distance = Math.min(4, Math.max(1.5, new Vector3(anchor.controls.target.x, anchor.controls.target.y, anchor.controls.target.z).distanceTo(camera.position) * .35));
  const height = Math.tan(anchor.camera.fov * Math.PI / 360) * distance, width = height * aspect;
  const corners = [[-width,-height,-distance],[width,-height,-distance],[width,height,-distance],[-width,height,-distance]];
  const positions: number[] = [];
  for(let i=0;i<4;i++) { positions.push(0,0,0,...corners[i]!,...corners[i]!,...corners[(i+1)%4]!); }
  positions.push(-.12,.12,.12,0,.25,.12,0,.25,.12,.12,.12,.12);
  const geometry = new BufferGeometry(); geometry.setAttribute('position',new Float32BufferAttribute(positions,3));
  const frustum = new LineSegments(geometry,new LineBasicMaterial({color:selected?0xf2f2f3:0x5a5a60,transparent:true,opacity:selected?.75:.4,depthWrite:false}));
  frustum.visible = selected;
  group.add(frustum);
  return {group,body,updatePose(view:CameraView){applyCamera(camera,view);group.position.copy(camera.position);group.quaternion.copy(camera.quaternion);},dispose(){body.geometry.dispose();body.material.dispose();geometry.dispose();frustum.material.dispose();}};
}
