#!/usr/bin/env node
/* Read-only production UI acceptance.  This is an acceptance runner, not a test suite. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const truthPath = resolve(process.env.OIP_VERIFY_TRUTH || '/Users/cch/.oip-verify/admin-20261007/truth.json')
const outDir = resolve(process.env.OIP_VERIFY_SCREENSHOTS || '/Users/cch/.oip-verify/admin-20261007')
mkdirSync(outDir, { recursive: true })
const truth = JSON.parse(readFileSync(truthPath, 'utf8'))
const api = path => truth.api[path].body
const stats = api('/api/admin/overview').stats
const ops = api('/api/admin/operations')
const users = api('/api/admin/users?limit=100&page=1')
const generations = api('/api/admin/generations?limit=100&page=1')
const payments = api('/api/admin/payment-orders?limit=100&page=1')
const upstream = api('/api/admin/upstream-calls?limit=200&page=1')
const derived = api('/api/admin/derived-prices').items
const reconciliation = api('/api/admin/reconciliation').reconciliation
const datasetSql = truth.datasetSql
const datasetPromptsSql = Number(datasetSql.prompts.rows[0]?.n || 0)
const datasetImagesSql = Number(datasetSql.images.rows[0]?.n || 0)

// The retired US host no longer runs MiaoImg; the operator names the target.
const remoteHost = process.env.MIAO_REMOTE_HOST || ''
if (!remoteHost) throw new Error('请显式设置 MIAO_REMOTE_HOST（例如 root）后再读取管理员验收凭据')
const email = execFileSync('ssh', [remoteHost, 'cat', '/opt/miaoimg/secrets/admin-email'], { encoding: 'utf8' }).trim()
const password = execFileSync('ssh', [remoteHost, 'cat', '/opt/miaoimg/secrets/admin-password'], { encoding: 'utf8' }).trim()
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1680, height: 1100 }, locale: 'zh-CN' })
const results = []
const failures = []
let currentSection = ''
const number = value => Number(value || 0).toLocaleString('zh-CN')
const money = value => `¥${Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 3 })}`
const has = (text, value, label) => {
  if (!text.includes(String(value))) failures.push({ label, expected: String(value), section: currentSection })
}
async function section(nav, file, heading, checks) {
  currentSection = nav
  await page.getByRole('button', { name: nav, exact: true }).click()
  await page.locator('h1').filter({ hasText: heading }).waitFor()
  // Each tab fetches its own production endpoint after the heading appears.
  await page.waitForTimeout(1400)
  if (nav === '迁移与运维') await page.getByRole('heading', { name: '项目迁移', exact: true }).waitFor({ timeout: 6000 }).catch(() => {})
  if (nav === '生成记录') await page.getByText(/对账范围：\d+ 条/).waitFor({ timeout: 6000 }).catch(() => {})
  if (nav === '上游留档') await page.getByText('gpt-image-2', { exact: true }).first().waitFor({ timeout: 6000 }).catch(() => {})
  const text = await page.locator('main').innerText()
  for (const [value, label] of checks) has(text, value, label)
  await page.screenshot({ path: resolve(outDir, file), fullPage: true })
  results.push({ section: nav, screenshot: file, domChecks: checks.length, pass: !failures.some(item => item.section === nav) })
  return text
}

await page.goto('https://miaoimg.cn/manage', { waitUntil: 'domcontentloaded' })
await page.getByRole('textbox', { name: '管理员邮箱' }).fill(email)
await page.getByRole('textbox', { name: '管理员密码' }).fill(password)
await page.getByRole('button', { name: '登录后台', exact: true }).click()
await page.getByRole('button', { name: '运营概览', exact: true }).waitFor()

await section('运营概览', 'overview.png', '运营概览', [
  [number(stats.users), '用户数'], [number(stats.requests), '生成请求数'], [number(stats.succeeded), '完成数'],
  [number(stats.chargedPointsRmb), '消耗积分'], [money(stats.upstreamCostRmb), '成本合计'], [money(stats.marginRmb), '毛利'],
  [number(stats.missingCostRows), '缺成本记录'], [`${stats.balanceAudit.matching} / ${stats.balanceAudit.checked}`, '余额不变量'],
  [`账本累计：${number(stats.balanceAudit.ledgerTotal)} 积分`, '账本累计'],
])

const operationsText = await section('迁移与运维', 'operations.png', '迁移与运维', [
  [ops.migration.projectLayoutLabel, '迁移布局'], [number(ops.migration.workspaceRows), '工作区索引'],
  [number(ops.storage.mediaFiles), '媒体文件数'], [number(datasetPromptsSql), '提示词数（数据集 SQL）'], [number(datasetImagesSql), '图片数（数据集 SQL）'],
  [number(ops.dataset.previews), '预览数'], [number(ops.runtime.textContextWindow), '上下文窗口'], [ops.runtime.mediaMode, '媒体模式'],
])
has(operationsText, ops.reconcile.ran ? '已运行' : '未运行过', '对账状态')

const usersText = await section('用户与额度', 'users.png', '用户与额度', [
  [number(users.total), '用户总数'], [number(stats.activeUsers), '活跃用户数'], [number(stats.disabledUsers), '停用用户数'],
  ['未验证', '邮箱未验证态'], ['live-parity-1791171062642', '长用户名'],
])
has(usersText, '已停用', '停用账号状态')
if (users.items.filter(item => item.emailVerified).length !== 0) failures.push({ label: 'email_verified 全 0', expected: '0' })

const models = api('/api/admin/overview')
await section('模型配置', 'models.png', '模型配置', [
  ['模型配置', '模型区块'], ['参考成本', '成本说明'], [String(models.models.length), '模型数量'],
])

const upstreamText = await section('上游留档', 'upstream.png', '上游留档', [
  [number(upstream.total), '上游调用数'], [money(upstream.items[0]?.cost_rmb), '上游成本样本'],
  [number(derived.length), '真实单价档位数'], ['推算单价', '推算单价标题'], ['余额差推算', '余额差口径'],
])
has(upstreamText, '文本通道', '文本通道提示')
has(upstreamText, '未纳入', '文本通道未纳入提示')

await section('生成记录', 'generations.png', '生成记录', [
  [number(generations.total), '生成记录总数'], [`对账范围：${reconciliation.requests} 条`, '对账请求数'],
  [`已关联上游 ID ${reconciliation.linkedRows} 条`, '对账关联数'], [`未关联 ${reconciliation.unlinkedRows} 条`, '对账未关联数'],
  [`原始 usage ${reconciliation.usageRows} 条`, '对账 usage 数'],
])
// Open one real row to verify the pre-charge / settled-charge wording is visible.
currentSection = '生成记录'
await page.getByRole('button', { name: '查看', exact: true }).first().click()
await page.getByRole('dialog', { name: '生成详情' }).waitFor()
const detailText = await page.getByRole('dialog', { name: '生成详情' }).innerText()
has(detailText, '预扣 / 实扣', '生成详情预扣实扣标题')
has(detailText, '0.1 / 0.1 积分', '生成详情预扣实扣数值')
await page.screenshot({ path: resolve(outDir, 'generation-detail.png'), fullPage: true })
await page.getByRole('button', { name: '关闭弹窗' }).click()

const paymentText = await section('充值订单', 'payments.png', '充值订单', [
  ['累计已支付', '已支付汇总标题'], ['¥0', '零已支付金额'], ['0 笔', '零已支付笔数'],
])
has(paymentText, '已过期', '订单状态列')

await section('操作日志', 'audit.png', '操作日志', [
  ['最近操作', '审计区块'], ['时间', '审计时间列'], ['操作人', '审计操作人列'],
])

const report = {
  collectedAt: truth.collectedAt,
  page: page.url(),
  screenshotDir: outDir,
  results,
  failures,
  note: 'DOM checks compare production page text with the read-only truth collector JSON.',
}
writeFileSync(resolve(outDir, 'ui-assertions.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
await browser.close()
console.log(JSON.stringify(report, null, 2))
if (failures.length) process.exitCode = 1
