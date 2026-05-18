#!/usr/bin/env bash
# HK SFC POC - 语义知识库配置脚本（v2: 精简版，只保留引擎无法从 schema 推断的业务知识）
# 用法: bash scripts/07_configure_knowledge.sh
#
# 前置条件: Catalog 已启动, .env 中有 MOI_SYSTEM_API_KEY 和 POC_WORKSPACE_ID
# 幂等: 先删除旧条目再重建

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

source "$PROJECT_DIR/.env"
CATALOG="http://localhost:8084"
WS="$POC_WORKSPACE_ID"
KEY="$MOI_SYSTEM_API_KEY"
KB_ID=10001

# DB 连接（自动获取 workspace 账号）
MO_HOST="${MO_HOST:-127.0.0.1}"
MO_PORT="${MO_PORT:-16002}"
if [ -n "${MO_USER:-}" ] && [ -n "${MO_PASS:-}" ]; then
  :
else
  ACCT=$(curl -s "$CATALOG/api/v1/workspaces/$WS" \
    -H "X-API-Key: $KEY" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['account_name'])" 2>/dev/null)
  MO_USER="${ACCT}:moi_core_system"
  MO_PASS="$KEY"
fi
MYSQL_CMD="mysql -h $MO_HOST -P $MO_PORT -u $MO_USER -p$MO_PASS hk_sfc -N -B"

log() { echo "[$(date '+%H:%M:%S')] $*"; }

add() {
  local type="$1" key="$2" name="$3" value="$4" tables="$5"
  local resp http
  resp=$(curl -s -w "\n%{http_code}" -X POST "$CATALOG/api/v1/workspaces/$WS/nl2sql-knowledge" \
    -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
    -d "{
      \"knowledge_base_id\": $KB_ID,
      \"knowledge_type\": \"$type\",
      \"knowledge_key\": \"$key\",
      \"name\": \"$name\",
      \"knowledge_value\": [$value],
      \"associate_tables\": [$tables]
    }")
  http=$(echo "$resp" | tail -n1)
  if [ "$http" != "200" ] && [ "$http" != "201" ]; then
    echo "  ✗ [$type] $key  (HTTP $http)"
    echo "    body: $(echo "$resp" | head -n-1 | head -c 300)"
    return 1
  fi
  echo "  + [$type] $key"
}

# ============================================================
# Step 1: 清理旧条目
# ============================================================
log "清理旧条目..."
existing=$(curl -s -X POST "$CATALOG/api/v1/workspaces/$WS/nl2sql-knowledge/list" \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"page_size":100}' | python3 -c "
import sys,json
items=json.load(sys.stdin).get('data',{}).get('items',[])
for i in items: print(i['id'])
" 2>/dev/null)

count=0
for id in $existing; do
  curl -s -X DELETE "$CATALOG/api/v1/workspaces/$WS/nl2sql-knowledge/$id" \
    -H "X-API-Key: $KEY" > /dev/null
  count=$((count+1))
done
log "已删除 $count 条旧条目"

# ============================================================
# Step 2: 数据范围（从数据库实时查询）
# ============================================================
log ""
log "配置数据范围..."

get_range() {
  local result
  result=$($MYSQL_CMD -e "SELECT CASE WHEN MIN($2) IS NOT NULL THEN CONCAT(MIN($2), ' to ', MAX($2)) ELSE '' END FROM $1 WHERE $2 IS NOT NULL;" 2>/dev/null || true)
  echo "$result"
}

add_coverage() {
  local key="$1" table="$2" col="$3" desc="${4:-}"
  [ -z "$desc" ] && desc="$table has $col"
  local R
  R=$(get_range "$table" "$col")
  if [ -n "$R" ]; then
    add "logic" "$key" "$table date range" "\"$desc from $R.\"" "\"$table\""
  else
    log "  ⚠ $table.$col 无数据，跳过"
  fi
}

add_coverage "data_coverage_hsi"      "ms_t_stk_hsi"       "trade_date"
add_coverage "data_coverage_sis"      "ms_t_stk_sis"       "trade_date"
add_coverage "data_coverage_capital"  "ms_v_stock_capital"  "ref_date"    "ms_v_stock_capital has ref_date monthly"
add_coverage "data_coverage_industry" "ds_t_int_hsicl_dtl"  "MODIFIED_DATE"
add_coverage "data_coverage_news"     "sehknews"            "trade_date"
add_coverage "data_coverage_profit"   "profit_loss"         "fin_yr"
add_coverage "data_coverage_ccass"    "ccass_holdings"      "holding_date"

