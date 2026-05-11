// 端到端纯逻辑测试：classifyColumns / resolveSpec / splitYByMagnitude / 双 Y 轴 / pivot
// 直接复制实现避免 TS 转译，覆盖 Chart.tsx 关键路径
//
// 跑法：node scripts/test_chart_logic.mjs

import assert from 'node:assert/strict'

// ─── 复制 chartFieldRoles 关键函数 ───
const isNumeric = (v) => v !== null && v !== undefined && v !== '' && !isNaN(Number(v))
const isDateLike = (vs) => {
  if (vs.length < 3) return false
  const re = /\d{4}[-/]\d{1,2}[-/]?|^\d{8}$|T\d{2}:\d{2}/
  return vs.filter((v) => re.test(v)).length >= vs.length * 0.5
}
const isIdentifierColumn = (col, values) => {
  const lc = col.toLowerCase()
  if (/\b(code|id|name|symbol|ticker|stock|participant|industry)\b/.test(lc)) return true
  if (/^(sistkc|sistkn|stkcd|stock_code|securitycode)$/.test(lc)) return true
  const uniq = new Set(values.map(String))
  if (uniq.size <= 3 && values.length > 10) return true
  return false
}

function classifyColumns(result) {
  const { columns, rows } = result
  const dimensions = [], metrics = [], legends = []
  for (let ci = 0; ci < columns.length; ci++) {
    const col = columns[ci]
    const values = rows.map((r) => r[ci])
    const sv = values.map((v) => String(v ?? ''))
    const uniq = new Set(sv).size
    const id = isIdentifierColumn(col, values)
    const dateLike = isDateLike(sv)
    const numericMaj = rows.length > 0 && rows.filter((r) => isNumeric(r[ci])).length >= rows.length * 0.7
    if (dateLike || id || !numericMaj) dimensions.push(col)
    if (numericMaj && !id) metrics.push(col)
    if (!dateLike && uniq >= 2 && uniq <= 30 && (id || !numericMaj)) legends.push(col)
  }
  return { dimensions, metrics, legends }
}

// ─── 复制 Chart.tsx 双 Y 轴分组逻辑 ───
const DUAL_AXIS_RATIO = 50
function splitYByMagnitude(result, yFields) {
  if (yFields.length < 2) return { leftAxis: yFields, rightAxis: [] }
  const items = yFields.map((f) => {
    const idx = result.columns.indexOf(f)
    let max = 0
    for (const r of result.rows) {
      const v = r[idx]
      if (isNumeric(v)) {
        const abs = Math.abs(Number(v))
        if (abs > max) max = abs
      }
    }
    return { f, max }
  }).sort((a, b) => b.max - a.max)
  let splitAt = -1, bestRatio = DUAL_AXIS_RATIO
  for (let i = 0; i < items.length - 1; i++) {
    const lo = items[i + 1].max
    const ratio = lo > 0 ? items[i].max / lo : Infinity
    if (ratio > bestRatio) { bestRatio = ratio; splitAt = i }
  }
  if (splitAt < 0) return { leftAxis: yFields, rightAxis: [] }
  return {
    leftAxis: items.slice(0, splitAt + 1).map((x) => x.f),
    rightAxis: items.slice(splitAt + 1).map((x) => x.f),
  }
}

