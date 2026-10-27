/**
 * MiaoImg's public model catalog.
 *
 * The catalog describes capabilities that are safe to expose in the UI. Keys
 * and upstream URLs stay server-side; the browser only receives model IDs and
 * the controls each model can actually honor.
 */

import { runtimeSecret } from './runtime-secrets.ts'
import { referenceInputPolicy } from './reference-input-contract.ts'
import { suiheCapability, suiheModelId, suiheModelOverlay, SUIHE_MODEL_IDS } from './suihe-catalog.ts'

const COMMON_SIZES = [
  { value: 'auto', label: '自动', ratio: 'auto', detail: '让模型判断方向' },
  { value: '1024x1024', label: '方图', ratio: '1:1', detail: '头像、商品图' },
  { value: '1536x1024', label: '横图', ratio: '3:2', detail: '风景、产品图' },
  { value: '1024x1536', label: '竖图', ratio: '2:3', detail: '海报、长图' },
]

const GPT2_SIZES = [
  ...COMMON_SIZES,
  { value: '2048x2048', label: '高清方图', ratio: '1:1', detail: '商品主图' },
  { value: '2048x1152', label: '横屏', ratio: '16:9', detail: '视频封面、横幅' },
  { value: '2160x3840', label: '手机全屏', ratio: '9:16', detail: '手机壁纸、短视频' },
  { value: '3840x2160', label: '4K 横屏', ratio: '16:9', detail: '宽屏视频封面' },
]

