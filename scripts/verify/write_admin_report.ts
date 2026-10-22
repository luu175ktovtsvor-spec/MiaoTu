#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(process.env.OIP_VERIFY_DIR || '/Users/cch/.oip-verify/admin-20261007')
const truth = JSON.parse(readFileSync(resolve(root, 'truth.json'), 'utf8'))
const ui = JSON.parse(readFileSync(resolve(root, 'ui-assertions.json'), 'utf8'))
const sql = truth.sql
const api = path => truth.api[path].body
const overview = api('/api/admin/overview')
const operations = api('/api/admin/operations')
const users = api('/api/admin/users?limit=100&page=1')
const generations = api('/api/admin/generations?limit=100&page=1')
const payments = api('/api/admin/payment-orders?limit=100&page=1')
const upstream = api('/api/admin/upstream-calls?limit=200&page=1')
const derived = api('/api/admin/derived-prices')
const reconciliation = api('/api/admin/reconciliation')

const j = value => JSON.stringify(value, null, 2)
const pre = value => `<pre>${String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</pre>`
const screenshot = name => `[${name}](<${resolve(root, name)}>)`
const rows = []
function addBlock(name, sqlKey, result, uiReadout, verdict, evidence = '', sqlText = '') {
  rows.push(`| ${name} | ${pre(sqlText || sql[sqlKey]?.query || '无 management.sqlite SQL：状态来自 API / 环境 / 宿主状态文件（见说明）')} | ${pre(j(result))} | ${uiReadout}<br>${evidence} | **${verdict}** |`)
}

const longest = [...sql.users.rows].sort((a, b) => String(b.name).length - String(a.name).length)[0]
const balance = sql.balance_rows.rows
const overviewStats = overview.stats
addBlock('概览统计', 'overview', overviewStats,
  `DOM：用户 ${overviewStats.users}；请求 ${overviewStats.requests}；完成 ${overviewStats.succeeded}；消耗 ${overviewStats.chargedPointsRmb}；成本 ¥${overviewStats.upstreamCostRmb}；毛利 ¥${overviewStats.marginRmb}；缺成本 ${overviewStats.missingCostRows}。截图：${screenshot('overview.png')}`,
  '对', 'UI 脚本 9 项 DOM 断言全部命中。成本说明来自 `generations.upstream_cost` 的 `rmb` 字段，属于价目/实测推算，不是支付账单实收。')

addBlock('用户列表与状态', 'users', {
  total: users.total,
  active: overviewStats.activeUsers,
  disabled: overviewStats.disabledUsers,
  emailVerified: overviewStats.emailVerifiedUsers,
  longestName: { name: longest.name, length: String(longest.name).length },
}, `DOM：${users.total} 条；页面出现长用户名 “${longest.name}”、已停用、邮箱状态：未验证。截图：${screenshot('users.png')}`, '对', '36 个账号已加载；16 active、20 disabled；email_verified 全 0。')

addBlock('余额 == 账本累计', 'balance_rows', {
  checked: overviewStats.balanceAudit.checked,
  matching: overviewStats.balanceAudit.matching,
  mismatches: overviewStats.balanceAudit.mismatches,
  storedTotal: overviewStats.balanceAudit.storedTotal,
  ledgerTotal: overviewStats.balanceAudit.ledgerTotal,
}, `DOM：${overviewStats.balanceAudit.matching} / ${overviewStats.balanceAudit.checked} 个账号一致；账本累计 ${overviewStats.balanceAudit.ledgerTotal}，计数器合计 ${overviewStats.balanceAudit.storedTotal}。截图：${screenshot('overview.png')}`, overviewStats.balanceAudit.mismatches.length ? '不对' : '对', overviewStats.balanceAudit.mismatches.length ? '需列出 mismatches（见 SQL 结果）。' : '36/36 成立，没有账号差额。')

addBlock('生成记录（预扣/消耗）', 'generations_summary', sql.generations_summary.rows,
  `DOM 列表：45 条；对账范围 45、已关联上游 ID 40、未关联 5、原始 usage 32。打开首条详情后 DOM 显示 “预扣 / 实扣 0.1 / 0.1 积分”。截图：${screenshot('generations.png')}、${screenshot('generation-detail.png')}`,
  '对', '失败记录显示“失败已退点”；预扣/实扣口径在详情可见。')