# ============================================================
# Step 3: 业务约束（logic — 描述"是什么"和"为什么"，不给 SQL）
# ============================================================
log ""
log "配置业务约束..."

# --- 行业分类 ---
add "logic" "industry_carry_forward" "Industry classification is pre-computed on ms_v_stock_capital" \
  '"ms_v_stock_capital.industry_name is pre-computed from ds_t_int_hsicl_dtl using strict as-of carry-forward: for each stock and month-end, it uses the latest classification with MODIFIED_DATE <= ref_date. If no prior classification exists, industry_name is NULL; do NOT use future classifications to fill earlier months. For industry-level market cap analysis, use ms_v_stock_capital.industry_name directly and add industry_name IS NOT NULL — do NOT join ds_t_int_hsicl_dtl yourself."' \
  '"ms_v_stock_capital","ds_t_int_hsicl_dtl"'

add "logic" "industry_market_cap_metric_semantics" "Industry market cap means aggregate industry total unless average is explicit" \
  '"For industry-level market cap analysis on ms_v_stock_capital, \"industry market cap / 行业市值 / total market cap by industry / aggregate market cap\" means the total market capitalization of all stocks in the industry: SUM(SICAP) grouped by industry_name. Use AVG(SICAP) only when the user explicitly asks for average market cap / 平均市值 / average stock market cap within each industry. Growth rate or change rate between two periods means endpoint comparison: (end_metric - start_metric) / start_metric using the two relevant month-end snapshots; do NOT compute a month-by-month LAG average unless the user explicitly asks for monthly average change."' \
  '"ms_v_stock_capital"'

# --- 新闻公告 ---
add "logic" "material_news_typeid" "Material news typeid definition" \
  '"Material news (重大新闻/重大公告) in sehknews is defined as typeid IN (0, 3, 7, 8, 10, 14, 18, 21, 25, 26, 28, 32)."' \
  '"sehknews"'

add "logic" "news_trade_date" "sehknews.trade_date is pre-computed event trading day" \
  '"sehknews.trade_date is pre-computed for trading-data joins: news before 16:00 HKT maps to that date'\''s trading day when available; after-hours news (HOUR(timestamp) >= 16) maps to the next trading day; weekends/holidays also map to the next trading day. Always use this column (not DATE(timestamp)) to JOIN with ms_t_stk_sis.trade_date."' \
  '"sehknews","ms_t_stk_sis"'

add "logic" "news_dedup" "Deduplicate news per stock per day before joining trading data" \
  '"A stock may have multiple news articles on the same day. When joining sehknews with trading data for analysis, always deduplicate by (securitycode, trade_date) first to avoid result inflation."' \
  '"sehknews","ms_t_stk_sis"'

add "logic" "news_volume_event_granularity" "Volume anomaly detection must return event-level rows, not DISTINCT stocks" \
  '"When detecting volume anomalies related to news (e.g. volume > N times average on news days), output one row per (trade_date, stock) event. Do NOT use SELECT DISTINCT on stock_code alone. The same stock may trigger on multiple dates — each occurrence is a separate detection event that must be reported with its trade_date."' \
  '"sehknews"'

add "logic" "avg_vol_30d_definition" "avg_vol_30d matches customer Avg_Vol_30_Pre" \
  '"ms_t_stk_sis.avg_vol_30d is pre-computed to match Avg_Vol_30_Pre: for each stock, average Daily_Volume over the previous up-to-30 trading rows, excluding the current row (shift(1)); return NULL unless there are at least 20 valid prior volume observations (rolling window=30, min_periods=20). Use avg_vol_30d directly for volume anomaly detection; do NOT recompute it with correlated subqueries or assume fewer than 20 prior observations are valid."' \
  '"ms_t_stk_sis"'

# --- CCASS ---
add "logic" "ccass_holding_change_dates" "CCASS holding changes compare available disclosure snapshots" \
  '"ccass_holdings is snapshot data by available CCASS disclosure dates. holding_date values are discrete dates loaded in the table, not a continuous calendar. When analyzing broker holding changes or movements, compare snapshots at (stock_code, participant_id) granularity; do NOT aggregate participants into stock-level totals. If the user explicitly provides two dates, use those exact two dates as current and previous snapshots. If the user provides only one target date and asks for change/movement, resolve current_date as SELECT MAX(holding_date) FROM ccass_holdings WHERE holding_date <= target_date, and resolve previous_date as SELECT MAX(holding_date) FROM ccass_holdings WHERE holding_date < current_date. Do NOT use DATE_SUB(target_date, INTERVAL 1 DAY), and do NOT assume weekends, holidays, or non-loaded dates exist in ccass_holdings."' \
  '"ccass_holdings"'

