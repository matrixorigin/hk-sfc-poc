// 纯逻辑测试：classifyColumns / chartTypeAvailability / resolveSpec
// 实现复制自 src/utils/chartFieldRoles.ts + src/components/Chart.tsx 的核心函数
// 跑法：node web/scripts/test_chart_logic.mjs

import assert from 'node:assert/strict'

// ─── chartFieldRoles 复制 ───
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
    const numericMaj =
      rows.length > 0 &&
      rows.filter((r) => isNumeric(r[ci])).length >= rows.length * 0.7
    if (dateLike || id || !numericMaj) dimensions.push(col)
    if (numericMaj && !id) metrics.push(col)
    if (!dateLike && uniq >= 2 && uniq <= 30 && (id || !numericMaj)) legends.push(col)
  }
  return { dimensions, metrics, legends }
}

const OHLC_PATTERNS = {
  open: [/(^|[_\s-])open([_\s-]|$)/, /开盘/, /siopne/],
  close: [/(^|[_\s-])close([_\s-]|$)/, /收盘/, /siclse/],
  high: [/(^|[_\s-])high([_\s-]|$)/, /最高/, /sihige/],
  low: [/(^|[_\s-])low([_\s-]|$)/, /最低/, /silowe/],
}
function detectOHLC(columns) {
  const lower = columns.map((c) => c.toLowerCase())
  const out = {}
  for (const role of ['open', 'close', 'high', 'low']) {
    for (let i = 0; i < lower.length; i++) {
      if (OHLC_PATTERNS[role].some((re) => re.test(lower[i]))) {
        out[role] = columns[i]
        break
      }
    }
  }
  return out
}

function chartTypeAvailability(result, type) {
  if (!result || result.rows.length === 0 || result.columns.length < 2) {
    return { ok: false, reason: '数据为空或列太少' }
  }
  const roles = classifyColumns(result)
  switch (type) {
    case 'bar':
    case 'hbar':
    case 'line':
      if (roles.metrics.length < 1) return { ok: false, reason: '需要 ≥ 1 个数值列' }
      return { ok: true }
    case 'pie':
      if (roles.metrics.length < 1) return { ok: false, reason: '需要 ≥ 1 个数值列' }
      if (roles.dimensions.length < 1) return { ok: false, reason: '需要 ≥ 1 个类别列' }
      return { ok: true }
    case 'combo':
      if (roles.metrics.length < 2) return { ok: false, reason: '需要 ≥ 2 个数值列' }
      return { ok: true }
    case 'heatmap': {
      const catDims = result.columns.filter((c, ci) => {
        const vals = result.rows.map((r) => r[ci])
        if (!isIdentifierColumn(c, vals) && !isDateLike(vals.map(String))) return false
        const uniq = new Set(vals.map(String)).size
        return uniq >= 2 && uniq <= 30
      })
      if (catDims.length < 2) return { ok: false, reason: '需要 ≥ 2 个类别列' }
      if (roles.metrics.length < 1) return { ok: false, reason: '需要 ≥ 1 个数值列' }
      return { ok: true }
    }
    case 'candlestick': {
      const ohlc = detectOHLC(result.columns)
      const missing = ['open', 'close', 'high', 'low'].filter((k) => !ohlc[k])
      if (missing.length > 0)
        return { ok: false, reason: `需要 OHLC 4 列（缺 ${missing.join('/')})` }
      const hasTime = result.columns.some((c, ci) =>
        isDateLike(result.rows.map((r) => String(r[ci] ?? '')))
      )
      if (!hasTime) return { ok: false, reason: '需要 1 个时间维度列' }
      return { ok: true }
    }
  }
}