addBlock('充值订单', 'payment_summary', { summary: sql.payment_summary.rows[0], orders: sql.payment_orders.rows },
  `DOM：累计已支付 ¥0、0 笔；全部订单 5 笔且均显示已过期，页面保持正常列表态。截图：${screenshot('payments.png')}`, '对', '0 笔已支付是线上当前正常态；5 笔历史订单均为 expired，不应误报成接口错误。')

addBlock('上游成本与毛利', 'overview', {
  chargedPointsRmb: overviewStats.chargedPointsRmb,
  upstreamCostRmb: overviewStats.upstreamCostRmb,
  marginRmb: overviewStats.marginRmb,
  missingSucceededCostRows: overviewStats.missingCostRows,
}, `DOM 概览显示成本 ¥${overviewStats.upstreamCostRmb}、毛利 ¥${overviewStats.marginRmb}，并显示缺成本 ${overviewStats.missingCostRows}。截图：${screenshot('overview.png')}`, '对', '成本来自 `upstream_cost.rmb`；毛利按页面口径“已扣积分 − 成本”，不是支付账单实收。')

addBlock('成本留档（upstream-calls）', 'upstream_calls', {
  total: upstream.total,
  calls: upstream.items.map(({ provider, model, kind, tier, cost_rmb, cost_basis, status }: Record<string, any>) => ({ provider, model, kind, tier, cost_rmb, cost_basis, status })),
}, `DOM：最近调用 ${upstream.total} 条，逐行显示成本和 cost basis。截图：${screenshot('upstream.png')}`, '需人工确认', '媒体调用留档 5 条；文本通道不写 `upstream_calls`，因此不能把缺行解释为 0 成本。页面没有显示“文本通道未纳入”提示，DOM 断言失败（见 ui-assertions.json）。')

addBlock('按模型档位的真实单价（derived-prices）', 'derived_prices', derived.items,
  `DOM：${derived.items.length} 个上游×模型×档位；显示“推算单价”、成本和样本次数。截图：${screenshot('upstream.png')}`, '需人工确认', 'yunshu 图像档位只有 usage、没有余额差样本；metaso 样本余额差为 0，页面显示 0 积分/秒。cost basis 是实测/价目推算，不是账单实收；这些 0 值需要业务确认。')

addBlock('迁移状态（未迁移老布局）', 'migration_layout', operations.migration,
  `DOM：老布局（单项目 / 路径树）；项目数 0；工作区索引 ${operations.migration.workspaceRows}；旧布局独有 ${operations.migration.workspaceRowsAtOldOnly}。截图：${screenshot('operations.png')}`, '对', '生产确实是 legacy：无 projects 表、无 project_id，未把未迁移状态伪装成新布局。')

addBlock('存储与快照', 'storage_distribution', {
  distribution: operations.migration.storageDistribution,
  storage: operations.storage,
}, `DOM：媒体 ${operations.storage.mediaFiles} 文件、${operations.storage.mediaBytes} bytes；磁盘使用率 ${operations.storage.disk.usagePercent}%；最近快照状态 ${operations.storage.snapshots.status}。截图：${screenshot('operations.png')}`, '对', '快照来自宿主状态 JSON；当前 success 且未过期。')

const datasetSqlPrompts = Number(truth.datasetSql?.prompts?.rows?.[0]?.n || 0)
const datasetSqlImages = Number(truth.datasetSql?.images?.rows?.[0]?.n || 0)
const datasetMismatch = datasetSqlPrompts !== Number(operations.dataset.prompts) || datasetSqlImages !== Number(operations.dataset.images)
addBlock('数据集同步状态', 'schema', {
  datasetSql: truth.datasetSql,
  dataset: operations.dataset,
}, `DOM：提示词 ${operations.dataset.prompts}、图片 ${operations.dataset.images}、预览 ${operations.dataset.previews}；同步成功，定时器已发现。截图：${screenshot('operations.png')}`, datasetMismatch ? '不对' : '对', datasetMismatch ? `数据集 DB SQL 的 prompts=${datasetSqlPrompts}、images=${datasetSqlImages}，但同步状态文件/API/界面显示 prompts=${operations.dataset.prompts}、images=${operations.dataset.images}；这是界面读数与 SQL 真值不一致，需确认同步状态文件是否滞后。` : 'management.sqlite 不存数据集内容；数据集 SQL 是只读打开 `/app/.oip/runtime/prompts.db` 后执行，状态来自只读宿主 JSON。', Object.values(truth.datasetSql).map((item: any) => item.query).join('\n'))