# --- 利润表 ---
add "logic" "profit_loss_stock_code" "profit_loss stock_code format and company name search" \
  '"In profit_loss, stock_code is NOT zero-padded (e.g. 88 not 00088). When the user references a company by name, use LIKE on the column matching the input language — using the wrong column returns 0 rows: company_name_sc for simplified Chinese, company_name_tc for traditional Chinese, company_name_en for English. Identify traditional vs simplified Chinese by character form (e.g. 體/体, 國/国, 東/东). Do NOT extract numbers from the name as stock_code (e.g. \"360鲁大师\" → stock_code is 3601, not 360)."' \
  '"profit_loss"'

add "logic" "profit_loss_period_comparison" "Revenue/profit analysis must use like-for-like period comparison" \
  '"profit_loss.fin_yr is YYYYMM format (e.g. 202312 = Dec 2023). quarter is Final (full-year annual report / 年报) or Interim (half-year report / 半年报 / 中期). PERIOD SELECTION (default Final): when the user mentions \"year\" / \"annual\" / \"yearly\" / \"FY\" / \"full year\" / \"年度\" / \"全年\" / \"每年\" or uses year-range patterns like \"2022 to 2024\" without specifying 半年/interim, filter quarter = '\''Final'\'' on BOTH sides of the self-JOIN. Only when the user explicitly mentions \"interim\" / \"H1\" / \"H2\" / \"半年\" / \"中期\", filter quarter = '\''Interim'\''. Only when the user explicitly asks to compare or show BOTH periods (e.g. \"show both annual and interim\" / \"对比年报和中期\"), include both. NEVER silently return mixed Interim + Final in the same result — their comparison bases differ (H1 vs prior-year H1, FY vs prior-year FY) and cannot be charted or averaged on the same axis. CRITICAL SQL STRUCTURE: use self-JOIN (NOT LAG/LEAD) to compare same quarter across years, joining on stock_code + quarter + year offset (CAST(SUBSTRING(a.fin_yr,1,4) AS UNSIGNED) = CAST(SUBSTRING(b.fin_yr,1,4) AS UNSIGNED) + 1 AND SUBSTRING(a.fin_yr,5,2) = SUBSTRING(b.fin_yr,5,2)). LAG/LEAD over fin_yr will incorrectly compare Final with Interim — this is WRONG. \"growth from X to Y\" / \"X到Y年增长\" means YEAR-OVER-YEAR comparison for EVERY year in the range, NOT just start vs end. Include (Y-X+1) baseline year data. Example: \"growth from 2023 to 2025\" → use a.fin_yr >= '\''202301'\'' (not 202306) to include all 2023 periods, and include 2022 baseline data via the self-JOIN. The YYYYMM filter is a string comparison, so >= '\''202301'\'' correctly matches 202303, 202306, etc."' \
  '"profit_loss"'

# --- 日线汇总 ---
add "logic" "hsi_daily_usage" "Use ms_v_stk_hsi_daily for daily HSI analysis" \
  '"ms_v_stk_hsi_daily is a daily summary table (one row per trading day, ~286 rows) with pre-computed hsi_pct_change. Use this instead of ms_t_stk_hsi (tick data, ~11000 rows/day) for daily-level HSI analysis."' \
  '"ms_v_stk_hsi_daily"'

# --- 可视化规则已删除 ---
# chart_friendly_output 被移除。原因：（1）它强加 time-series 列形态，扭曲了 list 类查询的 SQL 结构；
# （2）它带的 "Limit to top 5" 和 list_vs_rank_semantics 冲突；
# （3）前端 DataTable 已有分页、Chart 能自适应任意 result shape，SQL 层无需截断。

# --- 日期边界约束（通用） ---
add "logic" "date_boundary_constraint" "All SQL date literals must fall within actual data coverage" \
  '"Every date literal in SQL MUST fall within the table'\''s actual data range (see data_coverage_* entries). Dates outside the range return ZERO rows and produce WRONG answers. For daily tables (ms_t_stk_sis, ms_t_stk_hsi, ms_v_stk_hsi_daily, sehknews), use normal calendar dates like {year}-01-01 for year start. Do NOT use month-end dates (01-31, 07-31) for daily tables."' \
  '"ms_t_stk_hsi","ms_t_stk_sis","ds_t_int_hsicl_dtl","sehknews","profit_loss","ccass_holdings","ms_v_stk_hsi_daily"'

