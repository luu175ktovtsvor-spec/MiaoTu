export const REFERENCE_ROLES = [
  { value: 'general', label: '自由参考' },
  { value: 'person', label: '人物身份' },
  { value: 'clothing', label: '服装穿搭' },
  { value: 'scene', label: '场景环境' },
  { value: 'style', label: '视觉风格' },
  { value: 'composition', label: '构图姿态' },
]
export function compileReferencePrompt(prompt, roles = []) {
  const declared = roles.map((role,index) => {
    const known = REFERENCE_ROLES.find(item => item.value === role)
    return known && role !== 'general' ? `参考图${index + 1}用于${known.label}` : null
  }).filter(Boolean)
  return declared.length ? `${prompt}\n\n参考分工：${declared.join('；')}。人物身份参考只约束人物特征，服装参考只约束衣服，风格参考只借鉴视觉气质。优先遵循上方的具体要求。` : prompt
}
export const CREATIVE_PLAYS = [
  { id:'wardrobe', label:'人物换装', hint:'人物图 + 服装图', prompt:'保持人物脸部身份和体态，把人物照片里的穿搭换成参考服装。真实商业摄影，服装结构清楚，手部自然，无文字。' },
  { id:'scene', label:'换个环境', hint:'人物图 + 环境图', prompt:'把参考人物自然地放进参考环境里，保持人物身份与原有服装。统一人物和环境的光线，比例和透视真实，像一张自然拍摄的照片，无文字。' },
  { id:'space', label:'空间改造', hint:'门店或风景实拍', prompt:'基于门店实景做一版新的空间摄影：保留主要空间动线和真实结构，只改变光线、材质氛围和镜头表达。无人物、无文字。' },
  { id:'editorial', label:'杂志大片', hint:'人物图 + 风格参考', prompt:'给参考人物拍一张杂志封面用的摄影作品，保持人物身份和穿搭。克制的电影光线，自然皮肤，画面有留白，手部真实，不要生成文字。' },
  { id:'material', label:'换种质感', hint:'已有成片或物品图', prompt:'保持参考图片里物体的形状、构图和背景，只把主体材质改成磨砂玻璃。自然光影，细节清楚，无文字。' },
]