// xAI Image Generation, 2026-10-08. Resolution and aspect ratio are independent.
// Omitted aspect_ratio means auto; omitted resolution means 1k.
const GROK_IMAGE_SIZES = [
  { value: '1k', label: '1k', ratio: '', detail: '默认清晰度' },
  { value: '2k', label: '2k', ratio: '', detail: '更高清晰度' },
]
const GROK_IMAGE_RATIOS = ['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '2:1', '1:2', '19.5:9', '9:19.5', '20:9', '9:20', '21:9', '5:2']
// OpenAI image guide: edges are multiples of 16, ratio 1:3–3:1, edge ≤3840, pixels 655360–8294400.
const GPT_SIZE_RULE = Object.freeze({ minPixels: 655_360, maxPixels: 8_294_400, minRatio: 1 / 3, maxRatio: 3, multipleOf: 16, maxEdge: 3840 })
// Seedream 5.0: 1K/1.5K/2K or any pixels in 921600–4624220, ratio 1/16–16.
const SEEDREAM5_SIZE_RULE = Object.freeze({ minPixels: 921_600, maxPixels: 4_624_220, minRatio: 1 / 16, maxRatio: 16 })
// Seedream 4.0 custom pixels stay inside its own documented range, not the 5.0 cap.
const SEEDREAM4_SIZE_RULE = Object.freeze({ minPixels: 921_600, maxPixels: 16_777_216, minRatio: 1 / 16, maxRatio: 16 })

// Seedream 5.0 pro / flash 官方图片 API（2026-09-22）：size 支持分辨率档位（1K / 1.5K / 2K，
// 默认 2K；1.5K 与 1K 同价）或宽高像素值（总像素 921600–4624220、比例 1/16–16）。
// 下面是档位 + 1.5K/2K 常用像素档，输出格式官方只支持 png / jpeg。
const SEEDREAM_SIZES = [
  { value: '1K', label: '1K 智能', ratio: 'auto', detail: '模型按描述定尺寸' },
  { value: '1.5K', label: '1.5K 智能', ratio: 'auto', detail: '与 1K 同价 · 更清晰' },
  { value: '2K', label: '2K 智能', ratio: 'auto', detail: '模型按描述定尺寸' },
  { value: '1536x1536', label: '1.5K 方形', ratio: '1:1', detail: '头像 · 商品卡 · 社媒方图' },
  { value: '2048x1152', label: '1.5K 横屏', ratio: '16:9', detail: 'YouTube · 网页横幅 · PPT' },
  { value: '1152x2048', label: '1.5K 竖屏', ratio: '9:16', detail: '抖音 · TikTok · Shorts · 故事' },
  { value: '1872x1248', label: '1.5K 摄影横图', ratio: '3:2', detail: '风景 · 产品 · 相机照片' },
  { value: '1344x1792', label: '1.5K 人物竖图', ratio: '3:4', detail: '小红书 · 人物 · 封面' },
  { value: '2048x2048', label: '2K 方形', ratio: '1:1', detail: '头像 · 商品卡 · 社媒方图' },
  { value: '2816x1584', label: '横屏宽幅', ratio: '16:9', detail: 'YouTube · 网页横幅 · PPT' },
  { value: '1584x2816', label: '手机全屏', ratio: '9:16', detail: '抖音 · TikTok · Shorts · 故事' },
  { value: '2496x1664', label: '摄影横图', ratio: '3:2', detail: '风景 · 产品 · 相机照片' },
  { value: '1776x2368', label: '人物竖图', ratio: '3:4', detail: '小红书 · 人物 · 封面' },
]

// Seedream 4.0 accepts explicit pixel dimensions inside a documented pixel
// and ratio range, so expose the useful 4:3 and 2:3 presets instead of
// pretending it has the narrower fixed-size catalog used by other models.
const SEEDREAM4_SIZES = [
  { value: '2048x2048', label: '2K 方形', ratio: '1:1', detail: '头像 · 商品卡 · 社媒方图' },
  { value: '2304x1728', label: '传统横图', ratio: '4:3', detail: '电商详情 · 传统照片 · 产品图' },
  { value: '2848x1600', label: '横屏宽幅', ratio: '16:9', detail: 'YouTube · 网页横幅 · PPT' },
  { value: '2496x1664', label: '摄影横图', ratio: '3:2', detail: '风景 · 产品 · 相机照片' },
  { value: '1728x2304', label: '人物竖图', ratio: '3:4', detail: '小红书 · 人物 · 封面' },
  { value: '1664x2496', label: '竖版海报', ratio: '2:3', detail: '海报 · 印刷 · 电商长图' },
  { value: '1600x2848', label: '手机全屏', ratio: '9:16', detail: '抖音 · TikTok · Shorts · 故事' },
  // 官方图片 API 的 4K 档映射值（Seedream 4.0 按张计价，4K 与 2K 同价）。
  { value: '4096x4096', label: '4K 方形', ratio: '1:1', detail: '大幅印刷 · 高清素材' },
  { value: '4704x3520', label: '4K 传统横图', ratio: '4:3', detail: '电商详情 · 高清产品图' },
  { value: '5504x3040', label: '4K 横屏宽幅', ratio: '16:9', detail: '大屏 · 高清横幅' },
  { value: '4992x3328', label: '4K 摄影横图', ratio: '3:2', detail: '风景 · 高清照片' },
  { value: '3520x4704', label: '4K 人物竖图', ratio: '3:4', detail: '人物 · 高清封面' },
  { value: '3328x4992', label: '4K 竖版海报', ratio: '2:3', detail: '海报 · 印刷' },
  { value: '3040x5504', label: '4K 手机全屏', ratio: '9:16', detail: '高清壁纸 · 竖屏' },
]

// Official Lite/4.5 require at least 2K (3,686,400 pixels).
const SEEDREAM_LITE_SIZE_RULE = Object.freeze({ ...SEEDREAM4_SIZE_RULE, minPixels: 3_686_400 })
const SEEDREAM_LITE_SIZES = [
  { value: '2K', label: '2K', ratio: 'auto' },
  { value: '3K', label: '3K', ratio: 'auto' },
  { value: '4K', label: '4K', ratio: 'auto' },
  ...SEEDREAM4_SIZES,
]

const IMAGE_CATALOG = [
  {
    id: 'gpt-image-2', label: 'GPT Image 2', provider: 'yunshu',
    note: '输入保真度高', sizes: GPT2_SIZES, customSize: true, sizeRule: GPT_SIZE_RULE, quality: ['low', 'medium', 'high'],
    formats: ['png', 'jpeg', 'webp'], maxReferences: 8, maxCount: 4, supportsEdit: true, supportsTransparent: true,
  },
  {
    id: 'gpt-image-2.5-sunburst', label: 'GPT Image 2.5 Sunburst', provider: 'yunshu',
    note: '编辑精度优先', sizes: GPT2_SIZES, customSize: true, sizeRule: GPT_SIZE_RULE, quality: ['low', 'medium', 'high', 'xhigh', 'max'],
    formats: ['png', 'jpeg', 'webp'], maxReferences: 8, maxCount: 4, supportsEdit: true, supportsTransparent: true,
  },
  {
    id: 'gpt-image-2.5-flare', label: 'GPT Image 2.5 Flare', provider: 'yunshu',
    note: '速度和质量平衡', sizes: GPT2_SIZES, customSize: true, sizeRule: GPT_SIZE_RULE, quality: ['low', 'medium', 'high', 'xhigh', 'max'],
    formats: ['png', 'jpeg', 'webp'], maxReferences: 8, maxCount: 4, supportsEdit: true, supportsTransparent: true,
  },
  {
    // xAI image generation (docs.x.ai, 2026-10-08): aspect_ratio is its own
    // field, resolution is 1k or 2k, and pixel size strings are not accepted.
    // Quality exists only on 2.0. Multi-image edit accepts up to 5 source images.
    id: 'grok-imagine-image', label: 'Grok Imagine Image', provider: 'grok',
    note: '1k/2k · 官方画面比例', sizes: GROK_IMAGE_SIZES, ratios: GROK_IMAGE_RATIOS, quality: [],
    formats: ['auto'], maxReferences: 5, maxCount: 10, supportsEdit: true, supportsTransparent: false,
  },
  {
    id: 'grok-imagine-image-2.0', label: 'Grok Imagine Image 2.0', provider: 'grok',
    note: '1k/2k · 质量 auto/low/medium', sizes: GROK_IMAGE_SIZES, ratios: GROK_IMAGE_RATIOS, quality: ['auto', 'low', 'medium'],
    formats: ['auto'], maxReferences: 5, maxCount: 10, supportsEdit: true, supportsTransparent: false,
  },
  {
    id: 'doubao-seedream-5-0-pro-260628', publicId: 'doubao-seedream-5-0-pro', label: 'Seedream 5.0 Pro', provider: 'ark',
    note: '细节优先 · 支持 1K/1.5K/2K', sizes: SEEDREAM_SIZES, customSize: true, sizeRule: SEEDREAM5_SIZE_RULE, quality: [], formats: ['png', 'jpeg'],
    maxReferences: 10, maxCount: 1, supportsEdit: true, supportsTransparent: true,
    supportsLayerDecomposition: true, optimizePromptModes: ['standard', 'fast'],
    layerSizes: ['1K', '1.5K', '2K', 'auto'],
  },
  {
    id: 'doubao-seedream-5-0-flash-260915', publicId: 'doubao-seedream-5-0-flash', label: 'Seedream 5.0 Flash', provider: 'ark', internalOnly: true,
    note: '速度优先 · 支持 1K/1.5K/2K', sizes: SEEDREAM_SIZES, customSize: true, sizeRule: SEEDREAM5_SIZE_RULE, quality: [], formats: ['png', 'jpeg'],
    maxReferences: 10, maxCount: 1, supportsEdit: true, supportsTransparent: true,
    supportsLayerDecomposition: true, optimizePromptModes: ['standard'],
    layerSizes: ['1K', '1.5K', '2K', 'auto'],
  },
  {
    id: 'doubao-seedream-5-0-260128', publicId: 'seedream-5.0-lite', label: 'Seedream 5.0 Lite', provider: 'ark',
    note: '支持多图和组图', sizes: SEEDREAM_LITE_SIZES, customSize: true, sizeRule: SEEDREAM_LITE_SIZE_RULE,
    quality: [], formats: ['jpeg', 'png'], maxReferences: 14, maxCount: 15, maxCombinedImages: 15,
    supportsEdit: true, supportsTransparent: false,
  },
  {
    id: 'doubao-seedream-4-5-251128', publicId: 'seedream-4.5', label: 'Seedream 4.5', provider: 'ark',
    note: '支持多图和组图', sizes: SEEDREAM_LITE_SIZES.filter(size => size.value !== '3K'), customSize: true, sizeRule: SEEDREAM_LITE_SIZE_RULE,
    quality: [], formats: ['jpeg'], maxReferences: 14, maxCount: 15, maxCombinedImages: 15,
    supportsEdit: true, supportsTransparent: false,
  },
  {
    id: 'doubao-seedream-4-0-20260415', publicId: 'doubao-seedream-4-0', label: 'Seedream 4.0', provider: 'ark',
    note: '支持多图和自定义尺寸', sizes: SEEDREAM4_SIZES, customSize: true, sizeRule: SEEDREAM4_SIZE_RULE, quality: [], formats: ['jpeg'],
    // 官方图片 API：多图生图 2–14 张参考；组图模式（sequential_image_generation=auto）
    // 最多 15 张，且「参考图数量 + 生成张数 ≤ 15」。
    maxReferences: 14, maxCount: 15, maxCombinedImages: 15, supportsEdit: true, supportsTransparent: false,
  },
]

// 火山方舟 Seedance 视频：与豆包生图共用 ARK Key，走 /contents/generations/tasks。
// mini / fast 只开放 480p 与 720p；时长与宽高比由方舟侧校验，本地不再额外收窄。
const SEEDANCE_SIZES = [
  { value: '480p', label: '480p', ratio: '16:9', detail: '轻量视频' },
  { value: '720p', label: '720p', ratio: '16:9', detail: '标准视频' },
]

// 秘塔（metaso.cn）视频：走 MiniMax 兼容协议，参数与火山不同。
// H3 时长 4–30 秒（2K 最长 15 秒），分辨率 480p/768P/1080p/2K，
// 画幅含 21:9/16:9/4:3/1:1/3:4/9:16。
const METASO_H3_SIZES = [
  { value: '480p', label: '480p', ratio: '16:9', detail: '轻量视频' },
  { value: '768P', label: '768P', ratio: '16:9', detail: '标准清晰' },
  { value: '1080p', label: '1080p', ratio: '16:9', detail: '全高清' },
  { value: '2K', label: '2K', ratio: '16:9', detail: '原生高清' },
]
const METASO_H3_RATIOS = ['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16']
// 秘塔 Seedance 2.0 / Mini 与 H3 共用 MiniMax 兼容协议（/api/minimax/v2/video_generation）：
// resolution 传 480p/720p（标准版另有 1080p/4K），画面比例单独传 ratio，时长 4–15 整数秒。
const METASO_SEEDANCE_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']
const METASO_SEEDANCE_MINI_SIZES = [
  { value: '480p', label: '480p', ratio: '16:9', detail: '轻量视频' },
  { value: '720p', label: '720p', ratio: '16:9', detail: '标准视频' },
]
const METASO_SEEDANCE_SIZES = [
  { value: '480p', label: '480p', ratio: '16:9', detail: '轻量视频' },
  { value: '720p', label: '720p', ratio: '16:9', detail: '标准视频' },
  { value: '1080p', label: '1080p', ratio: '16:9', detail: '全高清' },
  { value: '4K', label: '4K', ratio: '16:9', detail: '超清（H.265）' },
]

// xAI 官方能力表：经典版与 1.5 都是这 9 档（1:1 / 16:9 / 9:16 / 4:3 / 3:4 / 3:2 / 2:3 / 21:9 / 5:2）。
const GROK_VIDEO_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9', '5:2']
const DURATIONS_1_15 = Array.from({ length: 15 }, (_, index) => index + 1)
const GROK_VIDEO_480_720_SIZES = [
  { value: '480p', label: '480p', ratio: '16:9', detail: '轻量视频' },
  { value: '720p', label: '720p', ratio: '16:9', detail: '标准视频' },
]
// xAI Video overview, 2026-10-08: 1.5 text-to-video and image-to-video include
// native 1080p. Reference images and keyframes stay at 720p; that limit is
// enforced when the request is validated, not by hiding the resolution.
const GROK_VIDEO_1_5_SIZES = [
  ...GROK_VIDEO_480_720_SIZES,
  { value: '1080p', label: '1080p', ratio: '16:9', detail: '原生高清 · 参考图与关键帧仍为 720p' },
]

// 每个视频模型的时长、分辨率、比例、生成模式、参考素材上限和声音能力都不同，
//   - 火山方舟 Seedance 2.0 fast：4–15 秒，480p/720p，支持首/尾帧、多图参考与声音；
//   - 秘塔 MiniMax H3：480p/768P/1080p 为 4–30 秒、2K 为 4–15 秒，
//     支持首/尾帧、多图/视频/音频参考与声音；
//   - 秘塔 Seedance 2.0 / mini：4–15 秒，480p/720p（标准版另支持 1080p/4K），
//     支持首尾帧与多模态参考（图片 9 / 视频 3 / 音频 3，视频与音频各自合计不超过 15 秒）。
// 前端不展示供应商，只按模型 ID 与这些能力渲染控件。
const DURATIONS_4_15 = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]