# --- 日期边界约束（ms_v_stock_capital 专用） ---
add "logic" "date_boundary_capital_monthly" "ms_v_stock_capital ref_date is month-end only" \
  '"ms_v_stock_capital.ref_date contains ONLY month-end dates (01-31, 02-28, ..., 12-31). You MUST use month-end dates when querying this table. Period mapping: H1 {year} → start={year}-01-31 end={year}-06-30. H2 {year} → start={year}-07-31 end={year}-12-31. Full year {year} → start={year}-01-31 end={year}-12-31. WRONG examples: {year}-01-01, {year}-06-01, {year}-07-01 (these are NOT month-end and will match ZERO rows). The start date is ALWAYS the first month-end WITHIN the period, NEVER the last day of the previous period (e.g. 2024-12-31 does not exist in this table)."' \
  '"ms_v_stock_capital"'

# --- List vs Rank：是否加 LIMIT ---
add "logic" "list_vs_rank_semantics" "User phrasing determines whether to add LIMIT" \
  '"The decision to add LIMIT is driven by user intent, NOT by table size or default convention. (1) LIST intent — phrases like '\''list / 列出 / 列举 / 有哪些 / 哪些... / show me / 所有 / all'\''  — the user wants to see ALL matching rows. SQL MUST NOT add LIMIT. Returning a silent top-K slice misleads the user into believing they saw the full result. (2) RANK intent — phrases like '\''top N / 前N / 前N大 / 最...的N个 / 排名前N / 最高的N / 最低的N'\'' — add LIMIT N where N is the exact number requested. (3) AMBIGUOUS — no quantifier, no list/rank verb — default to NO LIMIT. Let the user see the full result; they can ask to rank later. (4) A fewshot SQL that does NOT include LIMIT is NOT an oversight — do NOT add LIMIT to follow a '\''top N'\'' pattern you infer from the fewshot description. Follow the user'\''s explicit phrasing only."' \
  '"ms_t_stk_hsi","ms_v_stk_hsi_daily","ms_t_stk_sis","ms_v_stock_capital","profit_loss","ccass_holdings","ds_t_int_hsicl_dtl","sehknews"'

# --- 方向性语义约束 ---
add "logic" "directional_filter_constraint" "Decline/increase queries must include sign filter" \
  '"When the user asks about decline/decrease/drop (下降/下跌/减少/缩水/亏损), the SQL MUST include a < 0 filter on the computed change column. When the user asks about increase/growth/rise (上升/上涨/增长/增加), the SQL MUST include a > 0 filter. Without this filter, the result set will contain rows whose change sign does not match the user'\''s directional intent. This rule governs WHICH rows qualify; it does NOT prescribe whether to LIMIT or rank — that decision belongs to list_vs_rank_semantics. EXCEPTION: when the question asks about \"情况/趋势/走势/变化\" (e.g. \"增长情况\", \"营收变化趋势\"), this is descriptive — the user wants to see ALL data including both increases and decreases. Do NOT add a sign filter in this case."' \
  '"ms_t_stk_sis","ms_v_stock_capital","profit_loss","ms_v_stk_hsi_daily","ccass_holdings"'

# --- 过滤子集上的聚合：必须带 filter dimension + GROUP BY ---
add "logic" "aggregate_with_filter_dimensions" "Aggregate queries over filtered subsets must include filter dimensions in output" \
  '"When the user asks for an aggregate metric (SUM/COUNT/AVG/MAX/MIN) over a FILTERED SUBSET of rows — where the WHERE clause contains a dimensional condition BEYOND just a time-range boundary (e.g. hsi_pct_change < -2, industry_name = X, SISTKC < '\''00100'\'', typeid IN (...)) — the SQL MUST: (1) SELECT the filter-dimension columns alongside the aggregate; (2) GROUP BY those filter-dimension columns; (3) return one row per qualifying dimension value, NOT a single rolled-up scalar. Rationale: a user who filters by a condition wants to see WHICH rows satisfied that condition, not only the total — a scalar hides the evidence and breaks trust. Pure time-range queries (only trade_date BETWEEN x AND y with NO other dimensional filter) may return a scalar if no meaningful grouping dimension exists. Entity-scoped queries (WHERE stock_code = '\''00001'\'') may return a scalar for that single entity. Examples: (a) '\''Total volume on days when HSI dropped >2%'\'' → SELECT trade_date, hsi_pct_change, SUM(SIVOL) FROM ... WHERE hsi_pct_change < -2 GROUP BY trade_date, hsi_pct_change (NOT SELECT SUM(SIVOL) as scalar). (b) '\''Count of news on volume-spike days'\'' → GROUP BY the qualifying trade_date. (c) '\''Total revenue of tech companies in 2025'\'' → GROUP BY stock_code. (d) '\''Closing price of 00001 on 2025-03-15'\'' → scalar is OK (no subset, just a point query). (e) '\''Total volume in 2025'\'' → scalar is OK (pure time-range boundary, no dimensional filter)."' \
  '"ms_t_stk_hsi","ms_v_stk_hsi_daily","ms_t_stk_sis","ms_v_stock_capital","profit_loss","ccass_holdings","ds_t_int_hsicl_dtl","sehknews"'

