import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { translate } from '@miaoimg/i18n/vue';
import { z } from '@miaoimg/nodes-scaffold/runtime';
import { sceneSchema, stageAssemblySchema, type SceneDocument, type StageAssembly, type ObjectPatch } from './scene';

type SceneObject = SceneDocument['objectList'][number];
export type StageAssemblyInfo = StageAssembly & { objectIds: string[] };
export const stageAssetEditSchema = z.strictObject({
  assetId: z.string().min(1), action: z.enum(['update', 'copy', 'remove', 'ungroup']).default('update'),
  name: stageAssemblySchema.shape.name.optional(), position: stageAssemblySchema.shape.position.optional(),
  rotation: stageAssemblySchema.shape.rotation.optional(), scale: stageAssemblySchema.shape.scale.optional(),
  color: sceneSchema.shape.objectList.element.shape.material.shape.color.optional(),
  roughness: z.number().min(0).max(1).optional(), metalness: z.number().min(0).max(1).optional(),
});
export type StageAssetEdit = z.infer<typeof stageAssetEditSchema>;

export function stageAssemblies(objects: SceneObject[]): StageAssemblyInfo[] {
  const groups = new Map<string, StageAssemblyInfo>();
  for (const object of objects) if (object.assembly) {
    let group = groups.get(object.assembly.id);
    if (!group) { group = { ...object.assembly, objectIds: [] }; groups.set(group.id, group); }
    group.objectIds.push(object.threeJsonId);
  }
  return [...groups.values()];
}
export function assembleStageObjects(objects: SceneObject[], name: string, position = { x: 0, y: 0, z: 0 }): SceneObject[] {
  if (objects.length < 2) return objects;
  const assembly: StageAssembly = { id: crypto.randomUUID(), name, position, rotation: { rotationX: 0, rotationY: 0, rotationZ: 0 }, scale: 1 };
  return objects.map(object => ({ ...object, assembly: structuredClone(assembly) }));
}
export function offsetStageObjects(objects: SceneObject[], offset: { x: number; y: number; z: number }): SceneObject[] {
  const add = (value: typeof offset) => ({ x: value.x + offset.x, y: value.y + offset.y, z: value.z + offset.z });
  return objects.map(object => ({ ...object, position: add(object.position), ...(object.assembly ? { assembly: { ...object.assembly, position: add(object.assembly.position) } } : {}) }));
}
function matrix(group: StageAssembly) {
  const r = group.rotation;
  return new Matrix4().compose(new Vector3(group.position.x, group.position.y, group.position.z), new Quaternion().setFromEuler(new Euler(r.rotationX, r.rotationY, r.rotationZ)), new Vector3(group.scale, group.scale, group.scale));
}
/** Keep rendered parts in world coordinates, so existing object IDs and animation tracks remain valid. */
export function editStageAsset(scene: SceneDocument, input: StageAssetEdit) {
  const request = stageAssetEditSchema.parse(input), group = stageAssemblies(scene.objectList).find(value => value.id === request.assetId);
  if (!group) throw new Error('整体道具不存在，请重新读取场景');
  const patchKeys = ['name', 'position', 'rotation', 'scale', 'color', 'roughness', 'metalness'] as const;
  if (request.action !== 'update' && patchKeys.some(key => request[key] !== undefined)) throw new Error('复制、删除或拆开道具时不能同时修改属性');
  const next = structuredClone(scene), members = next.objectList.filter(object => object.assembly?.id === group.id);
  let assetId = group.id, objectIds = members.map(object => object.threeJsonId);
  if (request.action === 'remove') next.objectList = next.objectList.filter(object => object.assembly?.id !== group.id);
  else if (request.action === 'ungroup') members.forEach(object => { delete object.assembly; });
  else if (request.action === 'copy') {
    assetId = crypto.randomUUID();
    const suffix = ' · ' + translate('副本'), names = new Set(stageAssemblies(scene.objectList).map(group => group.name));
    let copyName = group.name.slice(0, 100 - suffix.length) + suffix, index = 2;
    while (names.has(copyName)) { const end = suffix + ' ' + index++; copyName = group.name.slice(0, 100 - end.length) + end; }
    const copies = offsetStageObjects(members.map(object => ({ ...object, threeJsonId: crypto.randomUUID(), assembly: { ...object.assembly!, id: assetId, name: copyName } })), { x: 1, y: 0, z: 0 });
    next.objectList.push(...copies); objectIds = copies.map(object => object.threeJsonId);
  } else {
    const { objectIds: _members, ...groupValue } = group;
    const updated = stageAssemblySchema.parse({ ...groupValue, ...(request.name !== undefined ? { name: request.name } : {}), ...(request.position ? { position: request.position } : {}), ...(request.rotation ? { rotation: request.rotation } : {}), ...(request.scale !== undefined ? { scale: request.scale } : {}) });
    const translationOnly = JSON.stringify(group.rotation) === JSON.stringify(updated.rotation) && group.scale === updated.scale;
    const delta = matrix(updated).multiply(matrix(group).invert());
    for (const object of members) {
      if (translationOnly) object.position = { x: object.position.x + (updated.position.x - group.position.x), y: object.position.y + (updated.position.y - group.position.y), z: object.position.z + (updated.position.z - group.position.z) };
      else {
        const r = object.rotation ?? { rotationX: 0, rotationY: 0, rotationZ: 0 }, s = object.scale ?? { scaleX: 1, scaleY: 1, scaleZ: 1 };
        const value = new Matrix4().compose(new Vector3(object.position.x, object.position.y, object.position.z), new Quaternion().setFromEuler(new Euler(r.rotationX, r.rotationY, r.rotationZ)), new Vector3(s.scaleX, s.scaleY, s.scaleZ));
        const position = new Vector3(), rotation = new Quaternion(), scale = new Vector3();
        value.premultiply(delta).decompose(position, rotation, scale); const euler = new Euler().setFromQuaternion(rotation);
        object.position = { x: position.x, y: position.y, z: position.z };
        object.rotation = { rotationX: euler.x, rotationY: euler.y, rotationZ: euler.z };
        object.scale = { scaleX: scale.x, scaleY: scale.y, scaleZ: scale.z };
      }
      object.assembly = structuredClone(updated);
      if (request.color !== undefined) object.material.color = request.color;
      if (request.roughness !== undefined) object.material.roughness = request.roughness;
      if (request.metalness !== undefined) object.material.metalness = request.metalness;
    }
  }
  return { scene: sceneSchema.parse(next), assetId, objectIds, action: request.action, changed: JSON.stringify(scene) !== JSON.stringify(next) };
}
export function assemblyObjectPatch(id: string, patch: ObjectPatch): StageAssetEdit {
  return { assetId: id, action: 'update', name: patch.name || undefined, position: patch.position, rotation: patch.rotation, scale: patch.scale.scaleX,
    ...(patch.assemblyColor ? { color: patch.color } : {}), ...(patch.assemblyMaterial ? { roughness: patch.roughness, metalness: patch.metalness } : {}) };
}
export function removeStageObject(scene: SceneDocument, id: string) {
  if (stageAssemblies(scene.objectList).some(group => group.id === id)) return editStageAsset(scene, { assetId: id, action: 'remove' }).scene;
  return { ...scene, objectList: scene.objectList.filter(object => object.threeJsonId !== id) };
}