// Mode-specific limits stay on the catalog. The canvas reads parameterRules and
// controls; it does not keep a second list keyed by model id.
// 秘塔自家前端：纯文生视频没有「自适应」；Seedance 带首尾帧固定 adaptive，H3 带首尾帧照用所选比例。
function metasoRules(ratios, extra = {}, frameRatios = ['adaptive']) {
  return {
    ratiosByMode: {
      text: ratios.filter(item => item !== 'adaptive'),
      // Mixed references are represented by an array mode, which the client
      // normalizes to `image`. Keep this explicit so Seedance's fixed-ratio
      // contract does not fall back to model.ratios and expose `adaptive`.
      image: ratios.filter(item => item !== 'adaptive'),
      singleImage: frameRatios,
      startFrameOptional: frameRatios,
      endFrameOptional: frameRatios,
      startEndRequired: frameRatios,
    },
    ...extra,
  }
}
const ARK_VIDEO_CONTROLS = [
  { key: 'returnLastFrame', label: '返回尾帧', type: 'boolean' },
  { key: 'webSearch', label: '联网搜索', type: 'boolean', modes: ['text'] },
]

const VIDEO_CATALOG = [
  {
    id: 'doubao-seedance-2-5-260628', publicId: 'seedance-2.5', label: 'Seedance 2.5', provider: 'ark', video: true,
    note: '4–30 秒 · 480p/720p/1080p · 支持声音与多素材参考',
    sizes: [...SEEDANCE_SIZES, { value:'1080p', label:'1080p', ratio:'16:9', detail:'全高清（H.265）' }],
    quality: [], formats: ['mp4'],
    ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', 'adaptive'],
    durations: [...Array.from({length:27}, (_, index) => index + 4), -1],
    modes: ['text', 'singleImage', 'endFrameOptional', 'edit', 'extend', ['imageReference:30', 'videoReference:10', 'audioReference:10']],
    audio: 'optional', referenceLimits: { image:30, video:10, audio:10, frames:2 },
    maxReferences:30, maxCount:1, supportsEdit:true, supportsTransparent:false,
    parameterRules: {
      referenceInputsByMode: { edit: { video: { minDuration: 4, maxDuration: 30 } } },
      ratiosByMode: { singleImage: ['adaptive'], endFrameOptional: ['adaptive'], edit: ['adaptive'], extend: ['adaptive'] },
      inheritByMode: { singleImage: ['ratio'], endFrameOptional: ['ratio'], edit: ['duration', 'ratio'], extend: ['ratio'] },
      hintsByMode: {
        edit: '编辑保持原视频时长与比例，参考视频需为 4–30 秒',
        singleImage: '输出比例跟随输入素材',
        endFrameOptional: '输出比例跟随输入素材',
        extend: '输出比例跟随输入素材',
      },
    },
    controls: ARK_VIDEO_CONTROLS,
  },
  {
    id: 'seedance-2.0', publicId: 'seedance-2.0', label: 'Seedance 2.0', provider: 'metaso', video: true,
    note: '4–15 秒 · 480p/720p/1080p/4K · 支持声音', sizes: METASO_SEEDANCE_SIZES, quality: [], formats: ['mp4'],
    ratios: [...METASO_SEEDANCE_RATIOS, 'adaptive'], durations: DURATIONS_4_15,
    modes: ['text', 'startFrameOptional', 'endFrameOptional', ['imageReference:9', 'videoReference:3', 'audioReference:3']],
    audio: true, referenceLimits: { image: 9, video: 3, audio: 3, frames: 2 },
    maxReferences: 9, maxCount: 1, supportsEdit: false, supportsTransparent: false,
    parameterRules: metasoRules([...METASO_SEEDANCE_RATIOS, 'adaptive'], { requireVisualInMixed: true }),
  },
  {
    id: 'doubao-seedance-2-0-fast-260128', publicId: 'seedance-2.0-fast', label: 'Seedance 2.0 Fast', provider: 'ark', video: true,
    note: '4–15 秒 · 480p/720p · 支持声音', sizes: SEEDANCE_SIZES, quality: [], formats: ['mp4'],
    // 官方能力表（Seedance 2.0 系列教程，2026-09-29）：三种模型都支持文生、首帧、首尾帧、
    // 全模态参考（图片 0–9 / 视频 0–3 / 音频 0–3）、编辑视频、延长视频、有声视频、返回尾帧。
    ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', 'adaptive'], durations: [...DURATIONS_4_15, -1],
    modes: ['text', 'singleImage', 'startFrameOptional', 'endFrameOptional', 'edit', 'extend', ['imageReference:9', 'videoReference:3', 'audioReference:3']],
    audio: 'optional', referenceLimits: { image: 9, video: 3, audio: 3, frames: 2 },
    maxReferences: 9, maxCount: 1, supportsEdit: true, supportsTransparent: false,
    parameterRules: { requireVisualInMixed: true },
    controls: ARK_VIDEO_CONTROLS,
  },
  {
    id: 'seedance-2.0-mini', publicId: 'seedance-2.0-mini', label: 'Seedance 2.0 Mini', provider: 'metaso', video: true,
    note: '4–15 秒 · 480p/720p · 支持声音', sizes: METASO_SEEDANCE_MINI_SIZES, quality: [], formats: ['mp4'],
    ratios: [...METASO_SEEDANCE_RATIOS, 'adaptive'], durations: DURATIONS_4_15,
    modes: ['text', 'startFrameOptional', 'endFrameOptional', ['imageReference:9', 'videoReference:3', 'audioReference:3']],
    audio: true, referenceLimits: { image: 9, video: 3, audio: 3, frames: 2 },
    maxReferences: 9, maxCount: 1, supportsEdit: false, supportsTransparent: false,
    parameterRules: metasoRules([...METASO_SEEDANCE_RATIOS, 'adaptive'], { requireVisualInMixed: true }),
  },
  {
    id: 'MiniMax-H3', publicId: 'MiniMax-H3', label: 'MiniMax H3', provider: 'metaso', video: true,
    note: '480p/768P/1080p：4–30 秒 · 2K：4–15 秒 · 原生有声', sizes: METASO_H3_SIZES, quality: [], formats: ['mp4'],
    ratios: METASO_H3_RATIOS, durations: [...Array.from({ length: 27 }, (_, index) => index + 4)],
    // 参考画布的 H3 模式：文生视频、首帧可选，以及多图/视频/音频混合参考（上限 9/3/3）。
    modes: ['text', 'startFrameOptional', 'endFrameOptional', ['imageReference:9', 'videoReference:3', 'audioReference:3']],
    // 秘塔 H3 协议没有声音开关：每次生成都带立体声，声音由提示词/参考音频控制，前端不提供假开关。
    audio: true, referenceLimits: { image: 9, video: 3, audio: 3, frames: 2 },
    maxDurationByResolution: { '480p': 30, '768P': 30, '1080p': 30, '2K': 15 },
    maxReferences: 9, maxCount: 1, supportsEdit: false, supportsTransparent: false,
    parameterRules: metasoRules(METASO_H3_RATIOS, { framePlusReferences: true }, METASO_H3_RATIOS),
    // 秘塔 H3 的 Context IR 默认开启（按次计费）；打开这一项就关闭它，按原始提示词生成。
    controls: [{ key: 'rawPrompt', label: '原样使用提示词', type: 'boolean' }],
  },
  {
    id: 'grok-imagine-video', label: 'Grok Imagine Video', provider: 'grok', video: true,
    note: '1–15 秒 · 480p/720p', sizes: GROK_VIDEO_480_720_SIZES, quality: [], formats: ['mp4'],
    durations: DURATIONS_1_15, ratios: GROK_VIDEO_RATIOS,
    // 官方能力表（docs.x.ai Video overview）：经典版支持文生、单图生视频（image 钉首帧）、
    // 参考图生视频（reference_images 最多 7 张）以及编辑 / 延长；**不接受 last_frame / keyframes**，
    // 且明确拒绝把 image 钉帧和 reference_images 混在同一个请求里——所以这里用两个互斥模式表达，
    // 由 validateVideoRequest 保证不会同时出现。
    modes: ['text', 'singleImage', 'edit', 'extend', ['imageReference:7']],
    // xAI generates an audio track by default; the API accepts generate_audio=false.
    audio: 'optional', referenceLimits: { image: 7, video: 0, audio: 0, frames: 0 },
    maxReferences: 7, maxCount: 1, supportsEdit: true, supportsTransparent: false,
    // 官方：经典版「参考图生成」时长上限 10 秒（文生/单图仍是 1–15 秒）。
    maxDurationByMode: { image: 10 },
    parameterRules: {
      durationByMode: { image: { max: 10 }, extend: { min: 2, max: 10 } },
      inheritByMode: { edit: ['duration', 'ratio', 'resolution'], extend: ['ratio', 'resolution'] },
      referencesByMode: {
        edit: { video: [1, 1], image: [0, 0], audio: [0, 0] },
        extend: { video: [1, 1], image: [0, 0], audio: [0, 0] },
      },
      referenceInputsByMode: {
        edit: { video: { maxDuration: 8.7 } },
        extend: { video: { minDuration: 2, maxDuration: 15 } },
      },
      audioByMode: { edit: 'hidden' },
      hintsByMode: {
        edit: '编辑跟随输入视频时长（最长 8.7 秒），比例与分辨率跟随输入，最高 720p',
        extend: '延长输入必须为 2–15 秒；所选秒数为新增片段，比例与分辨率跟随输入，最高 720p',
      },
    },
  },
  {
    id: 'grok-imagine-video-1.5', label: 'Grok Imagine Video 1.5', provider: 'grok', video: true,
    note: '1–15 秒 · 480p/720p/1080p · 最多 14 张参考图', sizes: GROK_VIDEO_1_5_SIZES, quality: [], formats: ['mp4'],
    durations: DURATIONS_1_15, ratios: GROK_VIDEO_RATIOS,
    // 官方能力表（docs.x.ai Video overview）：1.5 支持文生、单图、参考图（**最多 14 张**）、
    // 首尾帧、最多 4 个关键帧和预设声音；**不支持视频编辑与延长**（那两项只有经典版有）。
    // 上传音频文件参考需要 xAI 受信合作方权限，普通账号只有预设声音，所以这里只暴露 voice_id。
    modes: ['text', 'singleImage', 'startFrameOptional', 'endFrameOptional', ['imageReference:14']],
    audio: 'optional', referenceLimits: { image: 14, video: 0, audio: 0, frames: 2 }, keyframes: 4,
    maxReferences: 14, maxCount: 1, supportsEdit: false, supportsTransparent: false,
    parameterRules: {
      promptOptionalWithImage: true,
      resolutionsByMode: { image: ['480p', '720p'], startFrameOptional: ['480p', '720p'], endFrameOptional: ['480p', '720p'] },
    },
  },
]

