import { z, type NodeAiTool } from '@miaoimg/nodes-scaffold/runtime';
import { aspectRatios } from './cameraPresets';
import { lightingPresets } from './stageLibrary';
import type { LightingSettings, SceneSettings } from './scene';

export interface StageState { lighting: LightingSettings; settings: SceneSettings; aspectRatio: string }
const color = z.string().regex(/^#[\da-f]{6}$/i);
export const stageEditSchema = z.strictObject({
  lightingPreset: z.enum(lightingPresets.map(preset => preset.name) as [string, ...string[]]).optional(),
  lighting: z.strictObject({ globalEnabled: z.boolean().optional(), globalIntensity: z.number().min(0).max(100).optional(), sunEnabled: z.boolean().optional(), azimuth: z.number().min(0).max(360).optional(), elevation: z.number().min(-90).max(90).optional(), color: color.optional(), intensity: z.number().min(0).max(100).optional() }).optional(),
  settings: z.strictObject({ backgroundColor: color.optional(), skyVisible: z.boolean().optional(), groundVisible: z.boolean().optional(), groundColor: color.optional(), groundHeight: z.number().min(-100).max(100).optional(), groundOpacity: z.number().min(0).max(1).optional(), gridVisible: z.boolean().optional(), labelsVisible: z.boolean().optional(), panoramaRotation: z.number().min(-360).max(360).optional() }).optional(),
  aspectRatio: z.enum(aspectRatios).optional(),
});
export const stageAspect = (ratio: string) => { const [width, height] = ratio.split(':').map(Number) as [number, number]; return width / height; };

/** Lighting, environment and frame shape for one assistant turn; held privately and applied together with the result. */
export function createStageDraft(initial: StageState, editable: boolean) {
  let current: StageState = structuredClone(initial), revision = 0;
  const original = JSON.stringify(current);
  const summary = () => ({ ...structuredClone(current), presets: lightingPresets.map(({ name, settings }) => ({ name, settings })), aspectRatios });
  const tools: NodeAiTool[] = [{
    name: 'readStage', description: '读取导演台的灯光、环境（天空颜色、地面显隐/颜色/高度/透明度、网格、角色标签、全景旋转）与画面比例，以及可用的灯光预设和比例。这些设置所有方案共用，不在 scene 文档里；scene.sceneConfig.lights 会被这里的灯光覆盖，不要改它来调光。',
    parameters: z.toJSONSchema(z.strictObject({})), execute(_args, signal) { signal?.throwIfAborted(); return summary(); },
  }];
  if (editable) tools.push({
    name: 'editStage', description: '修改本轮私有的灯光、环境或画面比例草稿，最终随结果一起应用。lightingPreset 先套用预设（日光、黄金时刻、月光、柔光），再叠加 lighting 字段；azimuth 0–360 度为太阳水平方位，elevation 为高度角，intensity 为太阳光强度，globalIntensity 为无阴影环境光。settings.backgroundColor 为天空颜色（会关闭天空盒），groundOpacity 0–1。aspectRatio 改变预览和导出比例。修改后必须 inspectDocument 回看。',
    parameters: z.toJSONSchema(stageEditSchema),
    execute(args, signal) {
      signal?.throwIfAborted();
      const edit = stageEditSchema.parse(args), preset = lightingPresets.find(item => item.name === edit.lightingPreset);
      const next: StageState = {
        lighting: { ...current.lighting, ...(preset ? { ...preset.settings, globalEnabled: true, sunEnabled: true } : {}), ...edit.lighting },
        settings: { ...current.settings, ...edit.settings, ...(edit.settings?.backgroundColor ? { skyVisible: false } : {}) },
        aspectRatio: edit.aspectRatio ?? current.aspectRatio,
      };
      if (JSON.stringify(next) !== JSON.stringify(current)) { current = next; revision++; }
      return { changed: JSON.stringify(current) !== original, ...summary() };
    },
  });
  return {
    tools,
    raw: () => structuredClone(current),
    get aspect() { return stageAspect(current.aspectRatio); },
    get revision() { return revision; },
    get changed() { return JSON.stringify(current) !== original; },
    checkpoint: () => ({ current: structuredClone(current), revision }),
    restore(checkpoint: { current: StageState; revision: number }) { current = structuredClone(checkpoint.current); revision = checkpoint.revision; },
  };
}
