export const adminNavigationGroups = [
  { label: '工作台', keys: ['overview'] },
  { label: '业务运营', keys: ['users', 'generations', 'feedback'] },
  { label: '模型服务', keys: ['models', 'text'] },
  { label: '资金与成本', keys: ['payments', 'upstream'] },
  { label: '系统管理', keys: ['settings', 'operations', 'audit'] },
];

export const adminSectionDescriptions: Record<string, string> = {
  overview: '先看经营与任务状态，再处理需要关注的事项。',
  users: '管理账号、模型权限和积分，查看用户的完整使用记录。',
  generations: '查询图片、视频任务，检查结果、状态和积分结算。',
  feedback: '查看并回复用户的问题和建议。',
  models: '管理模型开放状态、渠道选择和客户价格。',
  text: '查看文本调用，管理计费规则和用户赠送。',
  payments: '核对充值订单、支付状态和积分到账。',
  upstream: '核对采购成本、供应商用量和调用留档。',
  settings: '集中管理服务开关、注册规则和自动报价参数。',
  operations: '查看服务器空间、素材库和最近更新情况。',
  audit: '追踪账号、订单与后台管理操作。',
};
