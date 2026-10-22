// 将参数化消息转换为稳定词条和 ICU 参数。
// 模板字符串的静态部分要按 ICU 规则转义：单引号成对写、花括号用引号包住，
// 否则文案里恰好出现的 ' / { / } 会被 intl-messageformat 当成语法。
export function escapeMessageText(value: string): string {
  return value.replaceAll("'", "''").replaceAll("{", "'{'").replaceAll("}", "'}'");
}