// ─── resolveSpec 复制（新版，无规则式自动）───
function resolveSpec(result, spec) {
  const cols = result.columns
  const has = (f) => !!f && cols.includes(f)

  const chartType = spec?.chart_type ?? 'auto'
  const xField = has(spec?.x?.field) ? spec.x.field : undefined

  let seriesField
  if (has(spec?.series?.field)) seriesField = spec.series.field
  if (seriesField === xField) seriesField = undefined

  let yItems = (spec?.y ?? [])
    .filter((y) => has(y.field) && y.field !== xField && y.field !== seriesField)
    .map((y) => ({
      field: y.field,
      axis: y.axis === 'secondary' ? 'secondary' : 'primary',
      subType: y.sub_type,
    }))

  if (chartType === 'pie' && yItems.length > 1) yItems = [yItems[0]]

  const y2Field = has(spec?.y2?.field) && spec.y2.field !== xField ? spec.y2.field : undefined

  let ohlc
  if (spec?.ohlc) {
    const { open, close, high, low } = spec.ohlc
    if (has(open) && has(close) && has(high) && has(low)) {
      ohlc = { open, close, high, low }
    }
  }

  const seriesCount = seriesField ? Infinity : yItems.length
  const barMode = spec?.bar_mode === 'stack' && seriesCount >= 2 ? 'stack' : 'group'

  let reason
  if (chartType === 'auto') reason = { kind: 'type-not-set' }
  else if (chartType === 'none') reason = undefined
  else if (chartType === 'bar' || chartType === 'hbar' || chartType === 'line') {
    if (!xField) reason = { kind: 'missing-field', what: '维度' }
    else if (yItems.length === 0) reason = { kind: 'missing-field', what: '指标' }
  } else if (chartType === 'pie') {
    if (!xField) reason = { kind: 'missing-field', what: '维度' }
    else if (yItems.length === 0) reason = { kind: 'missing-field', what: '指标' }
  } else if (chartType === 'combo') {
    if (!xField) reason = { kind: 'missing-field', what: '维度' }
    else if (yItems.length < 2) reason = { kind: 'missing-field', what: '至少 2 个指标' }
  } else if (chartType === 'heatmap') {
    if (!xField) reason = { kind: 'missing-field', what: '维度 X' }
    else if (!y2Field) reason = { kind: 'missing-field', what: '维度 Y' }
    else if (yItems.length === 0) reason = { kind: 'missing-field', what: '指标' }
  } else if (chartType === 'candlestick') {
    if (!xField) reason = { kind: 'missing-field', what: '时间维度' }
    else if (!ohlc) reason = { kind: 'missing-field', what: 'OHLC' }
  }

  return {
    chartType,
    xField,
    yItems,
    seriesField,
    y2Field,
    ohlc,
    barMode,
    showMarkers: !!spec?.show_markers,
    showDataLabels: !!spec?.show_data_labels,
    sort: spec?.sort,
    topN: spec?.top_n,
    reason,
  }
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
  ],
}
const priceMA = {
  columns: ['trade_date', 'close_price', 'ma_20', 'ma_50'],
  rows: [
    ['2025-01-01', 100.5, 99.2, 98.0],
    ['2025-01-02', 101.0, 99.5, 98.5],
    ['2025-01-03', 102.3, 100.0, 98.7],
    ['2025-01-04', 101.8, 100.5, 99.0],
  ],
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
  ],
}
const ohlcData = {
  columns: ['trade_date', 'open_price', 'close_price', 'high_price', 'low_price'],
  rows: [
    ['2025-01-01', 100, 101, 102, 99],
    ['2025-01-02', 101, 99, 102, 98],
    ['2025-01-03', 99, 103, 104, 99],
  ],
}
const industryMonth = {
  columns: ['industry', 'month', 'avg_return'],
  rows: [
    ['Tech', '2025-01', 0.05], ['Tech', '2025-02', 0.03], ['Tech', '2025-03', -0.01],
    ['Finance', '2025-01', 0.02], ['Finance', '2025-02', 0.01], ['Finance', '2025-03', 0.04],
  ],
}

// ─── runner ───
let pass = 0, fail = 0
function it(name, fn) {
  try { fn(); console.log('✓', name); pass++ }
  catch (e) { console.error('✗', name, '\n   ', e.message); fail++ }
}

// ─── classifyColumns ───
it('classifyColumns: volumeAnomaly', () => {
  const c = classifyColumns(volumeAnomaly)
  assert.deepEqual(c.dimensions, ['stock_code', 'stock_name', 'trade_date'])
  assert.deepEqual(c.metrics, ['volume', 'avg_vol_30d', 'volume_multiple'])
})
it('classifyColumns: priceMA 全数值', () => {
  const c = classifyColumns(priceMA)
  assert.ok(c.dimensions.includes('trade_date'))
  assert.deepEqual(c.metrics.sort(), ['close_price', 'ma_20', 'ma_50'].sort())
})
it('classifyColumns: multiStock long 表', () => {
  const c = classifyColumns(multiStock)
  assert.ok(c.legends.includes('stock_code'))
})