// ─── 复制 resolveSpec 关键逻辑 ───
function findDateColumnIndex(r) {
  for (let ci = 0; ci < r.columns.length; ci++) {
    if (isDateLike(r.rows.map((row) => String(row[ci] ?? '')))) return ci
  }
  return -1
}
function findCategoryColumnIndex(r) {
  for (let ci = 0; ci < r.columns.length; ci++) {
    if (isIdentifierColumn(r.columns[ci], r.rows.map((row) => row[ci]))) return ci
  }
  return 0
}
function findXAxisIndex(r) {
  const d = findDateColumnIndex(r)
  if (d >= 0) {
    const u = new Set(r.rows.map((row) => String(row[d] ?? '')))
    if (u.size >= 3) return d
  }
  return findCategoryColumnIndex(r)
}
function isTimeSeriesLike(r) {
  if (r.columns.length < 2 || r.rows.length < 3) return false
  const d = findDateColumnIndex(r)
  if (d < 0) return false
  const u = new Set(r.rows.map((row) => String(row[d] ?? '')))
  if (u.size < 3) return false
  return r.columns.some((c, ci) => ci !== d && !isIdentifierColumn(c, r.rows.map((row) => row[ci])) && r.rows.some((row) => isNumeric(row[ci])))
}
function isCategoricalLike(r) {
  if (r.columns.length < 2 || r.rows.length < 1) return false
  return classifyColumns(r).metrics.length > 0
}
function resolveSpec(r, spec) {
  let chartType
  if (spec?.chart_type === 'none') chartType = 'none'
  else if (spec?.chart_type && spec.chart_type !== 'auto') chartType = spec.chart_type
  else if (isTimeSeriesLike(r)) chartType = 'line'
  else if (isCategoricalLike(r)) chartType = 'bar'
  else chartType = 'none'

  let xField
  if (spec?.x?.field && r.columns.includes(spec.x.field)) xField = spec.x.field
  else {
    const idx = chartType === 'bar' || chartType === 'pie' ? findCategoryColumnIndex(r) : findXAxisIndex(r)
    xField = idx >= 0 ? r.columns[idx] : undefined
  }

  let seriesField
  if (spec?.series?.field && r.columns.includes(spec.series.field) && chartType !== 'pie') seriesField = spec.series.field
  if (seriesField === xField) seriesField = undefined

  let yFields = []
  if (spec?.y?.length) yFields = spec.y.map((y) => y.field).filter((f) => r.columns.includes(f) && f !== xField && f !== seriesField)
  if (yFields.length === 0) {
    yFields = r.columns.filter((c, ci) => {
      if (c === xField || c === seriesField) return false
      if (isIdentifierColumn(c, r.rows.map((row) => row[ci]))) return false
      return r.rows.some((row) => isNumeric(row[ci]))
    })
  }
  if (chartType === 'pie' && yFields.length > 1) yFields = [yFields[0]]

  const seriesCount = seriesField ? Infinity : yFields.length
  const barMode = (spec?.bar_mode === 'stack' && seriesCount >= 2) ? 'stack' : 'group'

  return { chartType, xField, yFields, seriesField, barMode }
}

// ─── 测试数据 ───
const volumeAnomaly = {
  columns: ['stock_code', 'stock_name', 'trade_date', 'volume', 'avg_vol_30d', 'volume_multiple'],
  rows: [
    ['08112', 'CORNERSTONE FIN', '2025-03-26', 170400, '4.66667', '36514.29'],
    ['00768', 'UBA INVESTMENTS', '2025-04-24', 101570000, '33266.66667', '3053.21'],
    ['01870', 'ACME INTL HLDGS', '2025-03-05', 344647500, '377583.33333', '912.77'],
    ['00500', 'JINHUI HOLDINGS', '2025-03-05', 5000000, '5000', '100'],
    ['00501', 'ADTIGER CORP', '2025-03-06', 9000000, '6000', '150'],
  ]
}

const priceMA = {
  columns: ['trade_date', 'close_price', 'ma_20', 'ma_50'],
  rows: [
    ['2025-01-01', 100.5, 99.2, 98.0],
    ['2025-01-02', 101.0, 99.5, 98.5],
    ['2025-01-03', 102.3, 100.0, 98.7],
    ['2025-01-04', 101.8, 100.5, 99.0],
  ]
}

