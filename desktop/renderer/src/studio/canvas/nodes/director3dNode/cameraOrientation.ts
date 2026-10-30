import { Matrix4, Quaternion, Vector3 } from 'three';

/** Roll about the optical axis relative to a world-up look-at orientation. */
export function cameraRoll(position: Vector3, quaternion: Quaternion) {
  const direction = new Vector3(0,0,-1).applyQuaternion(quaternion), target = position.clone().add(direction);
  const base = new Quaternion().setFromRotationMatrix(new Matrix4().lookAt(position,target,new Vector3(0,1,0)));
  const relative = base.invert().multiply(quaternion);
  const angle = 2*Math.atan2(relative.z,relative.w);
  return Math.atan2(Math.sin(angle),Math.cos(angle));
}