const CATALOG: Array<{ id: string; label: string; provider: string } & Record<string, any>> = [...IMAGE_CATALOG, ...VIDEO_CATALOG]

const PROVIDERS = {
  suihe: { id:'suihe',label:'穗禾',description:'Seedance 视频通道；兼容既有 Seedream 图片配置',key:'SUIHE_API_KEY' },
  ark: { id: 'ark', label: '火山方舟', description: '火山引擎方舟官方接口', key: 'ARK_API_KEY' },
  metaso: { id: 'metaso', label: '秘塔', description: '秘塔 MiniMax 兼容视频接口', key: 'METASO_API_KEY' },
  yunshu: { id: 'yunshu', label: 'GPT Image', description: 'OpenAI-compatible 图片接口', key: 'YUNSHU_API_KEY' },
  grok: { id: 'grok', label: 'Grok', description: 'Yunshu Grok 图片/视频接口', key: 'GROK_API_KEY' },
}

export function modelCatalog(): Array<{ id: string; label: string; provider: string; sizes: any; publicId?: string }> {
  return CATALOG.map(suiheModelOverlay).map((model) => ({ ...model, sizes: model.sizes.map((size) => ({ ...size })) })) as any
}

export function providerCatalog() {
  return Object.values(PROVIDERS).map(({ id, label, description }: Record<string, any>) => ({ id, label, description }))
}
export function adminModelCatalog(env = process.env, settings: Record<string, any> = {}) {
  const seen = new Set()
  return CATALOG.map((base: any) => {
    const id = base.publicId || base.id
    if (seen.has(id)) return null
    seen.add(id)
    const active = activeModelForSettings(id, settings, env)
    const displayModel = active || suiheModelOverlay(base)
    const channels = modelChannelOptions(id, env).map(channel => ({
      ...channel,
      enabled: modelChannelEnabled(settings, id, channel.provider),
      active: Boolean(active && active.channelProvider === channel.provider),
    }))
    return {
      ...displayModel,
      id,
      publicId: id,
      kind:displayModel.video ? 'video' : 'image',
      provider:active ? (active.channelProvider || active.provider) : '',
      providerLabel:active ? (active.channelProviderLabel || CHANNEL_LABELS[active.provider] || active.provider) : '未启用',
      upstreamModelId:active ? (active.upstreamModelId || active.id) : '',
      legacyProvider:base.provider,
      channelCategory:displayModel.channelCategory || (displayModel.video ? 'legacy-video' : 'legacy-image'),
      channels,
      configured:Boolean(active && providerConfigured(active.channelProvider || active.provider,env)),
      internalOnly:Boolean(base.internalOnly),
    }
  }).filter(Boolean)
}