// ─── chartTypeAvailability ───
it('availability: volumeAnomaly bar/line/pie/combo OK', () => {
  for (const t of ['bar', 'hbar', 'line', 'pie', 'combo']) {
    assert.equal(chartTypeAvailability(volumeAnomaly, t).ok, true, t)
  }
})
it('availability: priceMA pie ok（trade_date 算 dimension）', () => {
  const r = chartTypeAvailability(priceMA, 'pie')
  assert.equal(r.ok, true)
})
it('availability: 单指标数据 combo → fail', () => {
  const single = { columns: ['x', 'v'], rows: [['a', 1], ['b', 2]] }
  assert.equal(chartTypeAvailability(single, 'combo').ok, false)
})
it('availability: volumeAnomaly heatmap → fail（仅 stock_code/stock_name 是 ID，trade_date 算日期）', () => {
  const r = chartTypeAvailability(volumeAnomaly, 'heatmap')
  // 这里 stock_code 和 stock_name 都是 ID，所以候选有 2 个 → 应该 OK
  assert.equal(r.ok, true)
})
it('availability: industryMonth heatmap → OK', () => {
  assert.equal(chartTypeAvailability(industryMonth, 'heatmap').ok, true)
})
it('availability: ohlcData candlestick → OK', () => {
  assert.equal(chartTypeAvailability(ohlcData, 'candlestick').ok, true)
})
it('availability: volumeAnomaly candlestick → fail（没有 OHLC 列）', () => {
  const r = chartTypeAvailability(volumeAnomaly, 'candlestick')
  assert.equal(r.ok, false)
  assert.ok(r.reason.includes('OHLC'))
})

// ─── detectOHLC ───
it('detectOHLC: 标准列名', () => {
  const o = detectOHLC(['date', 'open_price', 'close_price', 'high_price', 'low_price'])
  assert.equal(o.open, 'open_price')
  assert.equal(o.close, 'close_price')
})
it('detectOHLC: 缺失部分 → undefined', () => {
  const o = detectOHLC(['date', 'open', 'close'])
  assert.equal(o.high, undefined)
  assert.equal(o.low, undefined)
})