# --- 连续天数去重 ---
add "logic" "consecutive_ma_dedup" "Deduplicate consecutive_above_ma queries to one row per stock" \
  '"When querying consecutive_above_ma3/ma20/ma50 columns, ALWAYS use ROW_NUMBER() OVER (PARTITION BY SISTKC ORDER BY consecutive_above_maX DESC, trade_date DESC) to deduplicate. Return only one row per stock (the peak streak). Without ROW_NUMBER, consecutive streak queries return one row per stock per day, causing massive result inflation."' \
  '"ms_t_stk_sis"'

# --- 连续均线滚动窗口口径 ---
add "logic" "consecutive_ma_recent_window_start" "Recent rolling-window MA streaks must start inside the window" \
  '"For consecutive moving-average streak queries on ms_t_stk_sis (consecutive_above_ma3/ma20/ma50), when the user uses a recent/rolling time phrase such as 最近N天/最近N个月/近N日/过去N个月, the requested streak should be treated as a streak that starts within that recent window. Add consecutive_above_maX_start >= {{DATE_START}} in addition to trade_date between {{DATE_START}} and {{DATE_END}} and consecutive_above_maX >= threshold. This avoids returning streaks that began before the recent window but merely remained active inside it. For explicit broad fixed ranges such as 2025年3月至2026年3月, keep the standard peak-streak-in-range template unless the user explicitly says 起止都在/完整位于/形成于/发生在该区间内."' \
  '"ms_t_stk_sis"'

# --- 时间序列排序 ---
add "logic" "time_series_order_by" "Time series SQL must ORDER BY the temporal column ASC" \
  '"When the SELECT list contains a date/time column (trade_date, fin_yr, holding_date, ref_date, announcement_date, timestamp, ym, month, year, etc.) AND the query returns multiple rows across time, the SQL MUST include ORDER BY <temporal_column> ASC as the final clause. This is NOT optional. A time series without ORDER BY returns rows in arbitrary/engine-dependent order, producing wrong visual trends in charts and confusing left-to-right reading in data tables. This is a correctness requirement, not an optimization. For comparison queries (self-JOIN, YoY, MoM), order by the CURRENT period'\''s temporal column (e.g. ORDER BY a.fin_yr ASC when a is the current row and b is the prior-period row). Note: this rule governs temporal sort. Whether to rank by a non-temporal metric and LIMIT is decided by list_vs_rank_semantics — if that rule says LIMIT N with ORDER BY metric DESC, that sort takes precedence and this rule does not apply."' \
  '"ms_t_stk_sis","ms_v_stk_hsi_daily","profit_loss","ccass_holdings","sehknews","ds_t_int_hsicl_dtl","ms_v_stock_capital","ms_t_stk_hsi"'

# --- SQL 方言 ---
add "logic" "sql_dialect_matrixone" "MatrixOne SQL dialect constraints" \
  '"MatrixOne limitations: (1) RIGHT() not supported — use SUBSTRING(col, LENGTH(col)-N+1, N). (2) CHANGE, RANK are reserved words — use aliases like turnover_change, rnk. (3) LAG/LEAD on simple columns works fine (e.g. LAG(SICLSE) OVER ...) — only LAG/LEAD wrapping CASE WHEN expressions will panic, pre-compute flag columns first in that case. (4) Correlated subqueries in SELECT may return NULL unexpectedly — prefer LAG/LEAD or self-JOIN instead. (5) REGEXP works but CAST(VARCHAR AS UNSIGNED) may panic when combined with window functions — filter string conditions in an inner subquery."' \
  '"ms_t_stk_sis","profit_loss","ms_v_stock_capital","sehknews","ds_t_int_hsicl_dtl"'

# ============================================================
# Step 3b: 术语表（glossary）
# ============================================================
log ""
log "配置术语表..."

add "glossary" "hk_stock_terminology" "HK stock market terminology" \
  '"恒生指数/恒指/HSI daily data → table ms_v_stk_hsi_daily (NOT ms_t_stk_hsi which is tick data)","成交量/交易量/总成交量/volume → SUM(SIVOL) from ms_t_stk_sis (ms_v_stk_hsi_daily has NO volume column)","收盘价/closing price → SICLSE column in ms_t_stk_sis","行业分类/industry classification → table ds_t_int_hsicl_dtl","市值/market cap → table ms_v_stock_capital","新闻/公告/news/announcement → table sehknews","利润/营收/profit/revenue → table profit_loss","CCASS持仓/券商持仓/CCASS holdings → table ccass_holdings"' \
  '"ms_v_stk_hsi_daily","ms_t_stk_sis","ms_v_stock_capital","ds_t_int_hsicl_dtl","sehknews","profit_loss","ccass_holdings"'

