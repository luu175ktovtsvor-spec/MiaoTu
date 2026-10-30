// 节点模型基础字段与可选媒体能力。接口允许服务端增加扩展字段。
import type { MediaModel } from "@miaoimg/tools-scaffold/runtime";
import type { CatalogControl, ParameterRules } from "./mediaParameters";

export type NodeAiModel = {
  providerId: string;
  providerLabel: string;
  modelId: string;
  label: string;
  protocol: "openai-completions" | "openai-responses" | "anthropic-messages" | "local-web";
  supportsTools?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
};

// 基础模型声明。
export type BaseNodeMediaModel = Omit<MediaModel, "mode"> & {
  mode?: (string | string[])[];
};

// 图片、视频节点使用的可选能力。
export interface NodeMediaModelExtensions {
  pricingNotice?: string;
  maxReferences?: number;
  // 本机豆包/Dola 先展示已核对的预置，账号菜单返回后覆盖并标记来源。
  parameterSource?: 'preset' | 'account';
  parameterPreset?: { durations?: number[]; defaultDuration?: number; resolutions?: string[]; ratios?: string[]; imageSizeTiers?: string[] };
  connected?: boolean;
  customSize?: boolean;
  sizeRule?: { minPixels: number; maxPixels: number; minRatio: number; maxRatio: number; multipleOf?: number; maxEdge?: number } | null;
  // 尺寸表带 value / ratio 对照：节点按比例挑尺寸（pickSize）要用。
  sizes?: { value: string; label?: string; ratio?: string }[];
  formats?: string[];
  quality?: string[];
  inputFidelity?: string[];
  supportsEdit?: boolean;
  supportsTransparent?: boolean;
  transparentInput?: "any-image" | "alpha-png" | null;
  // Reference purposes are compiled into the existing image prompt, not sent
  // as invented vendor-native request fields.
  referenceRoles?: { value: string; label: string }[];
  supportsLayerDecomposition?: boolean;
  // 区域编辑通道：mask = 传透明蒙版（GPT 图片编辑），annotation = 传归一化标注框（Seedream 5.0）。
  // 为空表示该模型没有区域编辑通道，画布不给局部重绘入口。
  regionEdit?: "mask" | "annotation" | null;
  optimizePromptModes?: string[];
  maxCount?: number;
  maxCombinedImages?: number;
  ratios?: string[];
  durations?: number[];
  defaultDuration?: number;
  keyframes?: number;
  // 参考生视频可选的预设声音（voice_id）与数量上限。
  referenceVoices?: string[];
  maxReferenceVoices?: number;
  // 图片模型的每张积分（前端只展示积分，不展示任何价格）。
  // 豆包按像素分两档计价，所以还要给出「每个尺寸对应多少积分」的映射。
  creditsPerImage?: number;
  creditsPerImageBySize?: Record<string, number> | null;
  // 每个视频模型的分辨率单价（积分/秒）与最低积分，画布用它显示预计消耗。
  creditsPerSecond?: Record<string, number>;
  minimumCredits?: number;
  // 方舟 Seedance 成功后按查询返回的 token 用量对账；其它通道使用参数/套餐预估。
  billingMode?: "upstream_usage" | "parameter_estimate";
  // 输入素材计费规则（秘塔 H3：参考视频按输入时长计费、图片超出免费张数按张计费）。
  inputPricing?: { billReferenceVideoSeconds?: boolean; inputCreditsPerSecond?: Record<string, number>; outputCreditsPerSecondWithVideo?: Record<string, number>; freeReferenceImages?: number; extraImageCredits?: number } | null;
  referenceLimits?: { image?: number; video?: number; audio?: number; frames?: number };
  referenceInputs?: Record<string, { mimes?: string[]; formats?: string[]; maxBytes?: number; minDuration?: number; maxDuration?: number; minEdge?: number; maxEdge?: number }>;
  maxDurationByMode?: Record<string, number>;
  parameterRules?: ParameterRules;
  controls?: CatalogControl[];
  layerSizes?: string[];
}

// 节点使用基础声明和媒体扩展的组合。
export type NodeMediaModel = BaseNodeMediaModel & NodeMediaModelExtensions;
