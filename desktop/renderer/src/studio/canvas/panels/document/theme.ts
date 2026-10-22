import { themeLight } from "dockview-vue";

// dockview 主题：色值走 CSS 变量，具体变量在文档面板的全局样式里按主题类名覆盖。
export const theme = { ...themeLight, name: "miaoimg", className: "dockviewMiaoimg" };