export function modelById(modelId): (typeof CATALOG)[number] & Record<string, any> {
  const wanted = String(modelId || '').trim()
  // 历史画布可能保存了带厂商标识的旧 ID，这里继续认。
  const LEGACY_PUBLIC_IDS = {
    // 公开 ID 统一用点上写法；旧的横线写法继续可读，权限和历史记录会自动迁移。
    'seedance-2-5': 'seedance-2.5',
    'doubao-seedance-2-5': 'seedance-2.5',
    'seedance-2-0-fast': 'seedance-2.0-fast',
    'doubao-seedance-2-0-fast': 'seedance-2.0-fast',
    'doubao-seedance-2-0-mini': 'seedance-2.0-mini',
    'seedance-2-0-mini': 'seedance-2.0-mini',
  }
  const target = LEGACY_PUBLIC_IDS[wanted] || wanted
  const model = CATALOG.find((model) => model.id === target || model.publicId === target)
  return model ? suiheModelOverlay(model) as any : null
}

const CHANNEL_LABELS = Object.freeze({
  suihe: '穗禾',
  ark: '火山方舟',
  metaso: '秘塔',
  yunshu: '云枢',
  grok: '云枢 Grok',
})

function baseModelByPublicId(value) {
  const wanted = String(value?.publicId || value?.id || value || '').trim()
  const aliases = {
    'seedance-2-5': 'seedance-2.5',
    'doubao-seedance-2-5': 'seedance-2.5',
    'seedance-2-0-fast': 'seedance-2.0-fast',
    'doubao-seedance-2-0-fast': 'seedance-2.0-fast',
    'doubao-seedance-2-0-mini': 'seedance-2.0-mini',
    'seedance-2-0-mini': 'seedance-2.0-mini',
  }
  const target = aliases[wanted] || wanted
  return CATALOG.find(model => model.id === target || model.publicId === target) || null
}

function channelVariants(value, env = process.env) {
  const base = baseModelByPublicId(value)
  if (!base) return []
  const publicId = base.publicId || base.id
  const variants = []
  const push = (provider, model) => {
    if (variants.some(item => item.provider === provider)) return
    variants.push({
      key: `${provider}:${publicId}`,
      provider,
      providerLabel: CHANNEL_LABELS[provider] || provider,
      upstreamModelId: String(model.upstreamModelId || model.id || publicId),
      model,
      configured: providerConfigured(provider, env),
    })
  }
  const suiheId = suiheModelId(base)
  // Images use the official definition when one exists; videos prefer Suihe.
  if (!base.video && base.provider === 'ark') push('ark', { ...base })
  if (SUIHE_MODEL_IDS.includes(suiheId)) push('suihe', suiheModelOverlay(base))
  push(base.provider, { ...base })
  return variants
}

