import { useNode } from '@vue-flow/core';
import { onScopeDispose } from 'vue';
import { translate } from '@miaoimg/i18n/vue';
import { nodeTools, z, useNodeAi } from '@miaoimg/nodes-scaffold/runtime';
import { buildLightingPrompt, lightingPresets, readLightingSettings } from './imageLighting';
import { buildMultiAnglePrompt, multiAnglePresets, readMultiAngleSettings } from './imageMultiAngle';
import { buildPanoramaPrompt } from './imagePanorama';
import { useImageVariationNode } from './useImageVariationNode';
import { imagePresets } from './imagePresets';

// The same settings readers, prompt builders and node creator used by the image panels.
export function useImageTools(available: () => boolean) {
  const { node } = useNode();
  const ai = useNodeAi();
  const createVariation = useImageVariationNode();
  let disposed = false;
  onScopeDispose(() => { disposed = true; });
  const settingsSchema = z.strictObject({
    azimuth: z.number().finite().min(-180).max(180).optional(), elevation: z.number().finite().min(-90).max(90).optional(),
    distance: z.number().finite().min(2).max(10).optional(), lens: z.enum(['standard', 'wide']).optional(), viewMode: z.enum(['orbit','camera']).optional(),
    brightness: z.number().finite().min(0).max(100).optional(), lightColor: z.string().regex(/^#[a-f0-9]{6}$/i).optional(),
    rimLight: z.boolean().optional(), rimAzimuth: z.number().finite().min(-180).max(180).optional(), rimElevation: z.number().finite().min(-90).max(90).optional(),
    rimBrightness: z.number().finite().min(0).max(100).optional(), rimColor: z.string().regex(/^#[a-f0-9]{6}$/i).optional(),
    preset: z.enum(['film','blue','portrait','neon','sunset','noir','golden','steel']).optional(), smartMode: z.boolean().optional(), smartDesc: z.string().max(4000).optional(),
  });
  nodeTools.register({
    name: 'getImageTools', description: '读取图片打光、多角度与全景的当前设置、预设和真实图片模型能力；仅查询，不发起生成。', parameters: z.strictObject({}),
    async execute() { return { lighting: readLightingSettings(node.data.lighting), angle: readMultiAngleSettings(node.data.multiAngle), lightingPresets, anglePresets: multiAnglePresets, models: (await ai.getMediaModels()).filter(model => model.type === 'image') }; },
  });
  nodeTools.register({
    name: 'prepareImageVariation',
    description: '按与界面相同的打光、多角度或全景设置创建图片生成节点并连接原图。kind=lighting/angle/sphere/cylinder；只准备节点与提示词，不提交图片模型请求。模型与输出参数先查 getImageTools，再对新节点读取 getNodeTools，用户授权后才调用 generateImage。',
    parameters: z.strictObject({ kind: z.enum(['lighting','angle','sphere','cylinder']), settings: settingsSchema.optional(), providerId: z.string().min(1), modelId: z.string().min(1), size: z.string().optional(), ratio: z.string().optional() }),
    async execute(args, { signal }) {
      const source = JSON.stringify(node.data.outputs?.image);
      const assertAvailable = () => {
        if (disposed || !available() || JSON.stringify(node.data.outputs?.image) !== source) throw new Error(translate('原图片已变化或正在处理，请重新操作'));
      };
      if (!available()) throw new Error('请先设置有效原图，等待当前处理完成');
      const models = await ai.getMediaModels(); signal?.throwIfAborted();
      assertAvailable();
      const choice = models.find(model => model.type === 'image' && model.providerId === args.providerId && model.modelId === args.modelId);
      if (!choice) throw new Error('请选择 getImageTools 返回的图片模型');
      const sizes = choice.imageSizes || [];
      const ratios = choice.imageRatios || [];
      const size = args.size ?? sizes[0];
      const ratio = args.kind === 'sphere' ? '2:1' : args.kind === 'cylinder' ? '4:1' : args.ratio ?? ratios[0];
      if (!size || !sizes.includes(size) || !ratio || !ratios.includes(ratio)) throw new Error('当前模型不支持指定输出尺寸或比例');
      let prompt: string;
      if (args.kind === 'lighting') {
        const preset = lightingPresets.find(item => item.id === args.settings?.preset);
        const settings = readLightingSettings({ ...readLightingSettings(node.data.lighting), ...preset?.settings, ...args.settings, model: JSON.stringify([choice.providerId, choice.modelId]), size, ratio });
        node.data.lighting = settings; prompt = buildLightingPrompt(settings);
      } else if (args.kind === 'angle') {
        if (args.settings?.elevation !== undefined && Math.abs(args.settings.elevation) > 80) throw new Error('多角度俯仰范围为 -80 到 80 度');
        const settings = readMultiAngleSettings({ ...readMultiAngleSettings(node.data.multiAngle), ...args.settings, model: JSON.stringify([choice.providerId, choice.modelId]), size, ratio });
        node.data.multiAngle = settings; prompt = buildMultiAnglePrompt(settings);
      } else prompt = buildPanoramaPrompt(args.kind);
      const label = { lighting: '打光', angle: '多角度', sphere: '720°全景图', cylinder: '360°环绕图' }[args.kind];
      const result = await createVariation({ label, prompt, model: JSON.stringify([choice.providerId, choice.modelId]), size, ratio }, signal, assertAvailable);
      return { ...result, prepared: true, generationStarted: false };
    },
  });
  // 与图片工具栏「快捷预设」同一份预设和同一个建节点流程：只预填提示词并连好原图，不生成。
  nodeTools.register({
    name: 'listImagePresets', description: '列出图片快捷预设（角色三视图、剧情推演四宫格等）的 id、名称、提示词与建议比例；仅查询。', parameters: z.strictObject({}),
    execute() { return { presets: imagePresets.map(preset => ({ id: preset.id, label: translate(preset.label), prompt: translate(preset.prompt), ratio: preset.ratio ?? null })) }; },
  });
  nodeTools.register({
    name: 'applyImagePreset',
    description: '按快捷预设新建一个图片生成节点并连接当前图片，提示词已填好；不提交图片模型请求。省略模型时新节点按目录默认图片模型，预设比例只在该模型支持时使用。返回新节点 ID，用户授权后再对新节点调用 generateImage。',
    parameters: z.strictObject({ presetId: z.enum(imagePresets.map(preset => preset.id) as [string, ...string[]]), providerId: z.string().min(1).optional(), modelId: z.string().min(1).optional() })
      .refine(args => (args.providerId === undefined) === (args.modelId === undefined), 'providerId 与 modelId 必须同时提供'),
    async execute(args, { signal }) {
      if (!available()) throw new Error('请先设置有效原图，等待当前处理完成');
      const preset = imagePresets.find(item => item.id === args.presetId)!;
      const images = (await ai.getMediaModels()).filter(model => model.type === 'image'); signal?.throwIfAborted();
      const choice = args.modelId === undefined ? images[0] : images.find(model => model.providerId === args.providerId && model.modelId === args.modelId);
      if (!choice) throw new Error('请选择 getImageTools 返回的图片模型');
      const ratio = preset.ratio && (choice.imageRatios || []).includes(preset.ratio) ? preset.ratio : '';
      const model = args.modelId === undefined ? '' : JSON.stringify([choice.providerId, choice.modelId]);
      const result = await createVariation({ label: translate(preset.label), prompt: translate(preset.prompt), model, size: '', ratio }, signal, () => { if (disposed || !available()) throw new Error(translate('原图片已变化或正在处理，请重新操作')); });
      return { ...result, presetId: preset.id, ratio: ratio || null, prepared: true, generationStarted: false };
    },
  });
}
