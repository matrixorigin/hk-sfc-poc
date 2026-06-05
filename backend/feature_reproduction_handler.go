package main

import (
	"archive/zip"
	"bytes"
	_ "embed"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"
)

//go:embed reproduction_assets/10_reproduce_features.py
var reproduceFeaturesScript string

type FeatureReproductionHandler struct {
	metrics *MetricRegistry
}

func NewFeatureReproductionHandler(metrics *MetricRegistry) *FeatureReproductionHandler {
	return &FeatureReproductionHandler{metrics: metrics}
}

type featureScriptAsset struct {
	Body        string
	Filename    string
	ContentType string
}

type featurePackageRequest struct {
	Question string      `json:"question,omitempty"`
	SQL      string      `json:"sql"`
	Columns  []string    `json:"columns,omitempty"`
	Metrics  []MetricDef `json:"metrics,omitempty"`
}

type featurePackageManifest struct {
	GeneratedAt string      `json:"generated_at"`
	Question    string      `json:"question,omitempty"`
	SQL         string      `json:"sql"`
	Columns     []string    `json:"columns,omitempty"`
	Metrics     []MetricDef `json:"metrics"`
	Coverage    []string    `json:"coverage"`
	Run         []string    `json:"run"`
	Verify      []string    `json:"verify"`
	Apply       []string    `json:"apply"`
}

func (h *FeatureReproductionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if strings.HasSuffix(r.URL.Path, "/script") {
		h.serveScript(w, r)
		return
	}
	h.servePackage(w, r)
}

func (h *FeatureReproductionHandler) serveScript(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	table := strings.TrimSpace(r.URL.Query().Get("table"))
	column := strings.TrimSpace(r.URL.Query().Get("column"))
	asset := featureScriptAsset{
		Body:        reproduceFeaturesScript,
		Filename:    "run.py",
		ContentType: "text/x-python; charset=utf-8",
	}
	if table != "" {
		asset = featureScriptForTable(table, splitColumns(r.URL.Query().Get("columns")))
	} else if column != "" {
		asset = featureScriptForColumn(column)
	}
	w.Header().Set("Content-Type", asset.ContentType)
	w.Header().Set("Content-Disposition", fmt.Sprintf(`inline; filename="%s"`, asset.Filename))
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(asset.Body))
}

func (h *FeatureReproductionHandler) servePackage(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req featurePackageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	req.SQL = strings.TrimSpace(req.SQL)
	if req.SQL == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "sql is required"})
		return
	}
	if !isReadOnly(req.SQL) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "only SELECT SQL can be packaged"})
		return
	}

	metrics := h.resolveMetrics(req)
	manifest := featurePackageManifest{
		GeneratedAt: time.Now().UTC().Format(time.RFC3339),
		Question:    req.Question,
		SQL:         req.SQL,
		Columns:     req.Columns,
		Metrics:     metrics,
		Coverage: []string{
			"ms_t_stk_hsi.trade_date",
			"ms_t_stk_sis.trade_date",
			"ms_v_stock_capital.ref_date",
			"sehknews.trade_date",
			"ms_v_stock_capital.industry_name",
			"ms_t_stk_sis.ma_3",
			"ms_t_stk_sis.ma_20",
			"ms_t_stk_sis.ma_50",
			"ms_t_stk_sis.ma_100",
			"ms_t_stk_sis.consecutive_above_ma3",
			"ms_t_stk_sis.consecutive_above_ma3_start",
			"ms_t_stk_sis.consecutive_above_ma20",
			"ms_t_stk_sis.consecutive_above_ma20_start",
			"ms_t_stk_sis.consecutive_above_ma50",
			"ms_t_stk_sis.consecutive_above_ma50_start",
			"ms_t_stk_sis.avg_vol_30d",
			"ms_v_stk_hsi_daily.trade_date",
			"ms_v_stk_hsi_daily.HSHSI",
			"ms_v_stk_hsi_daily.hsi_pct_change",
		},
		Run:    []string{"python3 run.py --mode export --output output/features"},
		Verify: []string{"python3 run.py --mode verify --output output/features"},
		Apply:  []string{"python3 run.py --mode apply --output output/features --yes"},
	}

	zipBytes, err := buildFeaturePackage(manifest)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	filename := "feature-reproduction-" + time.Now().Format("20060102-150405") + ".zip"
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(zipBytes)
}