// Price settings survive channel switches; validate against all known channel
// tiers so a dormant route cannot make unrelated settings impossible to save.
export function modelPriceSizes(value) {
  return [...new Set(channelVariants(value).flatMap(channel => (channel.model.sizes || []).map(size => size.value)))] as string[]
}

export function modelChannelOptions(value, env = process.env) {
  return channelVariants(value, env).map(({ model, ...channel }) => ({
    ...channel,
    publicId: model.publicId || model.id,
    label: model.label,
    kind: model.video ? 'video' : 'image',
  }))
}

export function normalizeModelChannelSettings(value: Record<string, any> = {}) {
  const result = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result
  for (const [rawId, rawChannels] of Object.entries(value)) {
    const base = baseModelByPublicId(rawId)
    if (!base || !rawChannels || typeof rawChannels !== 'object' || Array.isArray(rawChannels)) continue
    const known = new Set(channelVariants(base).map(channel => channel.provider))
    const channels = {}
    for (const [provider, enabled] of Object.entries(rawChannels)) {
      if (known.has(provider) && typeof enabled === 'boolean') channels[provider] = enabled
    }
    if (Object.keys(channels).length) result[base.publicId || base.id] = channels
  }
  return result
}

function defaultCustomerProvider(base) {
  if (!SUIHE_MODEL_IDS.includes(suiheModelId(base))) return base.provider
  if (base.video) return 'suihe'
  // Do not invent official endpoints for Suihe-only image definitions. Keep
  // them available for historical jobs and explicit administrator settings.
  return base.provider === 'ark' ? 'ark' : ''
}

export function modelChannelEnabled(settings: Record<string, any> = {}, value, provider) {
  const base = baseModelByPublicId(value)
  if (!base) return false
  const publicId = base.publicId || base.id
  const channels = settings?.modelChannels?.[publicId]
  // Once a model has an explicit channel map, omitted channels are disabled.
  // This keeps a partial admin patch such as `{ ark: true }` from silently
  // leaving the default Suihe route enabled as well.
  if (channels && typeof channels === 'object') return channels[provider] === true
  return provider === defaultCustomerProvider(base)
}

export function activeModelForSettings(value, settings: Record<string, any> = {}, env = process.env) {
  const options = channelVariants(value, env)
  if (!options.length) return null
  const enabled = options.filter(channel => modelChannelEnabled(settings, channel.model.publicId || channel.model.id, channel.provider))
  const selected = enabled.find(channel => channel.configured) || enabled[0]
  return selected?.model ? { ...selected.model, channelKey: selected.key, channelProvider: selected.provider, channelProviderLabel: selected.providerLabel, upstreamModelId: selected.upstreamModelId } : null
}

export function defaultModelChannelSettings(env = process.env) {
  const result = {}
  for (const base of CATALOG) {
    if (base.internalOnly) continue
    const options = channelVariants(base, env)
    if (!options.length) continue
    const publicId = base.publicId || base.id
    result[publicId] = Object.fromEntries(options.map(channel => [channel.provider, channel.provider === defaultCustomerProvider(base)]))
  }
  return result
}

// Historical and accepted jobs retain the provider used at reservation when
// the database row carries an explicit provider snapshot.
export function modelForGeneration(id, parameters: Record<string, any> = {}, provider = ''): Record<string, any> | null {
  const current = modelById(id)
  if (!current) return null
  // A missing publicId must not match another model's missing publicId.
  // Grok has only id; that comparison previously selected the first image model.
  const original = CATALOG.find(model => model.id === current.id || (current.publicId && model.publicId === current.publicId)) || current
  const frozen = parameters.upstreamProvider || provider
  // New requests resolve through activeModelForSettings and freeze the provider.
  // Legacy records without a snapshot keep their catalog resolution; accepted
  // and historical records with a snapshot must keep their original channel.
  if (!frozen) return current
  return frozen === 'suihe' ? current : original ? {...original,provider:frozen} : null
}

export function modelProvider(modelId) {
  return modelById(modelId)?.provider || ''
}

export function defaultModel(env = process.env) {
  const wanted = String(env.OIP_DEFAULT_MODEL || env.ARK_MODEL || '').trim()
  return modelById(wanted) ? wanted : CATALOG[0].id
}

export function providerConfigured(provider, env = process.env) {
  const key = PROVIDERS[provider]?.key
  if (provider === 'grok') return Boolean(runtimeSecret('GROK_API_KEY', env) || runtimeSecret('YUNSHU_API_KEY', env))
  return Boolean(key && runtimeSecret(key, env))
}

export function publicModelCatalog(env = process.env, settings: Record<string, any> = {}): Array<{ id: string; label: string } & Record<string, any>> {
  // 公开目录只给模型 ID 与能力：不暴露供应商标识，前端不展示供应商。
  const seen = new Set()
  return CATALOG.map((base: any) => activeModelForSettings(base.publicId || base.id, settings, env))
    .filter((model: any) => model && !model.video && !model.internalOnly && (model.provider !== 'suihe' || Boolean(suiheCapability(model)?.request_model)) && !seen.has(model.publicId || model.id))
    .map((model: any) => {
      seen.add(model.publicId || model.id)
      return ({
    id: model.publicId || model.id,
    label: model.label,
    video: Boolean(model.video),
    note: model.note,
    configured: providerConfigured(model.provider, env) && (model.provider !== 'suihe' || Boolean(suiheCapability(model)?.request_model)),
    sizes: model.sizes,
    ratios: model.ratios || [],
    customSize: Boolean(model.customSize),
    sizeRule: model.sizeRule || null,
    quality: model.quality,
    formats: model.formats,
    maxReferences: model.maxReferences,
    maxCount: model.maxCount,
    maxCombinedImages: model.maxCombinedImages,
    supportsEdit: model.supportsEdit,
    regionEdit: model.provider === 'yunshu' ? 'mask' : model.provider==='ark' && model.id.startsWith('doubao-seedream-5-0-') ? 'annotation' : null,
    supportsTransparent: model.supportsTransparent,
    inputFidelity: model.inputFidelity || [],
    supportsLayerDecomposition: Boolean(model.supportsLayerDecomposition),
    optimizePromptModes: Array.isArray(model.optimizePromptModes) ? model.optimizePromptModes : [],
    layerSizes: model.layerSizes || [],
    controls: model.controls || [],
    referenceInputs: { image: referenceInputPolicy(model, 'image') },
    deprecated: Boolean(model.deprecated),
    sunsetAt: model.sunsetAt || '',
    replacement: model.replacement || '',
      })
    })
}

