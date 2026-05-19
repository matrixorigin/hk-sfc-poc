package main

import (
	"os"
	"testing"
)

func TestMetricRegistryScopesBareColumnBySQLTable(t *testing.T) {
	reg := testMetricRegistry(t, `
metrics:
  - column: ms_t_stk_sis.trade_date
    name: 个股交易日期
    explain: sis date
    code: sis code
    source: sis source
  - column: ms_t_stk_hsi.trade_date
    name: 恒指交易日期
    explain: hsi date
    code: hsi code
    source: hsi source
  - column: sehknews.trade_date
    name: 公告影响交易日
    explain: news date
    code: news code
    source: news source
  - column: ms_v_stk_hsi_daily.trade_date
    name: 恒指日线交易日期
    explain: daily date
    code: daily code
    source: daily source
  - column: ms_v_stk_hsi_daily.HSHSI
    name: 恒指日线收盘值
    explain: daily close
    code: daily close code
    source: daily close source
`)

	sql := "SELECT HSHSI FROM ms_v_stk_hsi_daily WHERE trade_date = '2025-01-02'"
	hits := reg.MatchSQLAndColumns(sql, []string{"HSHSI"})

	assertMetricColumns(t, hits, []string{
		"ms_v_stk_hsi_daily.HSHSI",
		"ms_v_stk_hsi_daily.trade_date",
	})
}

func TestMetricRegistryKeepsRelevantJoinedPrecomputes(t *testing.T) {
	reg := testMetricRegistry(t, `
metrics:
  - column: ms_t_stk_sis.avg_vol_30d
    name: 30日平均成交量
    explain: avg vol
    code: avg code
    source: avg source
  - column: sehknews.trade_date
    name: 公告影响交易日
    explain: news date
    code: news date code
    source: news date source
  - column: ms_t_stk_hsi.trade_date
    name: 恒指交易日期
    explain: hsi date
    code: hsi date code
    source: hsi date source
`)

	sql := `SELECT n.trade_date, s.SISTKC, s.avg_vol_30d
FROM sehknews n
JOIN ms_t_stk_sis s ON n.securitycode = s.SISTKC AND n.trade_date = s.trade_date
WHERE s.avg_vol_30d > 0`
	hits := reg.MatchSQLAndColumns(sql, []string{"trade_date", "SISTKC", "avg_vol_30d"})

	assertMetricColumns(t, hits, []string{
		"ms_t_stk_sis.avg_vol_30d",
		"sehknews.trade_date",
	})
}

func testMetricRegistry(t *testing.T, yaml string) *MetricRegistry {
	t.Helper()
	path := t.TempDir() + "/metrics.yaml"
	if err := os.WriteFile(path, []byte(yaml), 0o644); err != nil {
		t.Fatalf("write metrics: %v", err)
	}
	reg, err := LoadMetrics(path)
	if err != nil {
		t.Fatalf("load metrics: %v", err)
	}
	return reg
}

func assertMetricColumns(t *testing.T, hits []MetricDef, want []string) {
	t.Helper()
	if len(hits) != len(want) {
		t.Fatalf("got %d hits %#v, want %d %#v", len(hits), hits, len(want), want)
	}
	for i := range want {
		if hits[i].Column != want[i] {
			t.Fatalf("hit %d = %s, want %s; all hits %#v", i, hits[i].Column, want[i], hits)
		}
	}
}