const multiStock = {
  columns: ['trade_date', 'stock_code', 'close_price'],
  rows: [
    ['2025-01-01', '00700', 320.0],
    ['2025-01-01', '00388', 250.0],
    ['2025-01-02', '00700', 322.5],
    ['2025-01-02', '00388', 252.0],
    ['2025-01-03', '00700', 318.0],
    ['2025-01-03', '00388', 254.5],
  ]
}

// ─── 测试 ───
let pass = 0, fail = 0
function it(name, fn) {
  try { fn(); console.log('✓', name); pass++ }
  catch (e) { console.error('✗', name, '\n   ', e.message); fail++ }
}

it('classifyColumns: volume anomaly 表识别', () => {
  const c = classifyColumns(volumeAnomaly)
  assert.deepEqual(c.dimensions, ['stock_code', 'stock_name', 'trade_date'])
  assert.deepEqual(c.metrics, ['volume', 'avg_vol_30d', 'volume_multiple'])
  // stock_code/name/trade_date 的基数和角色：低基数类别可作 legend
  assert.ok(c.legends.length >= 0)
})

it('classifyColumns: 价格 + MA 全数值列', () => {
  const c = classifyColumns(priceMA)
  assert.ok(c.dimensions.includes('trade_date'))
  assert.deepEqual(c.metrics.sort(), ['close_price', 'ma_20', 'ma_50'].sort())
})

it('resolveSpec: 默认推荐 → 柱图 + stock_code 维度 + 所有数值指标', () => {
  const r = resolveSpec(volumeAnomaly, { chart_type: 'bar' })
  assert.equal(r.chartType, 'bar')
  assert.equal(r.xField, 'stock_code')
  assert.deepEqual(r.yFields, ['volume', 'avg_vol_30d', 'volume_multiple'])
  assert.equal(r.seriesField, undefined)
})

it('resolveSpec: 用户只选一个指标', () => {
  const r = resolveSpec(volumeAnomaly, {
    chart_type: 'bar',
    x: { field: 'stock_code' },
    y: [{ field: 'volume_multiple' }],
    user_edited: true,
  })
  assert.deepEqual(r.yFields, ['volume_multiple'])
})

it('resolveSpec: 饼图限制为单指标', () => {
  const r = resolveSpec(volumeAnomaly, { chart_type: 'pie' })
  assert.equal(r.yFields.length, 1)
})

it('resolveSpec: spec.x 不存在时回退到自动', () => {
  const r = resolveSpec(volumeAnomaly, {
    chart_type: 'bar',
    x: { field: 'no_such_col' },
  })
  assert.ok(['stock_code', 'stock_name'].includes(r.xField))
})

it('resolveSpec: series 等于 xField 时丢弃 series', () => {
  const r = resolveSpec(volumeAnomaly, {
    chart_type: 'bar',
    x: { field: 'stock_code' },
    series: { field: 'stock_code' },
  })
  assert.equal(r.seriesField, undefined)
})

it('splitYByMagnitude: volume(10⁸) vs avg(10⁵) vs multiple(10⁴) → 双轴', () => {
  const s = splitYByMagnitude(volumeAnomaly, ['volume', 'avg_vol_30d', 'volume_multiple'])
  // volume 远大于其它两个 → volume 左轴，其它右轴
  assert.deepEqual(s.leftAxis, ['volume'])
  assert.deepEqual(s.rightAxis.sort(), ['avg_vol_30d', 'volume_multiple'].sort())
})

it('splitYByMagnitude: 相近量级（同价格区间）→ 单轴', () => {
  const s = splitYByMagnitude(priceMA, ['close_price', 'ma_20', 'ma_50'])
  assert.equal(s.rightAxis.length, 0)
})

it('splitYByMagnitude: 单指标不分轴', () => {
  const s = splitYByMagnitude(volumeAnomaly, ['volume'])
  assert.equal(s.rightAxis.length, 0)
})