export function publicVideoCatalog(env = process.env, settings: Record<string, any> = {}) {
  const seen = new Set()
  return CATALOG.map((base: any) => activeModelForSettings(base.publicId || base.id, settings, env))
    .filter((model: any) => model && model.video && !model.internalOnly && (model.provider !== 'suihe' || Boolean(suiheCapability(model)?.request_model)) && !seen.has(model.publicId || model.id))
    .map((model: any) => {
      seen.add(model.publicId || model.id)
      return ({
    // 公开目录只暴露 publicId，内部带版本的 id 留在服务端调用上游。
    id: model.publicId || model.id,
    label: model.label,
    video: true,
    note: model.note,
    configured: providerConfigured(model.provider, env) && (model.provider !== 'suihe' || Boolean(suiheCapability(model)?.request_model)),
    sizes: model.sizes,
    ratios: model.ratios || [...new Set(model.sizes.map((size) => size.ratio))],
    durations: model.durations || [],
    maxDurationByResolution: model.maxDurationByResolution || {},
    defaultDuration: model.defaultDuration,
    defaultResolution: model.defaultResolution,
    // 生成模式沿用参考画布的结构：字符串表示单一模式，数组表示混合参考与各类型上限。
    modes: model.modes || [],
    audio: model.audio ?? false,
    referenceLimits: model.referenceLimits || { image: model.maxReferences || 1, video: 0, audio: 0, frames: 0 },
    referenceInputs: Object.fromEntries(['image', 'video', 'audio'].map(kind => [kind, referenceInputPolicy(model, kind)])),
    keyframes: model.keyframes || 0,
    formats: model.formats,
    maxReferences: model.maxReferences,
    maxCount: model.maxCount ?? 1,
    maxDurationByMode: model.maxDurationByMode || {},
    parameterRules: model.parameterRules || {},
    controls: model.controls || [],
      })
    })
}

/**
 * 上游成本参考（只给管理端，不出现在面向用户的配置接口）。
 * 火山数字来自方舟官方刊例（当前按无折扣刊例）；秘塔来自官方活动页；
 * 云枢（Sub2API）数字来自本账号 usage_logs 实测账单。详细推导见
 * docs/模型成本与积分.md。
 */
const UPSTREAM_COSTS = {
  'gpt-image-2': '云枢实测 0.180 美元/张（99 张均值，未含结汇）',
  'gpt-image-2.5-sunburst': '云枢实测 0.201 美元/张（2 张均值，未含结汇）',
  'gpt-image-2.5-flare': '云枢实测 0.201 美元/张（22 张均值，未含结汇）',
  'grok-imagine-image': 'Grok 图片价目 $0.04/张 × 渠道倍率 1 × 7.2 元/美元（推算）',
  'grok-imagine-image-2.0': 'Grok 图片价目 $0.04/张 × 渠道倍率 1 × 7.2 元/美元（推算）',
  'doubao-seedream-5-0-pro': '官方刊例：≤261 万像素 0.30 元/张 · >261 万像素 0.60 元/张 · 输入图第 2 张起 0.02 元/张',
  'doubao-seedream-5-0-flash': '官方刊例 0.12 元/张',
  'doubao-seedream-4-0': '官方刊例 0.20 元/张',
  'seedream-4.5': '官方刊例 0.25 元/张',
  'seedream-5.0-lite': '官方刊例 0.22 元/张',
  'seedance-2.5': '按实际 completion_tokens 对账：480p/720p 无视频70、有视频42元/百万；1080p无视频77、有视频46元/百万；不向用户展示内部成本',
  'seedance-2.0-fast': '火山方舟按 completion_tokens/total_tokens 对账：无输入视频 37 元/百万 token、含输入视频 22 元/百万 token；页面不展示此成本',
  'MiniMax-H3': '秘塔最贵档 0.0108 元/积分：768P 约 0.11 元/秒 · 2K 约 0.18 元/秒 · 参考视频按输入时长 · 图片超 5 张约 0.06 元/张',
  'seedance-2.0-mini': '秘塔最贵档 0.0108 元/积分：720p 约 0.38 元/秒（35.09 积分/秒）',
  'seedance-2.0': '秘塔最贵档 0.0108 元/积分：720p 约 1.18 元/秒（108.89 积分/秒）',
  'grok-imagine-video': 'Grok 视频价目 480p $0.05/秒、720p $0.07/秒 × 渠道倍率 1 × 7.2 元/美元（推算）',
  'grok-imagine-video-1.5': 'Grok 视频价目 480p $0.08/秒、720p $0.14/秒、1080p $0.25/秒 × 渠道倍率 1 × 7.2 元/美元（推算）',
}
const SUIHE_UPSTREAM_COSTS = {
  'seedance-2.5': '穗禾采购：火山官方 token 成本 × 0.81；480p/720p 70/42、1080p 77/46 元/百万（无视频/含视频）',
  'seedance-2.0': '穗禾采购：火山官方 token 成本 × 0.81；480p/720p 46/28、1080p 51/31、4K 26/16 元/百万（无视频/含视频）',
  'seedance-2.0-fast': '穗禾采购：火山官方 token 成本 × 0.60；480p/720p 37/22 元/百万（无视频/含视频）',
  'seedance-2.0-mini': '穗禾采购：火山官方 token 成本 × 0.60；480p/720p 23/14 元/百万（无视频/含视频）',
  'seedream-4.0': '穗禾采购价：1K/2K 0.40 元/张',
  'seedream-4.5': '穗禾采购价：2K 0.45 元/张',
  'seedream-5.0-lite': '穗禾采购价：2K/3K 0.42 元/张',
  'seedream-5.0-pro': '穗禾采购价：1K 0.60、1.5K 0.85、2K 1.20 元/张',
  'doubao-seedream-4-0': '穗禾采购价：1K/2K 0.40 元/张',
  'doubao-seedream-5-0-pro': '穗禾采购价：1K 0.60、1.5K 0.85、2K 1.20 元/张',
}

export function upstreamCostCatalog() {
  return Object.fromEntries(modelCatalog().map((model) => {
    const id = model.publicId || model.id
    const label = model.provider === 'suihe' ? SUIHE_UPSTREAM_COSTS[id] : UPSTREAM_COSTS[id]
    return [id, { label: label || '未登记' }]
  }))
}