# ============================================================
# Step 3c: 展示规则（presentation — 控制 synthesis 输出格式）
# ============================================================
log ""
log "配置展示规则..."

add "presentation" "profit_loss_show_all_periods" \
  "Show all fiscal year periods in profit_loss results" \
  '"When presenting profit_loss query results, you MUST describe EVERY row returned by the SQL. This includes both Final (full-year annual report / 年报) and Interim (half-year report / 半年报 / 中期报告) periods. Do not skip or summarize away any fiscal year period. Present them in chronological order by fin_yr."' \
  '"profit_loss"'

add "presentation" "profit_loss_currency" \
  "Reporting currency varies by company in profit_loss" \
  '"Companies in profit_loss report in different currencies (e.g. Tencent uses RMB, HSBC uses USD, CK Hutchison uses HKD). When presenting financial amounts, if the query result includes a currency column, always use the actual currency from the data. If the result does not include currency, do not assume any specific currency — state the amounts without a currency prefix rather than guessing."' \
  '"profit_loss"'

# ============================================================
# Step 3d: Fewshot 示例（case_library — 可复用的 SQL 模式）
# ============================================================
log ""
log "配置 fewshot 示例..."

add "case_library" \
  "哪些行业在某个时间段内的总市值增长率最高/下降幅度最大？行业市值=行业内股票SICAP总和；增长率=期末行业总市值vs期初总市值，取两个端点月末日期" \
  "Industry market cap period comparison on ms_v_stock_capital" \
  '"SELECT industry_name, market_cap_start, market_cap_end, market_cap_change, ROUND(market_cap_change / market_cap_start * 100, 2) AS change_pct FROM (SELECT industry_name, SUM(CASE WHEN ref_date = '\''{{period_start}}'\'' THEN SICAP ELSE 0 END) AS market_cap_start, SUM(CASE WHEN ref_date = '\''{{period_end}}'\'' THEN SICAP ELSE 0 END) AS market_cap_end, SUM(CASE WHEN ref_date = '\''{{period_end}}'\'' THEN SICAP ELSE 0 END) - SUM(CASE WHEN ref_date = '\''{{period_start}}'\'' THEN SICAP ELSE 0 END) AS market_cap_change FROM ms_v_stock_capital WHERE ref_date IN ('\''{{period_start}}'\'', '\''{{period_end}}'\'') AND industry_name IS NOT NULL GROUP BY industry_name HAVING market_cap_start > 0 AND market_cap_end > 0) t ORDER BY change_pct DESC"' \
  '"ms_v_stock_capital"'

add "case_library" \
  "哪些行业在某个时间段内的平均市值增长率最高/下降幅度最大？仅当用户明确说平均市值时使用；平均市值=行业内股票SICAP平均值；增长率=期末行业平均市值vs期初行业平均市值，取两个端点月末日期" \
  "Industry average market cap period comparison on ms_v_stock_capital" \
  '"SELECT industry_name, avg_market_cap_start, avg_market_cap_end, avg_market_cap_change, ROUND(avg_market_cap_change / avg_market_cap_start * 100, 2) AS change_pct FROM (SELECT industry_name, AVG(CASE WHEN ref_date = '\''{{period_start}}'\'' THEN SICAP END) AS avg_market_cap_start, AVG(CASE WHEN ref_date = '\''{{period_end}}'\'' THEN SICAP END) AS avg_market_cap_end, AVG(CASE WHEN ref_date = '\''{{period_end}}'\'' THEN SICAP END) - AVG(CASE WHEN ref_date = '\''{{period_start}}'\'' THEN SICAP END) AS avg_market_cap_change FROM ms_v_stock_capital WHERE ref_date IN ('\''{{period_start}}'\'', '\''{{period_end}}'\'') AND industry_name IS NOT NULL GROUP BY industry_name HAVING avg_market_cap_start IS NOT NULL AND avg_market_cap_end IS NOT NULL) t ORDER BY change_pct DESC"' \
  '"ms_v_stock_capital"'

