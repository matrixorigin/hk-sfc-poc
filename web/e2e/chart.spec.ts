import { expect, test, type Page } from '@playwright/test'

const chartMissingPattern = /请绑定|请选择图表类型|Open \/ Close/
const password = 'charttest123'

type ChartName = '折线' | '柱状' | '条形' | '饼图' | '组合' | '热力' | '蜡烛' | '隐藏'

test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await register(page)
})

test('单轮生成：蜡烛图绑定 OHLC 并渲染', async ({ page }) => {
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
  await expect(section.locator('.cfs-mpill')).toHaveCount(2)
  await expect(section).toContainText(/HSHSI|恒生指数/)
  await expect(section).toContainText(/hsi_pct_change|涨跌幅/)
})

test('单轮生成：折线图渲染', async ({ page }) => {
  await sendPrompt(page, '展示2025年1月新华电源每日收盘价，用折线图表示。')
  await expectChartReady(page, '折线')
})

test('单轮生成：条形图渲染', async ({ page }) => {
  await sendPrompt(page, '列出2025年一季度涨幅最高的10只股票，用条形图展示。')
  await expectChartReady(page, '条形')
})

test('二轮修改：折线图改成柱状图', async ({ page }) => {
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

async function register(page: Page) {
  const username = `chart_e2e_${Date.now().toString().slice(-8)}_${Math.floor(Math.random() * 1000)}`
  await page.getByRole('button', { name: '注册' }).click()
  await page.locator('input[type="text"]').fill(username)
  await page.locator('input[type="password"]').nth(0).fill(password)
  await page.locator('input[type="password"]').nth(1).fill(password)
  await page.locator('form button[type="submit"]').click()
  await expect(page.locator('textarea')).toBeVisible({ timeout: 15_000 })
}

async function sendPrompt(page: Page, prompt: string) {
  await page.locator('textarea').fill(prompt)
  await page.locator('.btn-send').click()
  await expect(page.locator('.btn-send')).toBeDisabled({ timeout: 5_000 })
  await expect(page.locator('.btn-send')).toBeEnabled({ timeout: 180_000 })
}

async function expectChartReady(page: Page, chartName: ChartName) {
  const section = page.locator('.chart-section').last()
  await expect(section).toBeVisible({ timeout: 20_000 })
  await expect(section.getByRole('button', { name: chartName, exact: true })).toHaveClass(/active/)
  await expect(section).not.toContainText(chartMissingPattern)
  const canvas = section.locator('canvas').first()
  await expect(canvas).toBeVisible()
  await expect
    .poll(async () => canvas.evaluate((node) => node.width > 80 && node.height > 80))
    .toBe(true)
}
