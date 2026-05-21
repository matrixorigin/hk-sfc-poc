import { expect, test, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'

const chartMissingPattern = /请绑定|请选择图表类型|Open \/ Close/
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3000'

type ChartName = '折线' | '柱状' | '条形' | '饼图' | '组合' | '热力' | '蜡烛' | '隐藏'

test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ page }) => {
  await signInAsTableOwner(page, 'candlestick')
  await page.goto('/')
  await expect(page.locator('textarea')).toBeVisible({ timeout: 15_000 })
})

test('单轮生成：蜡烛图绑定 OHLC 并渲染', async ({ page }) => {
  await selectTable(page, 'candlestick')
  await sendPrompt(page, '2025年1月，新华电源每日的开盘价、收盘价、最高价、最低价，用蜡烛图表示')
  await expectChartReady(page, '蜡烛')
  await expect(page.locator('.chart-section').last().locator('select')).toContainText([
    '开盘价',
    '收盘价',
    '最高价',
    '最低价',
  ])
})

test('单轮生成：组合图把两个指标都放入 y 指标列表', async ({ page }) => {
  await sendPrompt(page, '展示2025年1月恒生指数和涨跌幅，用组合图展示，恒生指数用柱状图，涨跌幅用折线图。')
  await expectChartReady(page, '组合')
  const section = page.locator('.chart-section').last()
  await expandChartConfig(section)
  await expect(section.locator('.cfs-mpill')).toHaveCount(2)
  await expect(section).toContainText(/HSHSI|恒生指数/)
  await expect(section).toContainText(/hsi_pct_change|Hsi Pct Change|涨跌幅/)
})

test('单轮生成：折线图渲染', async ({ page }) => {
  await selectTable(page, 'candlestick')
  await sendPrompt(page, '展示2025年1月新华电源每日收盘价，用折线图表示。')
  await expectChartReady(page, '折线')
})

test('单轮生成：条形图渲染', async ({ page }) => {
  await sendPrompt(page, '列出2025年一季度涨幅最高的10只股票，用条形图展示。')
  await expectChartReady(page, '条形')
})

test('二轮修改：折线图改成柱状图', async ({ page }) => {
  await selectTable(page, 'candlestick')
  await sendPrompt(page, '展示2025年1月新华电源每日收盘价，用折线图表示。')
  await expectChartReady(page, '折线')

  await sendPrompt(page, '改成柱状图。')
  await expectChartReady(page, '柱状')
})

test('二轮修改：当前结果改成热力图', async ({ page }) => {
  await sendPrompt(page, '列出2025年一季度涨幅最高的10只股票，用条形图展示。')
  await expectChartReady(page, '条形')

  await sendPrompt(page, '改成热力图，x用stock_code，y用stock_name，颜色用price_change_pct。')
  await expectChartReady(page, '热力')
})

async function selectTable(page: Page, tableName: string) {
  const chip = page.locator(`.table-chip[title="${tableName}"]`)
  await expect(chip).toBeVisible({ timeout: 15_000 })
  await chip.click()
  await expect(chip).toHaveClass(/active/)
}

async function sendPrompt(page: Page, prompt: string) {
  await page.locator('textarea').fill(prompt)
  await page.locator('.btn-send').click()
  await expect(page.locator('.btn-send')).toBeDisabled({ timeout: 5_000 })
}

async function expectChartReady(page: Page, chartName: ChartName) {
  const section = page.locator('.chart-section').last()
  await expect(section).toBeVisible({ timeout: 180_000 })
  await expect(section.getByRole('button', { name: chartName, exact: true })).toHaveClass(/active/)
  await expect(section).not.toContainText(chartMissingPattern)
  const canvas = section.locator('canvas').first()
  await expect(canvas).toBeVisible()
  await expect
    .poll(async () => canvas.evaluate((node) => node.width > 80 && node.height > 80))
    .toBe(true)
}

async function expandChartConfig(section: Locator) {
  const toggle = section.getByRole('button', { name: /更多配置/ })
  if (await toggle.isVisible()) {
    await toggle.click()
  }
}

async function signInAsTableOwner(page: Page, tableName: string) {
  const userID = queryMO(`SELECT user_id FROM poc_user_tables WHERE table_name = '${escapeSQL(tableName)}' LIMIT 1`)
  if (!userID) {
    throw new Error(`No owner found for user table ${tableName}`)
  }

  const token = randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ')

  queryMO(
    `INSERT INTO poc_sessions (token, user_id, expires_at) VALUES ('${token}', '${escapeSQL(userID)}', '${expiresAt}')`
  )

  await page.context().addCookies([
    {
      name: 'poc_token',
      value: token,
      url: baseURL,
      httpOnly: true,
      sameSite: 'Lax',
      expires: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
    },
  ])
}

function queryMO(sql: string) {
  const env = readDotEnv()
  const accountName = getWorkspaceAccount(env)
  const host = process.env.E2E_MO_HOST ?? env.E2E_MO_HOST ?? '127.0.0.1'
  const port = process.env.E2E_MO_PORT ?? env.E2E_MO_PORT ?? '16002'
  const database = process.env.E2E_MO_DATABASE ?? env.E2E_MO_DATABASE ?? 'hk_sfc'
  const apiKey = process.env.MOI_SYSTEM_API_KEY ?? env.MOI_SYSTEM_API_KEY
  if (!apiKey) {
    throw new Error('MOI_SYSTEM_API_KEY is required for chart E2E setup')
  }

  return execFileSync(
    'mysql',
    [
      '--protocol',
      'TCP',
      '-h',
      host,
      '-P',
      port,
      '-u',
      `${accountName}:moi_core_system`,
      `-p${apiKey}`,
      database,
      '-N',
      '-B',
      '-e',
      sql,
    ],
    { encoding: 'utf8' }
  ).trim()
}

function getWorkspaceAccount(env: Record<string, string>) {
  const apiKey = process.env.MOI_SYSTEM_API_KEY ?? env.MOI_SYSTEM_API_KEY
  const workspaceID = process.env.POC_WORKSPACE_ID ?? env.POC_WORKSPACE_ID
  const catalogURL = process.env.CATALOG_URL ?? env.CATALOG_URL ?? 'http://localhost:8084'
  if (!apiKey || !workspaceID) {
    throw new Error('POC_WORKSPACE_ID and MOI_SYSTEM_API_KEY are required for chart E2E setup')
  }

  const body = execFileSync(
    'curl',
    ['-s', '-H', `X-API-Key: ${apiKey}`, `${catalogURL}/api/v1/workspaces/${workspaceID}`],
    { encoding: 'utf8' }
  )
  const parsed = JSON.parse(body) as { data?: { account_name?: string } }
  const accountName = parsed.data?.account_name
  if (!accountName) {
    throw new Error(`Catalog workspace response did not include account_name: ${body}`)
  }
  return accountName
}

function readDotEnv() {
  const content = readFileSync(new URL('../../.env', import.meta.url), 'utf8')
  const env: Record<string, string> = {}
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (!match) continue
    env[match[1]] = match[2].replace(/^['"]|['"]$/g, '')
  }
  return env
}

function escapeSQL(value: string) {
  return value.replace(/'/g, "''")
}