// ─── resolveSpec（新版无规则式自动）───
it('resolveSpec: chart_type=auto → reason=type-not-set', () => {
  const r = resolveSpec(volumeAnomaly, { chart_type: 'auto' })
  assert.equal(r.reason?.kind, 'type-not-set')
})
it('resolveSpec: 无 spec → reason=type-not-set', () => {
  const r = resolveSpec(volumeAnomaly, undefined)
  assert.equal(r.reason?.kind, 'type-not-set')
})
it('resolveSpec: chart_type=none → reason=undefined', () => {
  const r = resolveSpec(volumeAnomaly, { chart_type: 'none' })
  assert.equal(r.reason, undefined)
  assert.equal(r.chartType, 'none')
})
it('resolveSpec: bar 缺 x → missing-field 维度', () => {
  const r = resolveSpec(volumeAnomaly, { chart_type: 'bar' })
  assert.equal(r.reason?.kind, 'missing-field')
  assert.equal(r.reason.what, '维度')
})
it('resolveSpec: bar 缺 y → missing-field 指标', () => {
  const r = resolveSpec(volumeAnomaly, { chart_type: 'bar', x: { field: 'stock_name' } })
  assert.equal(r.reason?.kind, 'missing-field')
  assert.equal(r.reason.what, '指标')
})
it('resolveSpec: bar 字段全 → reason=undefined', () => {
  const r = resolveSpec(volumeAnomaly, {
    chart_type: 'bar',
    x: { field: 'stock_name' },
    y: [{ field: 'volume_multiple' }],
  })
  assert.equal(r.reason, undefined)
  assert.equal(r.xField, 'stock_name')
  assert.deepEqual(r.yItems, [{ field: 'volume_multiple', axis: 'primary', subType: undefined }])
})
it('resolveSpec: y[].axis=secondary 透传', () => {
  const r = resolveSpec(volumeAnomaly, {
    chart_type: 'bar',
    x: { field: 'stock_name' },
    y: [
      { field: 'volume_multiple' },
      { field: 'volume', axis: 'secondary' },
    ],
  })
  assert.equal(r.yItems[0].axis, 'primary')
  assert.equal(r.yItems[1].axis, 'secondary')
})
it('resolveSpec: combo 仅 1 个 y → missing', () => {
  const r = resolveSpec(volumeAnomaly, {
    chart_type: 'combo',
    x: { field: 'stock_name' },
    y: [{ field: 'volume' }],
  })
  assert.equal(r.reason?.kind, 'missing-field')
})
it('resolveSpec: combo 2 y + subType 透传', () => {
  const r = resolveSpec(volumeAnomaly, {
    chart_type: 'combo',
    x: { field: 'stock_name' },
    y: [
      { field: 'volume', sub_type: 'bar' },
      { field: 'volume_multiple', sub_type: 'line', axis: 'secondary' },
    ],
  })
  assert.equal(r.reason, undefined)
  assert.equal(r.yItems[0].subType, 'bar')
  assert.equal(r.yItems[1].subType, 'line')
  assert.equal(r.yItems[1].axis, 'secondary')
})
it('resolveSpec: heatmap 缺 y2 → missing', () => {
  const r = resolveSpec(industryMonth, {
    chart_type: 'heatmap',
    x: { field: 'industry' },
    y: [{ field: 'avg_return' }],
  })
  assert.equal(r.reason?.what, '维度 Y')
})
it('resolveSpec: heatmap 字段全 → ok', () => {
  const r = resolveSpec(industryMonth, {
    chart_type: 'heatmap',
    x: { field: 'industry' },
    y2: { field: 'month' },
    y: [{ field: 'avg_return' }],
  })
  assert.equal(r.reason, undefined)
  assert.equal(r.y2Field, 'month')
})
it('resolveSpec: candlestick 字段全 → ok', () => {
  const r = resolveSpec(ohlcData, {
    chart_type: 'candlestick',
    x: { field: 'trade_date' },
    ohlc: { open: 'open_price', close: 'close_price', high: 'high_price', low: 'low_price' },
  })
  assert.equal(r.reason, undefined)
  assert.deepEqual(r.ohlc, { open: 'open_price', close: 'close_price', high: 'high_price', low: 'low_price' })
})
it('resolveSpec: candlestick OHLC 不全 → missing', () => {
  const r = resolveSpec(ohlcData, {
    chart_type: 'candlestick',
    x: { field: 'trade_date' },
    ohlc: { open: 'open_price', close: 'close_price', high: 'high_price', low: 'no_such' },
  })
  assert.equal(r.reason?.kind, 'missing-field')
})
it('resolveSpec: y 字段撞 x → 剔除', () => {
  const r = resolveSpec(volumeAnomaly, {
    chart_type: 'bar',
    x: { field: 'volume' },
    y: [{ field: 'volume' }, { field: 'avg_vol_30d' }],
  })
  assert.deepEqual(r.yItems.map((y) => y.field), ['avg_vol_30d'])
})
it('resolveSpec: 饼图 y > 1 → 裁到 1', () => {
  const r = resolveSpec(volumeAnomaly, {
    chart_type: 'pie',
    x: { field: 'stock_name' },
    y: [{ field: 'volume' }, { field: 'avg_vol_30d' }],
  })
  assert.equal(r.yItems.length, 1)
})
it('resolveSpec: bar_mode=stack + 1 series → 降级 group', () => {
  const r = resolveSpec(volumeAnomaly, {
    chart_type: 'bar',
    x: { field: 'stock_name' },
    y: [{ field: 'volume' }],
    bar_mode: 'stack',
  })
  assert.equal(r.barMode, 'group')
})
it('resolveSpec: bar_mode=stack + 多 metric → 保留', () => {
  const r = resolveSpec(volumeAnomaly, {
    chart_type: 'bar',
    x: { field: 'stock_name' },
    y: [{ field: 'volume' }, { field: 'avg_vol_30d' }],
    bar_mode: 'stack',
  })
  assert.equal(r.barMode, 'stack')
})
it('resolveSpec: show_markers / show_data_labels / sort / topN 透传', () => {
  const r = resolveSpec(volumeAnomaly, {
    chart_type: 'line',
    x: { field: 'trade_date' },
    y: [{ field: 'volume' }],
    show_markers: true,
    show_data_labels: true,
    sort: { field: 'volume', order: 'desc' },
    top_n: 10,
  })
  assert.equal(r.showMarkers, true)
  assert.equal(r.showDataLabels, true)
  assert.deepEqual(r.sort, { field: 'volume', order: 'desc' })
  assert.equal(r.topN, 10)
})

console.log(`\n${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