add "case_library" \
  "CCASS holding change when user provides one target date only. Resolve current snapshot as latest available holding_date <= target date, and previous snapshot as latest available holding_date before current snapshot. Replace {{target_date}} and {{threshold}} from the question." \
  "CCASS broker-level holding change for one target date using previous available snapshot" \
  '"WITH current_snapshot AS (SELECT MAX(holding_date) AS holding_date FROM ccass_holdings WHERE holding_date <= '\''{{target_date}}'\''), previous_snapshot AS (SELECT MAX(h.holding_date) AS holding_date FROM ccass_holdings h JOIN current_snapshot c ON h.holding_date < c.holding_date) SELECT a.stock_code, a.stock_name, a.participant_id, a.shareholding AS shares_day2, b.shareholding AS shares_day1, (a.shareholding - b.shareholding) / b.shareholding AS change_ratio FROM current_snapshot c JOIN previous_snapshot p ON p.holding_date IS NOT NULL JOIN ccass_holdings a ON a.holding_date = c.holding_date JOIN ccass_holdings b ON b.holding_date = p.holding_date AND a.stock_code = b.stock_code AND a.participant_id = b.participant_id WHERE b.shareholding > 0 AND ABS(a.shareholding - b.shareholding) / b.shareholding > {{threshold}}"' \
  '"ccass_holdings"'

add "case_library" \
  "CCASS holding change when user explicitly provides two comparison dates using words like 相比/compare to/between. Replace {{current_date}}, {{previous_date}}, and {{threshold}} from the question. Use this template only when two concrete dates are present in the user question." \
  "CCASS broker-level holding change between explicitly specified dates" \
  '"SELECT a.stock_code, a.stock_name, a.participant_id, a.shareholding AS shares_day2, b.shareholding AS shares_day1, (a.shareholding - b.shareholding) / b.shareholding AS change_ratio FROM ccass_holdings a JOIN ccass_holdings b ON a.stock_code = b.stock_code AND a.participant_id = b.participant_id WHERE a.holding_date = '\''{{current_date}}'\'' AND b.holding_date = '\''{{previous_date}}'\'' AND b.shareholding > 0 AND ABS(a.shareholding - b.shareholding) / b.shareholding > {{threshold}}"' \
  '"ccass_holdings"'

add "case_library" \
  "Annual YoY revenue/profit comparison (DEFAULT template — annual reports only). Replace {{company_name_column}} with company_name_sc / company_name_tc / company_name_en based on input language. Replace {{company}} with the company keyword from the question. Always use LIKE for fuzzy matching — never guess the full company name. Example: '360 LUDASHI HOLDINGS LIMITED' → company_name_en LIKE '%LUDASHI%'. Replace {{start_fin_yr}} with the first year's December in fin_yr format (e.g. 2022 → '202212') and {{end_fin_yr}} with the last year's December (e.g. 2024 → '202412'); both bounds are REQUIRED whenever the user specifies a year range, to avoid returning years the user did not ask about. IMPORTANT: this template filters quarter = 'Final' on both sides, which is the default for year/annual/yearly questions. If the user explicitly asks about interim/H1/半年/中期, change both quarter filters to 'Interim' instead." \
  "Year-over-year annual (Final-only) financial comparison using self-JOIN on profit_loss" \
  '"SELECT a.fin_yr, a.currency, a.turnover AS current_turnover, b.turnover AS previous_turnover, a.turnover - b.turnover AS turnover_change, ROUND((a.turnover - b.turnover) / b.turnover * 100, 2) AS change_pct FROM profit_loss a JOIN profit_loss b ON a.stock_code = b.stock_code AND a.quarter = b.quarter AND CAST(SUBSTRING(a.fin_yr, 1, 4) AS UNSIGNED) = CAST(SUBSTRING(b.fin_yr, 1, 4) AS UNSIGNED) + 1 AND SUBSTRING(a.fin_yr, 5, 2) = SUBSTRING(b.fin_yr, 5, 2) WHERE a.{{company_name_column}} LIKE '\''%{{company}}%'\'' AND a.fin_yr >= '\''{{start_fin_yr}}'\'' AND a.fin_yr <= '\''{{end_fin_yr}}'\'' AND a.quarter = '\''Final'\'' AND b.quarter = '\''Final'\'' ORDER BY a.fin_yr ASC"' \
  '"profit_loss"'

add "case_library" \
  "Detect abnormal volume on material news days — avg_vol_30d is previous up-to-30 trading days, current day excluded, min 20 valid observations; replace {{date_start}} and {{date_end}} with user-specified range" \
  "News volume anomaly detection with dedup and customer Avg_Vol_30_Pre" \
  '"SELECT n.trade_date AS announcement_date, n.text AS announcement_content, n.securitycode AS stock_code, s.SISTKN AS stock_name FROM (SELECT securitycode, trade_date, MIN(text) AS text FROM sehknews WHERE typeid IN (0,3,7,8,10,14,18,21,25,26,28,32) AND timestamp >= '\''{{date_start}}'\'' AND timestamp < '\''{{date_end}}'\'' GROUP BY securitycode, trade_date) n JOIN ms_t_stk_sis s ON n.securitycode = s.SISTKC AND n.trade_date = s.trade_date WHERE s.avg_vol_30d > 0 AND s.SIVOL > s.avg_vol_30d * 3"' \
  '"sehknews","ms_t_stk_sis"'