export function matchesSizeRule(rule, width, height) {
  if (!rule) return false
  const pixels = width * height
  const ratio = width / height
  if (width < 1 || height < 1 || !Number.isFinite(ratio)) return false
  if (rule.multipleOf && (width % rule.multipleOf || height % rule.multipleOf)) return false
  if (rule.maxEdge && (width > rule.maxEdge || height > rule.maxEdge)) return false
  return pixels >= rule.minPixels && pixels <= rule.maxPixels && ratio >= rule.minRatio && ratio <= rule.maxRatio
}

export function validSize(modelId, size, resolvedModel = null) {
  const model = resolvedModel || modelById(modelId)
  const value = String(size || '').trim()
  if (!model) return false
  if (model.sizes.some((option) => option.value === value)) return true
  if (!model.customSize) return false
  const match = /^(\d+)x(\d+)$/.exec(value)
  if (!match) return false
  return matchesSizeRule(model.sizeRule, Number(match[1]), Number(match[2]))
}

export function defaultsFor(modelId, resolvedModel = null) {
  const model: any = resolvedModel || modelById(modelId) || CATALOG[0]
  return {
    size: model.sizes.find((item) => item.value === 'auto')?.value || model.sizes[0].value,
    quality: model.quality.includes('medium') ? 'medium' : model.quality[0] || '',
    format: model.formats[0] || 'png',
    background: model.supportsTransparent ? 'auto' : 'opaque',
    inputFidelity: model.inputFidelity?.includes('high') ? 'high' : '',
    count: 1,
  }
}

export function normalizeGeneration(modelId, input: Record<string, any> = {}, resolvedModel = null) {
  const model = resolvedModel || modelById(modelId)
  if (!model) throw new Error('不支持的图片模型')
  const defaults = defaultsFor(model.id, model)
  let size = String(input.size || defaults.size).trim()
  let legacyRatio = ''
  if (model.provider==='suihe') {
    const match=/^(\d+)x(\d+)$/i.exec(size)
    if (match) {
      const width=Number(match[1]),height=Number(match[2]),area=width*height
      const ratio=(model.ratios || []).find(value=>{const [w,h]=value.split(':').map(Number);return Math.abs(width/height-w/h)<0.025})
      if (!ratio) throw new Error('当前模型不支持此旧画布比例，请重新选择比例')
      legacyRatio=ratio
      const tier=area<=1_200_000?'1K':area<=2_650_000?'1.5K':area<=4_700_000?'2K':area<=10_000_000?'3K':'4K'
      // Preserve a supported tier; 4.0 never advertised 1.5K.
      size=model.sizes.some(option=>option.value===tier)?tier:tier==='1.5K'&&model.sizes.some(option=>option.value==='2K')?'2K':tier
    } else size=size.toUpperCase()
  }
  // Grok 的官方默认质量是省略字段后的 auto。空值不能改写成 medium。
  const quality = String((input.quality || (model.provider === 'grok' ? '' : defaults.quality)) || '').trim().toLowerCase()
  const format = String(input.format || defaults.format).trim().toLowerCase()
  const background = String(input.background || defaults.background).trim().toLowerCase()
  const inputFidelity = String(input.inputFidelity || defaults.inputFidelity).trim().toLowerCase()
  const rawCount = input.count === undefined || input.count === null || input.count === '' ? 1 : Number(input.count)
  if (!Number.isSafeInteger(rawCount) || rawCount < 1 || rawCount > model.maxCount) throw new Error(`当前模型一次最多生成 ${model.maxCount} 张图片`)
  const count = rawCount
  const seed = input.seed === undefined || input.seed === null || input.seed === '' ? undefined : Number(input.seed)
  if (seed !== undefined && (!Number.isInteger(seed) || seed < -1 || seed > 2147483647)) throw new Error('随机种子无效')
  const responseFormat = String(input.responseFormat || '').trim().toLowerCase()
  if (responseFormat && !['url', 'b64_json'].includes(responseFormat)) throw new Error('图片响应格式无效')
  if (!validSize(model.id, size, model)) throw new Error('当前模型不支持这个画布尺寸')
  const requestedRatio = legacyRatio || String(input.ratio || '').trim()
  if (Array.isArray(model.ratios) && model.ratios.length && requestedRatio && !model.ratios.includes(requestedRatio)) throw new Error('当前模型不支持这个画面比例')
  // GPT Image and Seedream encode aspect ratio in the concrete size and never
  // send a separate ratio upstream, so the recorded ratio follows the size.
  // Correct instead of reject: 0.2.19 clients in the field still send stale
  // pairs such as 16:9 + 1024x1024. Grok keeps aspect_ratio as its own field.
  let ratio = requestedRatio
  if (ratio && model.provider !== 'grok') {
    const option = model.sizes.find(item => item.value === size)
    if (option?.ratio && option.ratio !== 'auto') ratio = option.ratio
    else if (!option) {
      const match = /^(\d+)x(\d+)$/.exec(size)
      if (match) {
        const width = Number(match[1]), height = Number(match[2])
        const gcd = (left: number, right: number): number => right ? gcd(right, left % right) : left
        const divisor = gcd(width, height)
        const exact = `${width / divisor}:${height / divisor}`
        ratio = model.ratios?.length && !model.ratios.includes(exact) ? '' : exact
      }
    }
  }
  if (model.quality.length && quality && !model.quality.includes(quality)) throw new Error('当前模型不支持这个质量档位')
  if (model.formats.length && !model.formats.includes(format)) throw new Error('当前模型不支持这个输出格式')
  if (background !== 'auto' && background !== 'opaque' && background !== 'transparent') throw new Error('背景设置无效')
  if (background === 'transparent' && !model.supportsTransparent) throw new Error('当前模型不支持透明背景')
  if (model.inputFidelity?.length && !model.inputFidelity.includes(inputFidelity)) throw new Error('当前模型不支持这个输入保真度')
  const controls = {}
  const supplied = input.parameters && typeof input.parameters === 'object' ? input.parameters : {}
  for (const control of model.controls || []) {
    const raw = supplied[control.key]
    if (raw === undefined || raw === '' || raw === false) continue
    if (control.type === 'boolean') controls[control.key] = true
    else if (control.type === 'select') {
      const value = String(raw)
      if (!(control.options || []).includes(value)) throw new Error('当前模型不支持这个选项')
      controls[control.key] = value
    } else if (control.type === 'number') {
      const value = Number(raw)
      if (!Number.isFinite(value) || (control.min != null && value < control.min) || (control.max != null && value > control.max)) throw new Error('当前模型不支持这个数值')
      controls[control.key] = value
    }
  }
  return { size, ratio: ratio || '', quality, format, background, inputFidelity, count, seed, responseFormat, controls }
}
