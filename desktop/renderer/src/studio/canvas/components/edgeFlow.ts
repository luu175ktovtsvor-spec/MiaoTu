// 连线发光：照 LibTV 的做法，一层层半透明描边叠出光晕，再用分段虚线拼出一颗带拖尾的光点。
// 所有层共用 pathLength=300、周期 100 的虚线，整组一起移动 stroke-dashoffset，光点就沿线流动。
export const EDGE_FLOW_LAYERS = [
  { dash: '36 64', width: 12, opacity: 0.06, cap: 'round' },
  { dash: '36 64', width: 7, opacity: 0.12, cap: 'round' },
  { dash: '36 64', width: 4, opacity: 0.15, cap: 'butt' },
  { dash: '0 6 30 64', width: 4, opacity: 0.18, cap: 'butt' },
  { dash: '0 12 24 64', width: 4, opacity: 0.21, cap: 'butt' },
  { dash: '0 18 18 64', width: 4, opacity: 0.27, cap: 'butt' },
  { dash: '0 24 12 64', width: 4, opacity: 0.38, cap: 'butt' },
  { dash: '0 30 6 64', width: 4, opacity: 0.6, cap: 'butt' },
] as const

// 默认的光是蓝色，和画布的黑白主题区分开；用户在设置里自选颜色时用自选的。
export const EDGE_FLOW_DEFAULT_COLOR = '#4c9dff'