add "case_library" \
  "Monthly closing value and MoM change for an index — replace {{year_start}} and {{year_end}} with user-specified year range" \
  "HSI monthly summary using ROW_NUMBER + LAG" \
  '"SELECT month_end, month_end_close, LAG(month_end_close) OVER (ORDER BY month_end) AS prev_month_close, ROUND((month_end_close - LAG(month_end_close) OVER (ORDER BY month_end)) / LAG(month_end_close) OVER (ORDER BY month_end) * 100, 2) AS monthly_pct_change FROM (SELECT trade_date AS month_end, HSHSI AS month_end_close, ROW_NUMBER() OVER (PARTITION BY YEAR(trade_date), MONTH(trade_date) ORDER BY trade_date DESC) AS rn FROM ms_v_stk_hsi_daily WHERE trade_date >= '\''{{year_start}}-01-01'\'' AND trade_date <= '\''{{year_end}}-12-31'\'') t WHERE rn = 1 ORDER BY month_end"' \
  '"ms_v_stk_hsi_daily"'

add "case_library" \
  "Find ALL stocks whose peak consecutive days above MA reach a threshold (no LIMIT) — replace {{MA}} with 3/20/50, {{STREAK_THRESHOLD}} with minimum consecutive days (e.g. 10), {{DATE_START}} and {{DATE_END}} with the user-specified date range. {{STREAK_THRESHOLD}} is a filter threshold, NOT a result count limit. Do NOT add LIMIT unless the user explicitly asks for top N." \
  "All stocks meeting consecutive-days-above-MA threshold within a date range" \
  '"SELECT stock_code, stock_name, max_streak, start_date, end_date FROM (SELECT SISTKC AS stock_code, SISTKN AS stock_name, consecutive_above_ma{{MA}} AS max_streak, consecutive_above_ma{{MA}}_start AS start_date, trade_date AS end_date, ROW_NUMBER() OVER (PARTITION BY SISTKC ORDER BY consecutive_above_ma{{MA}} DESC, trade_date DESC) AS rn FROM ms_t_stk_sis WHERE trade_date >= '\''{{DATE_START}}'\'' AND trade_date <= '\''{{DATE_END}}'\'' AND consecutive_above_ma{{MA}} >= {{STREAK_THRESHOLD}}) t WHERE rn = 1 ORDER BY max_streak DESC, stock_code ASC"' \
  '"ms_t_stk_sis"'

add "case_library" \
  "Top K stocks by longest consecutive days above MA — use ONLY when user explicitly asks for top N / 前N / 排名前N / 最长的N只. Replace {{MA}} with 3/20/50, {{K}} with the requested count, {{DATE_START}}/{{DATE_END}} with the date range." \
  "Top-K ranking by peak consecutive days above MA within a date range" \
  '"SELECT stock_code, stock_name, max_streak, start_date, end_date FROM (SELECT SISTKC AS stock_code, SISTKN AS stock_name, consecutive_above_ma{{MA}} AS max_streak, consecutive_above_ma{{MA}}_start AS start_date, trade_date AS end_date, ROW_NUMBER() OVER (PARTITION BY SISTKC ORDER BY consecutive_above_ma{{MA}} DESC, trade_date DESC) AS rn FROM ms_t_stk_sis WHERE trade_date >= '\''{{DATE_START}}'\'' AND trade_date <= '\''{{DATE_END}}'\'' AND consecutive_above_ma{{MA}} >= 1) t WHERE rn = 1 ORDER BY max_streak DESC, stock_code ASC LIMIT {{K}}"' \
  '"ms_t_stk_sis"'

# ============================================================
# Step 4: 验证
# ============================================================
log ""
log "验证..."
curl -s -X POST "$CATALOG/api/v1/workspaces/$WS/nl2sql-knowledge/list" \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"page_size":50}' | python3 -c "
import sys, json
items = json.load(sys.stdin).get('data',{}).get('items',[])
types = {}
for item in items:
    t = item['knowledge_type']
    types[t] = types.get(t, 0) + 1
print(f'总计 {len(items)} 条: {types}')
"

log ""
log "语义知识库配置完成"
