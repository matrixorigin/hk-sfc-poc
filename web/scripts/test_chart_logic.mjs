// 纯逻辑测试：chartTypeAvailability / resolveSpec
// 实现复制自 src/utils/chartFieldRoles.ts + src/components/Chart.tsx 的核心函数
// 跑法：node web/scripts/test_chart_logic.mjs

import assert from 'node:assert/strict'

// ─── chartTypeAvailability 复制（纯形状判断）───
const MIN_COLS = {
  bar: 2, hbar: 2, line: 2, pie: 2, combo: 3, heatmap: 3, candlestick: 5,
}
function chartTypeAvailability(result, type) {
  if (!result || result.rows.length === 0) {
    return { ok: false, reason: { kind: 'empty' } }
  }
  const need = MIN_COLS[type]
  if (result.columns.length < need) {
    return { ok: false, reason: { kind: 'need-cols', n: need } }
  }
  return { ok: true }
}

// ─── resolveSpec 复制（与 Chart.tsx 一致）───
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
    ['Tech', '2025-01', 0.05], ['Tech', '2025-02', 0.03],
    ['Finance', '2025-01', 0.02], ['Finance', '2025-02', 0.01],
  ],
}

// ─── runner ───
let pass = 0, fail = 0
function it(name, fn) {
  try { fn(); console.log('✓', name); pass++ }
  catch (e) { console.error('✗', name, '\n   ', e.message); fail++ }
}

// ─── chartTypeAvailability (纯形状) ───
it('availability: empty rows → empty', () => {
  const r = chartTypeAvailability({ columns: ['a', 'b'], rows: [] }, 'bar')
  assert.equal(r.ok, false)
  assert.equal(r.reason.kind, 'empty')
})
it('availability: 2 列 → bar/hbar/line/pie OK', () => {
  const d = { columns: ['x', 'y'], rows: [['a', 1], ['b', 2], ['c', 3]] }
  for (const t of ['bar', 'hbar', 'line', 'pie']) {
    assert.equal(chartTypeAvailability(d, t).ok, true, t)
  }
})
it('availability: 2 列 combo/heatmap → need 3 cols', () => {
  const d = { columns: ['x', 'y'], rows: [['a', 1], ['b', 2]] }
  for (const t of ['combo', 'heatmap']) {
    const r = chartTypeAvailability(d, t)
    assert.equal(r.ok, false)
    assert.equal(r.reason.kind, 'need-cols')
    assert.equal(r.reason.n, 3)
  }
})
it('availability: 3 列 → combo/heatmap OK', () => {
  const d = { columns: ['a', 'b', 'c'], rows: [[1, 2, 3], [4, 5, 6], [7, 8, 9]] }
  assert.equal(chartTypeAvailability(d, 'combo').ok, true)
  assert.equal(chartTypeAvailability(d, 'heatmap').ok, true)
})
it('availability: 4 列 candlestick → need 5 cols', () => {
  const d = { columns: ['a', 'b', 'c', 'd'], rows: [[1, 2, 3, 4]] }
  const r = chartTypeAvailability(d, 'candlestick')
  assert.equal(r.ok, false)
  assert.equal(r.reason.kind, 'need-cols')
  assert.equal(r.reason.n, 5)
})
it('availability: 5 列（任意列名）candlestick → OK', () => {
  const d = {
    columns: ['t', 'a', 'b', 'c', 'd'],
    rows: [['2025-01-01', 1, 2, 3, 4], ['2025-01-02', 2, 3, 4, 5]],
  }
  assert.equal(chartTypeAvailability(d, 'candlestick').ok, true)
})
it('availability: volumeAnomaly 6 列 → 所有类型 OK', () => {
  for (const t of ['bar', 'hbar', 'line', 'pie', 'combo', 'heatmap', 'candlestick']) {
    assert.equal(chartTypeAvailability(volumeAnomaly, t).ok, true, t)
  }
})
it('availability: ohlcData 5 列 → candlestick OK', () => {
  assert.equal(chartTypeAvailability(ohlcData, 'candlestick').ok, true)
})

// ─── resolveSpec ───
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