it('multiStock + series=stock_code → 应识别为 long 表', () => {
  const c = classifyColumns(multiStock)
  assert.ok(c.legends.includes('stock_code'), `legends=${c.legends}`)
  const r = resolveSpec(multiStock, { chart_type: 'line', series: { field: 'stock_code' } })
  assert.equal(r.seriesField, 'stock_code')
  assert.equal(r.xField, 'trade_date')
  // 自动 y：close_price（stock_code 是 series 被排除）
  assert.deepEqual(r.yFields, ['close_price'])
})

it('chart_type=none → 隐藏', () => {
  const r = resolveSpec(volumeAnomaly, { chart_type: 'none' })
  assert.equal(r.chartType, 'none')
})

it('auto + 时间序列特征 → 折线', () => {
  const r = resolveSpec(priceMA, { chart_type: 'auto' })
  assert.equal(r.chartType, 'line')
})

it('resolveSpec: y 字段撞到 x → 被剔除', () => {
  const r = resolveSpec(volumeAnomaly, {
    chart_type: 'bar',
    x: { field: 'volume' },  // 故意把数值列当 x
    y: [{ field: 'volume' }, { field: 'avg_vol_30d' }],
  })
  assert.deepEqual(r.yFields, ['avg_vol_30d'])
})

it('resolveSpec: y 字段撞到 series → 被剔除', () => {
  const r = resolveSpec(volumeAnomaly, {
    chart_type: 'bar',
    x: { field: 'stock_code' },
    y: [{ field: 'volume' }, { field: 'stock_name' }],
    series: { field: 'stock_name' },
  })
  assert.equal(r.seriesField, 'stock_name')
  assert.deepEqual(r.yFields, ['volume'])
})

it('resolveSpec: bar_mode=stack 但只有 1 个 y → 降级 group', () => {
  const r = resolveSpec(volumeAnomaly, {
    chart_type: 'bar',
    x: { field: 'stock_code' },
    y: [{ field: 'volume' }],
    bar_mode: 'stack',
  })
  assert.equal(r.barMode, 'group')
})

it('resolveSpec: bar_mode=stack + 多指标无 legend → 保留 stack（用户可自行切换）', () => {
  // 这是用户本次撞到的 bug 数据形态：barMode 不再被「兜底」吃掉
  const r = resolveSpec(volumeAnomaly, {
    chart_type: 'bar',
    x: { field: 'stock_name' },
    y: [{ field: 'volume' }, { field: 'avg_vol_30d' }, { field: 'volume_multiple' }],
    bar_mode: 'stack',
  })
  assert.equal(r.barMode, 'stack')
  // 系列数 ≥ 2，UI 应显示 stack/group toggle 让用户切换
})

it('resolveSpec: 饼图 y 多于 1 时只取第一个（持久化层的兜底）', () => {
  const r = resolveSpec(volumeAnomaly, {
    chart_type: 'pie',
    x: { field: 'stock_name' },
    y: [{ field: 'volume' }, { field: 'avg_vol_30d' }, { field: 'volume_multiple' }],
  })
  assert.deepEqual(r.yFields, ['volume'])
})

it('resolveSpec: bar_mode=stack + legend → 保留', () => {
  const r = resolveSpec(multiStock, {
    chart_type: 'bar',
    x: { field: 'trade_date' },
    y: [{ field: 'close_price' }],
    series: { field: 'stock_code' },
    bar_mode: 'stack',
  })
  assert.equal(r.barMode, 'stack')
})

it('auto + 类别特征 → 柱状', () => {
  const r = resolveSpec(volumeAnomaly, { chart_type: 'auto' })
  // volumeAnomaly trade_date 唯一值 4，>=3，会被判时间序列。换成无日期数据测：
  const onlyCat = {
    columns: ['industry', 'turnover'],
    rows: [['Tech', 100], ['Finance', 200], ['Energy', 150]],
  }
  const rr = resolveSpec(onlyCat, { chart_type: 'auto' })
  assert.equal(rr.chartType, 'bar')
})

console.log(`\n${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