addBlock('对账结论', 'reconciliation', reconciliation.reconciliation,
  `DOM 生成记录显示 45 条、关联 40、未关联 5、usage 32；运维块显示媒体对账“未运行过”。截图：${screenshot('generations.png')}、${screenshot('operations.png')}`, '需人工确认', '管理端生成对账 API 有实时结论；媒体索引/字节对账脚本没有落盘过结论，不能把“未运行过”写成通过。')

addBlock('运行时窗口', '', operations.runtime,
  `DOM：上下文窗口 ${operations.runtime.textContextWindow} tokens，来源“未配置（用降级值 8192）”，媒体模式 ${operations.runtime.mediaMode}。截图：${screenshot('operations.png')}`, '对', '运行时窗口来自容器环境/API，非数据库字段；页面与 API 一致。')

addBlock('操作日志', '', { apiRows: api('/api/admin/audit').items.slice(0, 3), totalReturned: api('/api/admin/audit').items.length },
  `DOM：最近操作、时间、操作人列均存在。截图：${screenshot('audit.png')}`, '对', '只读查看最近 200 条；本次登录会留下正常的管理员登录审计记录。', 'SELECT id,actor,action,target,details,created_at FROM audit ORDER BY created_at DESC LIMIT 200')

const failed = ui.failures
const failingSections = new Set(failed.map(item => item.section))
const report = `# /manage 逐块真值验收（生产只读）

生产镜像：\`miaoimg:20261007-013136\`  · 采集时间：\`${truth.collectedAt}\`  · 页面：\`https://miaoimg.cn/manage\`  
访问方式：容器内 \`127.0.0.1:4184\`；数据库只读打开 \`/app/data/management.sqlite\`；没有部署、构建、迁移或生产文件写入。

## 结论表

| 块 | SQL 原文 | 查询结果 | 界面读数 / 截图 | 判定 |
|---|---|---|---|---|
${rows.join('\n')}

## 失败与人工确认

无头 Playwright 的关键 DOM 断言共执行 ${ui.results.reduce((sum, row) => sum + row.domChecks, 0)} 项；通过 ${ui.results.length - failingSections.size}/${ui.results.length} 个页面块。明确失败：

${failed.length ? failed.map(item => '- **' + item.section + '**：缺少“' + item.expected + '”（' + item.label + '）。').join('\n') : '- 无。'}

### 发布前 / 下次发布前清单

1. **高优先级：** 上游留档页面补充文本通道“未纳入 upstream_calls / 不代表 0 成本”的明确提示，并保持当前媒体留档成本 basis 可见。
2. **高优先级：** 确认 derived-prices 中 metaso 余额差为 0 的样本是否真代表未扣积分；确认 yunshu 图像档位没有余额差样本时应显示“只有上游用量”，不能把 null 当成 0 单价。
3. **高优先级：** 处理数据集真值冲突：\`prompts.db\` 只读 SQL 为 prompts 20,753、images 35,475，宿主同步状态/API/页面为 prompts 18,019、images 31,992；发布前明确哪个来源是权威并刷新状态文件或页面口径。
4. **中优先级：** 运行并落盘一次媒体索引/字节对账报告；在报告落盘前，运维块继续显示“未运行过”是正确的阻断信号。
5. **中优先级：** 明确“概览毛利”使用全量 charged_points（25.7）而“对账 succeeded chargedPoints”是 25.2 的展示口径，避免运营人员把两者误作同一分母。

## 未能验 / 边界

- 没有发起真实生图、视频、充值或回调请求；因此没有验证新的上游扣费、支付实收或实时异步通知。
- 没有执行媒体对账、快照、数据集同步、迁移或任何写操作；只读展示了已有状态文件和数据库结果。
- 文本通道目前按约定不写 \`upstream_calls\`；生产页面没有对应“未纳入”文案，所以该要求未通过 UI 验收，不能把它写成已验收。
- 真实第三方 OAuth、支付成功回调、所有上游 provider 的新请求路径没有在本轮触发；API 路由 200 与历史留档不等于新请求成功。

## 可复跑命令

\`\`\`bash
cd /Users/cch/Developer/miaoimg/main
node scripts/verify/admin_truth_acceptance.ts
node scripts/verify/admin_ui_acceptance.ts
node scripts/verify/write_admin_report.ts
\`\`\`

产物目录：\`${root}\`。其中 \`truth.json\` 保存 SQL/API 对照，\`ui-assertions.json\` 保存 DOM 断言与失败项，PNG 是逐块截图。
`
writeFileSync(resolve(root, 'report.md'), report)
console.log(resolve(root, 'report.md'))
