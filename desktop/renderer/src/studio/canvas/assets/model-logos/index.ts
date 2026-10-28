// 各家模型的官方标识（矢量版取自 LobeHub Icons，MIT）。按模型 ID 认出是哪一家；
// provider 是用户自己接入的供应商名称或地址，模型 ID 认不出时再用它。
// Seedance、Seedream 在火山方舟上以豆包模型发布，用豆包标识。画布（Vue）和外壳（React）共用这一份。
import openai from "./openai.svg?raw";
import grok from "./grok.svg?raw";
import doubao from "./doubao.svg?raw";
import minimax from "./minimax.svg?raw";
import qwen from "./qwen.svg?raw";
import claude from "./claude.svg?raw";
import deepseek from "./deepseek.svg?raw";
import kimi from "./kimi.svg?raw";
import gemini from "./gemini.svg?raw";
import zhipu from "./zhipu.svg?raw";
import ollama from "./ollama.svg?raw";
import mistral from "./mistral.svg?raw";

// 各标识在 24×24 画布里实际占的范围（浏览器 getBBox 实测）。统一按内容居中、铺满同样大小，
// 再按视觉密度微调：OpenAI 的结比 Grok 等线条标识显得更大更重，缩一点才看起来一样大。
const CONTENT_BOXES = new Map<string, [number, number, number, number]>([
  [claude, [0, 0, 24, 24]], [deepseek, [0, 3, 24, 17.66]], [doubao, [1.5, 0, 21.29, 24]], [gemini, [1, 1, 22, 22]],
  [grok, [0, 0.5, 24, 23.04]], [kimi, [1.5, 1, 22.47, 21]], [minimax, [0, 2, 24, 20]], [mistral, [0, 3.4, 24, 17.14]],
  [ollama, [3.5, 1, 17, 22]], [openai, [1, 1, 22, 22]], [qwen, [1, 1, 22, 22]], [zhipu, [1, 0, 22, 24]],
]);
const OPTICAL_SCALE = new Map<string, number>([[openai, 0.9]]);
const normalized = new Map<string, string>();
function normalize(svg: string) {
  const cached = normalized.get(svg);
  if (cached) return cached;
  const box = CONTENT_BOXES.get(svg);
  let result = svg;
  if (box) {
    const [x, y, width, height] = box;
    const side = Math.max(width, height) / (OPTICAL_SCALE.get(svg) ?? 1);
    const viewBox = [x + width / 2 - side / 2, y + height / 2 - side / 2, side, side].map(value => +value.toFixed(3)).join(" ");
    result = svg.replace(/viewBox="[^"]*"/, `viewBox="${viewBox}"`);
  }
  normalized.set(svg, result);
  return result;
}

const FAMILIES: Array<[RegExp, string]> = [
  [/gpt|openai|chatgpt|codex|\bo[1-9]\b|dall-?e/, openai],
  [/grok|x\.ai|xai/, grok],
  [/seedream|seedance|doubao|豆包|volc|ark\.cn|火山/, doubao],
  [/minimax|hailuo|海螺|\bh3\b/, minimax],
  [/qwen|wanx|wanvideo|tongyi|通义|千问|dashscope|aliyun/, qwen],
  [/claude|anthropic/, claude],
  [/deepseek/, deepseek],
  [/kimi|moonshot|月之暗面/, kimi],
  [/gemini|google/, gemini],
  [/glm|zhipu|智谱|bigmodel/, zhipu],
  [/ollama/, ollama],
  [/mistral/, mistral],
];

/** 返回该模型官方标识的 SVG 文本；认不出时返回空字符串，由调用方显示首字母。 */
export function modelLogoSvg(model: unknown, provider: unknown = ""): string {
  for (const source of [model, provider]) {
    const value = String(source || "").toLowerCase();
    if (!value) continue;
    const found = FAMILIES.find(([pattern]) => pattern.test(value));
    if (found) return normalize(found[1]);
  }
  return "";
}
