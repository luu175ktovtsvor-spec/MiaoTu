import { Color, GridHelper, Mesh, MeshBasicMaterial, ShadowMaterial } from 'three';
import type { SceneRuntime } from 'threejson/core';
import { createCameraTargetResolver } from './cameraTracking';
import { applyCamera } from './motion';
import { applySceneSettings as applyBaseSettings, createStage as createBaseStage, type LightingSettings, type SceneDocument, type SceneSettings } from './scene';

export const defaultStageSettings: SceneSettings = { gridVisible: true, skyVisible: false, groundVisible: true, groundColor: '#121214', labelsVisible: true };
export function sceneBackground(document: SceneDocument, settings: Partial<SceneSettings>) {
  return settings.backgroundColor ?? (document.sceneConfig.scene.background.toLowerCase() === '#202024' ? '#060608' : document.sceneConfig.scene.background);
}
/** The earlier navy default reads as the current neutral one; explicit choices are kept. */
export function stageGroundColor(settings: Partial<SceneSettings>) {
  return !settings.groundColor || settings.groundColor.toLowerCase() === '#11131b' ? '#121214' : settings.groundColor;
}
const documents = new WeakMap<SceneRuntime, SceneDocument>();

function stageGrid() {
  const grid = new GridHelper(80, 80, 0x3c3c41, 0x29292d);
  grid.userData.directorGrid = true;
  for (const material of Array.isArray(grid.material) ? grid.material : [grid.material]) {
    material.transparent = true; material.opacity = 0.55; material.depthWrite = false;
    material.onBeforeCompile = shader => {
      shader.vertexShader = 'varying vec3 vStageGridPosition;\n' + shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvStageGridPosition = (modelMatrix * vec4(position, 1.0)).xyz;');
      shader.fragmentShader = 'varying vec3 vStageGridPosition;\n' + shader.fragmentShader.replace('#include <opaque_fragment>', '#include <opaque_fragment>\ngl_FragColor.a *= 1.0 - smoothstep(12.0, 38.0, length(vStageGridPosition.xz - cameraPosition.xz));');
    };
  }
  return grid;
}
/** One stage appearance for the editor, visual inspections and exported frames. */
export async function applySceneSettings(runtime: SceneRuntime, supplied: SceneSettings) {
  const document = documents.get(runtime), settings = { ...defaultStageSettings, ...supplied };
  const backgroundColor = document ? sceneBackground(document, settings) : settings.backgroundColor ?? '#060608';
  await applyBaseSettings(runtime, { ...settings, backgroundColor });
  const ground = runtime.scene.getObjectByName('directorGround') as Mesh | undefined;
  if (ground) {
    if (!(ground.material instanceof MeshBasicMaterial)) {
      (Array.isArray(ground.material) ? ground.material : [ground.material]).forEach(material => material.dispose());
      ground.material = new MeshBasicMaterial({ color: stageGroundColor(settings) });
    }
    ground.visible = settings.groundVisible ?? true;
    const material = ground.material as MeshBasicMaterial, opacity = Math.min(1, Math.max(0, settings.groundOpacity ?? 1));
    material.color.set(stageGroundColor(settings));
    if (material.transparent !== opacity < 1) { material.transparent = opacity < 1; material.needsUpdate = true; }
    material.opacity = opacity; material.depthWrite = opacity >= 1;
  }
  const shadow = runtime.scene.children.find(object => object instanceof Mesh && object.material instanceof ShadowMaterial);
  if (shadow) { shadow.visible = settings.groundVisible ?? true; shadow.position.y = (settings.groundHeight ?? -0.015) + 0.005; }
  let grid = runtime.scene.children.find(object => object instanceof GridHelper && object.userData.directorGrid) as GridHelper | undefined;
  if (!grid) {
    for (const object of [...runtime.scene.children]) if (object instanceof GridHelper) { runtime.scene.remove(object); object.dispose(); }
    grid = stageGrid(); runtime.scene.add(grid);
  }
  grid.visible = settings.gridVisible;
  grid.position.y = (settings.groundHeight ?? -0.015) + 0.008;
  runtime.invalidate();
}
export async function createStage(canvas: HTMLCanvasElement, document: SceneDocument, beforeFrame?: () => void, aspect = 16 / 9, lighting?: LightingSettings, settings: SceneSettings = defaultStageSettings) {
  const merged = { ...defaultStageSettings, ...settings };
  const runtime = await createBaseStage(canvas, document, beforeFrame, aspect, lighting, merged);
  documents.set(runtime, document);
  try { runtime.camera.userData.directorResolveTarget=createCameraTargetResolver(runtime); applyCamera(runtime.camera, document.sceneConfig); await applySceneSettings(runtime, merged); return runtime; }
  catch (error) { runtime.dispose(); runtime.renderer.forceContextLoss(); throw error; }
}