func (h *FeatureReproductionHandler) resolveMetrics(req featurePackageRequest) []MetricDef {
	byColumn := map[string]MetricDef{}
	for _, m := range req.Metrics {
		if m.Column != "" {
			byColumn[m.Column] = m
		}
	}
	if h.metrics != nil {
		for _, m := range h.metrics.MatchSQLAndColumns(req.SQL, req.Columns) {
			byColumn[m.Column] = m
		}
	}
	out := make([]MetricDef, 0, len(byColumn))
	for _, m := range byColumn {
		out = append(out, m)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Column < out[j].Column })
	return out
}

func buildFeaturePackage(manifest featurePackageManifest) ([]byte, error) {
	buf := &bytes.Buffer{}
	zw := zip.NewWriter(buf)
	files := map[string]string{
		"README.md":     featurePackageReadme(manifest),
		"manifest.json": mustJSON(manifest),
		"query.sql":     strings.TrimSpace(manifest.SQL) + "\n",
		"run.py":        reproduceFeaturesScript,
		"run.sh":        featurePackageRunSH(),
	}
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		f, err := zw.Create(name)
		if err != nil {
			_ = zw.Close()
			return nil, err
		}
		if _, err := f.Write([]byte(files[name])); err != nil {
			_ = zw.Close()
			return nil, err
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func mustJSON(v any) string {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return "{}\n"
	}
	return string(b) + "\n"
}

func featurePackageReadme(manifest featurePackageManifest) string {
	var sb strings.Builder
	sb.WriteString("# HK_POC 数据加工复现包\n\n")
	sb.WriteString("这个包用于复现当前页面结果。普通用户只需要运行一个命令：\n\n")
	sb.WriteString("```bash\n./run.sh\n```\n\n")
	sb.WriteString("运行后会生成：\n\n")
	sb.WriteString("- `result.csv`：当前查询的复现结果。\n")
	sb.WriteString("- `output/features/verification_summary.tsv`：数据加工重算结果和系统加工列的差异汇总，全部为 0 表示一致。\n\n")
	if len(manifest.Metrics) > 0 {
		sb.WriteString("## 本次查询命中的加工项\n\n")
		for _, m := range manifest.Metrics {
			sb.WriteString("- `")
			sb.WriteString(m.Column)
			sb.WriteString("` ")
			sb.WriteString(m.Name)
			sb.WriteString("\n")
		}
		sb.WriteString("\n")
	}
	sb.WriteString("## 首次运行\n\n")
	sb.WriteString("`run.sh` 会检查连接参数。如果当前环境没有配置，会提示你输入数据库地址、端口、用户名、密码和数据库名。\n\n")
	sb.WriteString("也可以提前设置环境变量：\n\n")
	sb.WriteString("```bash\n")
	sb.WriteString("export MO_HOST=127.0.0.1\n")
	sb.WriteString("export MO_PORT=16002\n")
	sb.WriteString("export MO_USER='workspace:user'\n")
	sb.WriteString("export MO_PASSWORD='password'\n")
	sb.WriteString("export MO_DB='hk_sfc'\n")
	sb.WriteString("```\n\n")
	sb.WriteString("## 高级用法\n\n")
	sb.WriteString("- `python3 run.py --mode export`：只导出所有重算加工文件。\n")
	sb.WriteString("- `python3 run.py --mode verify`：只做加工一致性校验。\n")
	sb.WriteString("- `python3 run.py --mode apply --yes`：明确确认后覆盖库内预计算列。\n")
	return sb.String()
}

func featurePackageRunSH() string {
	return `#!/usr/bin/env bash
set -euo pipefail

prompt_default() {
  local name="$1"
  local default="$2"
  local value="${!name:-}"
  if [ -z "$value" ]; then
    if [ -n "$default" ]; then
      read -r -p "$name [$default]: " value
      value="${value:-$default}"
    else
      read -r -p "$name: " value
    fi
    export "$name=$value"
  fi
}

prompt_secret() {
  local name="$1"
  local value="${!name:-}"
  if [ -z "$value" ]; then
    read -r -s -p "$name: " value
    echo
    export "$name=$value"
  fi
}

echo "HK_POC 数据加工一键复现"
echo
prompt_default MO_HOST "127.0.0.1"
prompt_default MO_PORT "16002"
prompt_default MO_USER ""
prompt_secret MO_PASSWORD
prompt_default MO_DB "hk_sfc"

python3 run.py --mode run --output output/features --query-sql query.sql --result result.csv

echo
echo "已生成 result.csv"
echo "加工校验见 output/features/verification_summary.tsv"
`
}

func scriptFilename(name string, ext string) string {
	name = strings.NewReplacer(".", "_", "-", "_").Replace(strings.ToLower(strings.TrimSpace(name)))
	if name == "" {
		return "run.py"
	}
	return name + ext
}

func sqlScriptAsset(column string, body string) featureScriptAsset {
	return featureScriptAsset{
		Body:        strings.TrimSpace(body) + "\n",
		Filename:    scriptFilename(column, ".sql"),
		ContentType: "text/plain; charset=utf-8",
	}
}

func pythonScriptAsset(column string, body string) featureScriptAsset {
	return featureScriptAsset{
		Body:        strings.TrimSpace(body) + "\n",
		Filename:    scriptFilename(column, ".py"),
		ContentType: "text/x-python; charset=utf-8",
	}
}

func textScriptAsset(name string, body string) featureScriptAsset {
	return featureScriptAsset{
		Body:        strings.TrimSpace(body) + "\n",
		Filename:    scriptFilename(name, ".txt"),
		ContentType: "text/plain; charset=utf-8",
	}
}

func splitColumns(raw string) []string {
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}

func hasAnyColumn(columns []string, suffixes ...string) bool {
	for _, col := range columns {
		col = strings.ToLower(strings.TrimSpace(col))
		for _, suffix := range suffixes {
			if strings.HasSuffix(col, "."+strings.ToLower(suffix)) {
				return true
			}
		}
	}
	return false
}

func featureScriptForTable(table string, columns []string) featureScriptAsset {
	normalized := strings.ToLower(strings.TrimSpace(table))
	switch normalized {
	case "ms_v_stk_hsi_daily":
		return sqlScriptAsset(normalized, hsiDailyScript())
	case "ms_t_stk_hsi":
		return sqlScriptAsset(normalized, hsiTradeDateScript())
	case "ms_v_stock_capital":
		if hasAnyColumn(columns, "industry_name") {
			return textScriptAsset(normalized, capitalIndustryPreparationScript())
		}
		return sqlScriptAsset(normalized, capitalRefDateScript())
	case "sehknews":
		return sqlScriptAsset(normalized, newsTradeDateScript())
	case "ms_t_stk_sis":
		if hasAnyColumn(columns,
			"ma_3", "ma_20", "ma_50", "ma_100",
			"consecutive_above_ma3", "consecutive_above_ma3_start",
			"consecutive_above_ma20", "consecutive_above_ma20_start",
			"consecutive_above_ma50", "consecutive_above_ma50_start",
			"avg_vol_30d") {
			return textScriptAsset(normalized, sisFeaturePreparationScript(strings.Join(columns, ", ")))
		}
		return sqlScriptAsset(normalized, sisTradeDateScript())
	default:
		return featureScriptAsset{
			Body:        reproduceFeaturesScript,
			Filename:    "run.py",
			ContentType: "text/x-python; charset=utf-8",
		}
	}
}

func featureScriptForColumn(column string) featureScriptAsset {
	normalized := strings.ToLower(strings.TrimSpace(column))
	switch normalized {
	case "ms_t_stk_hsi.trade_date":
		return sqlScriptAsset(column, hsiTradeDateScript())
	case "ms_t_stk_sis.trade_date":
		return sqlScriptAsset(column, sisTradeDateScript())
	case "ms_v_stock_capital.ref_date":
		return sqlScriptAsset(column, capitalRefDateScript())
	case "sehknews.trade_date":
		return sqlScriptAsset(column, newsTradeDateScript())
	case "ms_v_stock_capital.industry_name":
		return textScriptAsset(column, capitalIndustryPreparationScript())
	case "ms_t_stk_sis.ma_3", "ms_t_stk_sis.ma_20", "ms_t_stk_sis.ma_50", "ms_t_stk_sis.ma_100",
		"ms_t_stk_sis.consecutive_above_ma3", "ms_t_stk_sis.consecutive_above_ma3_start",
		"ms_t_stk_sis.consecutive_above_ma20", "ms_t_stk_sis.consecutive_above_ma20_start",
		"ms_t_stk_sis.consecutive_above_ma50", "ms_t_stk_sis.consecutive_above_ma50_start",
		"ms_t_stk_sis.avg_vol_30d":
		return textScriptAsset(column, sisFeaturePreparationScript(column))
	case "ms_v_stk_hsi_daily.trade_date", "ms_v_stk_hsi_daily.hshsi", "ms_v_stk_hsi_daily.hsi_pct_change":
		return sqlScriptAsset("ms_v_stk_hsi_daily", hsiDailyScript())
	default:
		return featureScriptAsset{
			Body:        reproduceFeaturesScript,
			Filename:    "run.py",
			ContentType: "text/x-python; charset=utf-8",
		}
	}
}

func hsiTradeDateScript() string {
	return `-- ms_t_stk_hsi.trade_date
-- Input: ms_t_stk_hsi.HSTXDT, e.g. 02JAN2025:09:20:00
-- Output column: ms_t_stk_hsi.trade_date

UPDATE ms_t_stk_hsi
SET trade_date = CAST(CONCAT(
    SUBSTR(HSTXDT, 6, 4), '-',
    CASE SUBSTR(HSTXDT, 3, 3)
      WHEN 'JAN' THEN '01' WHEN 'FEB' THEN '02' WHEN 'MAR' THEN '03'
      WHEN 'APR' THEN '04' WHEN 'MAY' THEN '05' WHEN 'JUN' THEN '06'
      WHEN 'JUL' THEN '07' WHEN 'AUG' THEN '08' WHEN 'SEP' THEN '09'
      WHEN 'OCT' THEN '10' WHEN 'NOV' THEN '11' WHEN 'DEC' THEN '12'
    END, '-',
    SUBSTR(HSTXDT, 1, 2)
  ) AS DATE)
WHERE trade_date IS NULL;
`
}

func sisTradeDateScript() string {
	return `-- ms_t_stk_sis.trade_date
-- Input: ms_t_stk_sis.SITXDT, e.g. 02JAN2025:00:00:00
-- Output column: ms_t_stk_sis.trade_date

UPDATE ms_t_stk_sis
SET trade_date = CAST(CONCAT(
    SUBSTR(SITXDT, 6, 4), '-',
    CASE SUBSTR(SITXDT, 3, 3)
      WHEN 'JAN' THEN '01' WHEN 'FEB' THEN '02' WHEN 'MAR' THEN '03'
      WHEN 'APR' THEN '04' WHEN 'MAY' THEN '05' WHEN 'JUN' THEN '06'
      WHEN 'JUL' THEN '07' WHEN 'AUG' THEN '08' WHEN 'SEP' THEN '09'
      WHEN 'OCT' THEN '10' WHEN 'NOV' THEN '11' WHEN 'DEC' THEN '12'
    END, '-',
    SUBSTR(SITXDT, 1, 2)
  ) AS DATE)
WHERE trade_date IS NULL;
`
}

func capitalRefDateScript() string {
	return `-- ms_v_stock_capital.ref_date
-- Input: ms_v_stock_capital.SIRXDT, e.g. 28FEB25
-- Output column: ms_v_stock_capital.ref_date

UPDATE ms_v_stock_capital
SET ref_date = CAST(CONCAT(
    '20', SUBSTR(SIRXDT, 8, 2), '-',
    CASE SUBSTR(SIRXDT, 4, 3)
      WHEN 'JAN' THEN '01' WHEN 'FEB' THEN '02' WHEN 'MAR' THEN '03'
      WHEN 'APR' THEN '04' WHEN 'MAY' THEN '05' WHEN 'JUN' THEN '06'
      WHEN 'JUL' THEN '07' WHEN 'AUG' THEN '08' WHEN 'SEP' THEN '09'
      WHEN 'OCT' THEN '10' WHEN 'NOV' THEN '11' WHEN 'DEC' THEN '12'
    END, '-',
    SUBSTR(SIRXDT, 1, 2)
  ) AS DATE)
WHERE ref_date IS NULL;
`
}

func newsTradeDateScript() string {
	return `-- sehknews.trade_date
-- Inputs:
-- - sehknews.timestamp
-- - ms_t_stk_sis.SITXDT, used to rebuild the trading calendar
-- Output column: sehknews.trade_date

UPDATE sehknews n
JOIN (
    SELECT effective_date, trade_date
    FROM (
        SELECT nd.effective_date, td.trade_date,
               ROW_NUMBER() OVER (PARTITION BY nd.effective_date ORDER BY td.trade_date) AS rn
        FROM (
            SELECT DISTINCT
                CASE WHEN HOUR(` + "`timestamp`" + `) >= 16
                     THEN DATE_ADD(DATE(` + "`timestamp`" + `), INTERVAL 1 DAY)
                     ELSE DATE(` + "`timestamp`" + `)
                END AS effective_date
            FROM sehknews
        ) nd
        JOIN (
            SELECT DISTINCT CAST(CONCAT(SUBSTR(SITXDT, 6, 4), '-', CASE SUBSTR(SITXDT, 3, 3)
              WHEN 'JAN' THEN '01' WHEN 'FEB' THEN '02' WHEN 'MAR' THEN '03'
              WHEN 'APR' THEN '04' WHEN 'MAY' THEN '05' WHEN 'JUN' THEN '06'
              WHEN 'JUL' THEN '07' WHEN 'AUG' THEN '08' WHEN 'SEP' THEN '09'
              WHEN 'OCT' THEN '10' WHEN 'NOV' THEN '11' WHEN 'DEC' THEN '12'
            END, '-', SUBSTR(SITXDT, 1, 2)) AS DATE) AS trade_date
            FROM ms_t_stk_sis
            WHERE SITXDT IS NOT NULL
        ) td
          ON td.trade_date >= nd.effective_date
         AND td.trade_date <= DATE_ADD(nd.effective_date, INTERVAL 10 DAY)
    ) ranked
    WHERE rn = 1
) mapping
  ON mapping.effective_date = CASE WHEN HOUR(n.` + "`timestamp`" + `) >= 16
                                   THEN DATE_ADD(DATE(n.` + "`timestamp`" + `), INTERVAL 1 DAY)
                                   ELSE DATE(n.` + "`timestamp`" + `)
                              END
SET n.trade_date = mapping.trade_date
WHERE n.trade_date IS NULL;
`
}

func capitalIndustryPreparationScript() string {
	return strings.TrimSpace(capitalRefDateScript()) + "\n\n" + strings.TrimSpace(industryNameScript())
}

func industryNameScript() string {
	return `# ms_v_stock_capital.industry_name
# Inputs:
# - ds_t_int_hsicl_dtl.STOCK_CODE, MODIFIED_DATE, INDUSTRY_NAME
# - ms_v_stock_capital.STKCD, SIRXDT
# Output: strict as-of industry_name for each stock/month-end.

from bisect import bisect_right

def compute_industry_name(classification_rows, capital_rows):
    cls = {}
    for row in classification_rows:
        code = row["STOCK_CODE"]
        modified_date = row["MODIFIED_DATE"]
        industry_name = row["INDUSTRY_NAME"]
        cls.setdefault(code, []).append((modified_date, industry_name))

    for rows in cls.values():
        rows.sort()

    for row in capital_rows:
        stkcd = row["STKCD"]
        ref_date = row["ref_date"]  # rebuild from SIRXDT before calling this helper
        records = cls.get(stkcd, [])
        dates = [r[0] for r in records]
        idx = bisect_right(dates, ref_date) - 1
        if idx >= 0:
            yield {
                "STKCD": stkcd,
                "ref_date": ref_date,
                "industry_name": records[idx][1],
            }
`
}

func sisFeaturePreparationScript(column string) string {
	return strings.TrimSpace(sisTradeDateScript()) + "\n\n" + strings.TrimSpace(sisPrecomputeScript(column))
}

func sisPrecomputeScript(column string) string {
	return "# " + column + `
# Inputs: ms_t_stk_sis.SISTKC, SITXDT, SICLSE, SIVOL
# Outputs: ma_3, ma_20, ma_50, ma_100, consecutive_above_ma*, *_start, avg_vol_30d.

from collections import deque

class RollingAvg:
    def __init__(self, window):
        self.window = window
        self.buf = deque()
        self.sum = 0.0
        self.count = 0

    def add(self, value):
        if len(self.buf) >= self.window:
            old = self.buf.popleft()
            if old is not None:
                self.sum -= old
                self.count -= 1
        self.buf.append(value)
        if value is not None:
            self.sum += value
            self.count += 1

    def avg(self):
        if len(self.buf) >= self.window and self.count:
            return self.sum / self.count
        return None

    def reset(self):
        self.buf.clear()
        self.sum = 0.0
        self.count = 0

def compute_sis_features(rows):
    r3, r20, r50, r100 = RollingAvg(3), RollingAvg(20), RollingAvg(50), RollingAvg(100)
    streak3 = streak20 = streak50 = 0
    start3 = start20 = start50 = None
    vol_buf = deque()
    vol_sum = 0.0
    vol_count = 0
    prev = None

    for row in rows:  # sorted by SISTKC, rebuilt trade_date
        code = row["SISTKC"]
        trade_date = row["trade_date"]
        close = row["SICLSE"]
        vol = row["SIVOL"]

        if code != prev:
            r3.reset(); r20.reset(); r50.reset(); r100.reset()
            streak3 = streak20 = streak50 = 0
            start3 = start20 = start50 = None
            vol_buf = deque()
            vol_sum = 0.0
            vol_count = 0
            prev = code

        r3.add(close); r20.add(close); r50.add(close); r100.add(close)
        ma3 = round(r3.avg(), 4) if r3.avg() is not None else None
        ma20 = round(r20.avg(), 4) if r20.avg() is not None else None
        ma50 = round(r50.avg(), 4) if r50.avg() is not None else None
        ma100 = round(r100.avg(), 4) if r100.avg() is not None else None

        if ma3 is not None and close is not None and close > ma3:
            if streak3 == 0:
                start3 = trade_date
            streak3 += 1
        else:
            streak3 = 0
            start3 = None

        if ma20 is not None and close is not None and close > ma20:
            if streak20 == 0:
                start20 = trade_date
            streak20 += 1
        else:
            streak20 = 0
            start20 = None

        if ma50 is not None and close is not None and close > ma50:
            if streak50 == 0:
                start50 = trade_date
            streak50 += 1
        else:
            streak50 = 0
            start50 = None

        # Avg_Vol_30_Pre: shift(1).rolling(window=30, min_periods=20).mean()
        avg_vol_30d = vol_sum / vol_count if vol_count >= 20 else None
        vol_buf.append(vol)
        if vol is not None:
            vol_sum += vol
            vol_count += 1
        if len(vol_buf) > 30:
            old = vol_buf.popleft()
            if old is not None:
                vol_sum -= old
                vol_count -= 1

        yield {
            "SISTKC": code,
            "trade_date": trade_date,
            "ma_3": ma3,
            "ma_20": ma20,
            "ma_50": ma50,
            "ma_100": ma100,
            "consecutive_above_ma3": streak3,
            "consecutive_above_ma3_start": start3,
            "consecutive_above_ma20": streak20,
            "consecutive_above_ma20_start": start20,
            "consecutive_above_ma50": streak50,
            "consecutive_above_ma50_start": start50,
            "avg_vol_30d": avg_vol_30d,
        }
`
}

func hsiDailyScript() string {
	return `-- ms_v_stk_hsi_daily
-- Inputs: ms_t_stk_hsi.HSTXDT, CLOSING, HSHSI, HSFIN, HSUTL, HSPROP, HSCANI
-- Output table: ms_v_stk_hsi_daily

CREATE TABLE IF NOT EXISTS ms_v_stk_hsi_daily (
  trade_date DATE,
  HSHSI DOUBLE,
  HSFIN DOUBLE,
  HSUTL DOUBLE,
  HSPROP DOUBLE,
  HSCANI DOUBLE,
  hsi_pct_change DOUBLE
);

DELETE FROM ms_v_stk_hsi_daily;

INSERT INTO ms_v_stk_hsi_daily (
  trade_date,
  HSHSI,
  HSFIN,
  HSUTL,
  HSPROP,
  HSCANI,
  hsi_pct_change
)
SELECT trade_date,
       HSHSI,
       HSFIN,
       HSUTL,
       HSPROP,
       HSCANI,
       COALESCE(
         (HSHSI - LAG(HSHSI) OVER (ORDER BY trade_date))
         / LAG(HSHSI) OVER (ORDER BY trade_date) * 100,
         0
       ) AS hsi_pct_change
FROM (
  SELECT CAST(CONCAT(SUBSTR(HSTXDT, 6, 4), '-', CASE SUBSTR(HSTXDT, 3, 3)
    WHEN 'JAN' THEN '01' WHEN 'FEB' THEN '02' WHEN 'MAR' THEN '03'
    WHEN 'APR' THEN '04' WHEN 'MAY' THEN '05' WHEN 'JUN' THEN '06'
    WHEN 'JUL' THEN '07' WHEN 'AUG' THEN '08' WHEN 'SEP' THEN '09'
    WHEN 'OCT' THEN '10' WHEN 'NOV' THEN '11' WHEN 'DEC' THEN '12'
  END, '-', SUBSTR(HSTXDT, 1, 2)) AS DATE) AS trade_date,
         HSHSI, HSFIN, HSUTL, HSPROP, HSCANI
  FROM ms_t_stk_hsi
  WHERE CLOSING = 9
) h
ORDER BY trade_date;
`
}
