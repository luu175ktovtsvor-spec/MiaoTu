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
    if (found) return found[1];
  }
  return "";
}
