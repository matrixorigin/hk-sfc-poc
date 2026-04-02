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
  curl -s -X POST "$CATALOG/api/v1/workspaces/$WS/nl2sql-knowledge" \
    -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
    -d "{
      \"knowledge_base_id\": $KB_ID,
      \"knowledge_type\": \"$type\",
      \"knowledge_key\": \"$key\",
      \"name\": \"$name\",
      \"knowledge_value\": [$value],
      \"associate_tables\": [$tables]
    }" > /dev/null 2>&1
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
  '"ms_v_stock_capital.industry_name is pre-computed from ds_t_int_hsicl_dtl (carry-forward: latest classification as of each month-end). For industry-level market cap analysis, use ms_v_stock_capital.industry_name directly — do NOT join ds_t_int_hsicl_dtl yourself."' \
  '"ms_v_stock_capital","ds_t_int_hsicl_dtl"'

# --- 新闻公告 ---
add "logic" "material_news_typeid" "Material news typeid definition" \
  '"Material news (重大新闻/重大公告) in sehknews is defined as typeid IN (0, 3, 7, 8, 10, 14, 18, 21, 25, 26, 28, 32)."' \
  '"sehknews"'

add "logic" "news_trade_date" "sehknews.trade_date is pre-computed nearest trading day" \
  '"sehknews.trade_date is pre-computed as the nearest trading day on or after the news timestamp. Always use this column (not DATE(timestamp)) to JOIN with ms_t_stk_sis.trade_date."' \
  '"sehknews","ms_t_stk_sis"'

add "logic" "news_dedup" "Deduplicate news per stock per day before joining trading data" \
  '"A stock may have multiple news articles on the same day. When joining sehknews with trading data for analysis, always deduplicate by (securitycode, trade_date) first to avoid result inflation."' \
  '"sehknews","ms_t_stk_sis"'

add "logic" "news_volume_event_granularity" "Volume anomaly detection must return event-level rows, not DISTINCT stocks" \
  '"When detecting volume anomalies related to news (e.g. volume > N times average on news days), output one row per (trade_date, stock) event. Do NOT use SELECT DISTINCT on stock_code alone. The same stock may trigger on multiple dates — each occurrence is a separate detection event that must be reported with its trade_date."' \
  '"sehknews"'

# --- CCASS ---
add "logic" "ccass_participant_granularity" "CCASS must compare at participant level" \
  '"ccass_holdings is at (holding_date, stock_code, participant_id) granularity. When analyzing broker movement or changes, always compare at participant_id level between two dates. Do NOT aggregate participants into stock-level totals."' \
  '"ccass_holdings"'

# --- 利润表 ---
add "logic" "profit_loss_stock_code" "profit_loss stock_code format and company name search" \
  '"In profit_loss, stock_code is NOT zero-padded (e.g. 88 not 00088). When the user references a company by name, use LIKE on the column matching the input language — using the wrong column returns 0 rows: company_name_sc for simplified Chinese, company_name_tc for traditional Chinese, company_name_en for English. Identify traditional vs simplified Chinese by character form (e.g. 體/体, 國/国, 東/东). Do NOT extract numbers from the name as stock_code (e.g. \"360鲁大师\" → stock_code is 3601, not 360)."' \
  '"profit_loss"'

add "logic" "profit_loss_period_comparison" "Revenue/profit analysis must use like-for-like period comparison" \
  '"profit_loss.fin_yr is YYYYMM format (e.g. 202312 = Dec 2023). quarter is Final (annual) or Interim (half-year). CRITICAL: Use self-JOIN (NOT LAG/LEAD) to compare same quarter across years, joining on stock_code + quarter + year offset (CAST(SUBSTRING(a.fin_yr,1,4) AS UNSIGNED) = CAST(SUBSTRING(b.fin_yr,1,4) AS UNSIGNED) + 1 AND SUBSTRING(a.fin_yr,5,2) = SUBSTRING(b.fin_yr,5,2)). LAG/LEAD over fin_yr will incorrectly compare Final with Interim — this is WRONG. Unless the user explicitly asks for only annual or only interim, always include BOTH Final and Interim. \"growth from X to Y\" / \"X到Y年增长\" means YEAR-OVER-YEAR comparison for EVERY year in the range, NOT just start vs end. Include (Y-X+1) baseline year data. Example: \"growth from 2023 to 2025\" → use a.fin_yr >= '\''202301'\'' (not 202306) to include all 2023 periods (both 202303 Final and 202306 Interim), and include 2022 baseline data via the self-JOIN. The YYYYMM filter is a string comparison, so >= '\''202301'\'' correctly matches 202303, 202306, etc."' \
  '"profit_loss"'

# --- 日线汇总 ---
add "logic" "hsi_daily_usage" "Use ms_v_stk_hsi_daily for daily HSI analysis" \
  '"ms_v_stk_hsi_daily is a daily summary table (one row per trading day, ~286 rows) with pre-computed hsi_pct_change. Use this instead of ms_t_stk_hsi (tick data, ~11000 rows/day) for daily-level HSI analysis."' \
  '"ms_v_stk_hsi_daily"'

# --- 可视化 ---
add "logic" "chart_friendly_output" "Generate chart-friendly SQL when visualization is requested" \
  '"When the question asks for charts/plots/trends/visualization (图表/绘制/趋势/走势), return time series data with a date column and numeric columns. Limit to top 5 items if the result set would be too large."' \
  '"ms_t_stk_sis","ms_v_stk_hsi_daily","profit_loss","ms_v_stock_capital"'

# --- 日期边界约束（通用） ---
add "logic" "date_boundary_constraint" "All SQL date literals must fall within actual data coverage" \
  '"Every date literal in SQL MUST fall within the table'\''s actual data range (see data_coverage_* entries). Dates outside the range return ZERO rows and produce WRONG answers. For daily tables (ms_t_stk_sis, ms_t_stk_hsi, ms_v_stk_hsi_daily, sehknews), use normal calendar dates like {year}-01-01 for year start. Do NOT use month-end dates (01-31, 07-31) for daily tables."' \
  '"ms_t_stk_hsi","ms_t_stk_sis","ds_t_int_hsicl_dtl","sehknews","profit_loss","ccass_holdings","ms_v_stk_hsi_daily"'

# --- 日期边界约束（ms_v_stock_capital 专用） ---
add "logic" "date_boundary_capital_monthly" "ms_v_stock_capital ref_date is month-end only" \
  '"ms_v_stock_capital.ref_date contains ONLY month-end dates (01-31, 02-28, ..., 12-31). You MUST use month-end dates when querying this table. Period mapping: H1 {year} → start={year}-01-31 end={year}-06-30. H2 {year} → start={year}-07-31 end={year}-12-31. Full year {year} → start={year}-01-31 end={year}-12-31. WRONG examples: {year}-01-01, {year}-06-01, {year}-07-01 (these are NOT month-end and will match ZERO rows). The start date is ALWAYS the first month-end WITHIN the period, NEVER the last day of the previous period (e.g. 2024-12-31 does not exist in this table)."' \
  '"ms_v_stock_capital"'

# --- 方向性语义约束 ---
add "logic" "directional_filter_constraint" "Decline/increase queries must include sign filter" \
  '"When the user asks about decline/decrease/drop (下降/下跌/减少/缩水/亏损), the SQL MUST include a < 0 filter on the computed change column. When the user asks about increase/growth/rise (上升/上涨/增长/增加), the SQL MUST include a > 0 filter. Without this filter, ORDER BY ASC/DESC LIMIT N may return results that do not match the directional intent (e.g. returning the smallest gain instead of an actual decline)."' \
  '"ms_t_stk_sis","ms_v_stock_capital","profit_loss","ms_v_stk_hsi_daily","ccass_holdings"'

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
  '"恒生指数/恒指/HSI daily data → table ms_v_stk_hsi_daily (NOT ms_t_stk_hsi which is tick data)","成交量/交易量/volume → SIVOL column in ms_t_stk_sis","收盘价/closing price → SICLSE column in ms_t_stk_sis","行业分类/industry classification → table ds_t_int_hsicl_dtl","市值/market cap → table ms_v_stock_capital","新闻/公告/news/announcement → table sehknews","利润/营收/profit/revenue → table profit_loss","CCASS持仓/券商持仓/CCASS holdings → table ccass_holdings"' \
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

# ============================================================
# Step 3d: Fewshot 示例（case_library — 可复用的 SQL 模式）
# ============================================================
log ""
log "配置 fewshot 示例..."

add "case_library" \
  "Which N industries had the largest market cap decline/increase in H1/H2/full-year — date mapping: H1 {{year}}={{year}}-01-31 to {{year}}-06-30, H2 {{year}}={{year}}-07-31 to {{year}}-12-31, full year={{year}}-01-31 to {{year}}-12-31. For decline use ORDER BY ASC + change<0; for increase use ORDER BY DESC + change>0" \
  "Industry market cap period comparison on ms_v_stock_capital" \
  '"SELECT industry_name, market_cap_start, market_cap_end, market_cap_change, ROUND(market_cap_change / market_cap_start * 100, 2) AS change_pct FROM (SELECT industry_name, SUM(CASE WHEN ref_date = '\''{{period_start}}'\'' THEN SICAP ELSE 0 END) AS market_cap_start, SUM(CASE WHEN ref_date = '\''{{period_end}}'\'' THEN SICAP ELSE 0 END) AS market_cap_end, SUM(CASE WHEN ref_date = '\''{{period_end}}'\'' THEN SICAP ELSE 0 END) - SUM(CASE WHEN ref_date = '\''{{period_start}}'\'' THEN SICAP ELSE 0 END) AS market_cap_change FROM ms_v_stock_capital WHERE ref_date IN ('\''{{period_start}}'\'', '\''{{period_end}}'\'') AND industry_name IS NOT NULL GROUP BY industry_name HAVING market_cap_start > 0 AND market_cap_end > 0) t WHERE market_cap_change < 0 ORDER BY market_cap_change ASC LIMIT {{N}}"' \
  '"ms_v_stock_capital"'

add "case_library" \
  "CCASS broker holding change: compare date_T vs date_T_minus_1 at participant level, replace date placeholders with user-specified dates" \
  "CCASS broker-level holding change between two dates" \
  '"SELECT a.stock_code, a.participant_id, a.shareholding AS shares_day2, b.shareholding AS shares_day1, (a.shareholding - b.shareholding) / b.shareholding AS change_ratio FROM ccass_holdings a JOIN ccass_holdings b ON a.stock_code = b.stock_code AND a.participant_id = b.participant_id WHERE a.holding_date = '\''{{date_T}}'\'' AND b.holding_date = '\''{{date_T_minus_1}}'\'' AND b.shareholding > 0 AND ABS(a.shareholding - b.shareholding) / b.shareholding > 0.5"' \
  '"ccass_holdings"'

add "case_library" \
  "YoY revenue/profit comparison — replace {{company_name_column}} with company_name_sc (simplified), company_name_tc (traditional), or company_name_en (English) based on user input language; replace {{company}} and {{start_fin_yr}} with user-specified values" \
  "Year-over-year financial comparison using self-JOIN on profit_loss" \
  '"SELECT a.fin_yr, a.quarter, a.turnover AS current_turnover, b.turnover AS previous_turnover, a.turnover - b.turnover AS turnover_change, ROUND((a.turnover - b.turnover) / b.turnover * 100, 2) AS change_pct FROM profit_loss a JOIN profit_loss b ON a.stock_code = b.stock_code AND a.quarter = b.quarter AND CAST(SUBSTRING(a.fin_yr, 1, 4) AS UNSIGNED) = CAST(SUBSTRING(b.fin_yr, 1, 4) AS UNSIGNED) + 1 AND SUBSTRING(a.fin_yr, 5, 2) = SUBSTRING(b.fin_yr, 5, 2) WHERE a.{{company_name_column}} LIKE '\''%{{company}}%'\'' AND a.fin_yr >= '\''{{start_fin_yr}}'\'' ORDER BY a.fin_yr, a.quarter"' \
  '"profit_loss"'

add "case_library" \
  "Detect abnormal volume on material news days — replace {{date_start}} and {{date_end}} with user-specified range" \
  "News volume anomaly detection with dedup and avg_vol_30d" \
  '"SELECT n.trade_date AS announcement_date, n.text AS announcement_content, n.securitycode AS stock_code, s.SISTKN AS stock_name FROM (SELECT securitycode, trade_date, MIN(text) AS text FROM sehknews WHERE typeid IN (0,3,7,8,10,14,18,21,25,26,28,32) AND timestamp >= '\''{{date_start}}'\'' AND timestamp < '\''{{date_end}}'\'' GROUP BY securitycode, trade_date) n JOIN ms_t_stk_sis s ON n.securitycode = s.SISTKC AND n.trade_date = s.trade_date WHERE s.avg_vol_30d > 0 AND s.SIVOL > s.avg_vol_30d * 3"' \
  '"sehknews","ms_t_stk_sis"'

add "case_library" \
  "Monthly closing value and MoM change for an index — replace {{year_start}} and {{year_end}} with user-specified year range" \
  "HSI monthly summary using ROW_NUMBER + LAG" \
  '"SELECT month_end, month_end_close, LAG(month_end_close) OVER (ORDER BY month_end) AS prev_month_close, ROUND((month_end_close - LAG(month_end_close) OVER (ORDER BY month_end)) / LAG(month_end_close) OVER (ORDER BY month_end) * 100, 2) AS monthly_pct_change FROM (SELECT trade_date AS month_end, HSHSI AS month_end_close, ROW_NUMBER() OVER (PARTITION BY YEAR(trade_date), MONTH(trade_date) ORDER BY trade_date DESC) AS rn FROM ms_v_stk_hsi_daily WHERE trade_date >= '\''{{year_start}}-01-01'\'' AND trade_date <= '\''{{year_end}}-12-31'\'') t WHERE rn = 1 ORDER BY month_end"' \
  '"ms_v_stk_hsi_daily"'

add "case_library" \
  "List top N stocks by peak consecutive days above MA — replace {{MA}} with 3/20/50, {{N}} with minimum streak threshold" \
  "Stocks ranked by max consecutive days above moving average with date range" \
  '"SELECT stock_code, stock_name, max_streak, start_date, end_date FROM (SELECT SISTKC AS stock_code, SISTKN AS stock_name, consecutive_above_ma{{MA}} AS max_streak, consecutive_above_ma{{MA}}_start AS start_date, trade_date AS end_date, ROW_NUMBER() OVER (PARTITION BY SISTKC ORDER BY consecutive_above_ma{{MA}} DESC, trade_date DESC) AS rn FROM ms_t_stk_sis WHERE consecutive_above_ma{{MA}} >= {{N}}) t WHERE rn = 1 ORDER BY max_streak DESC"' \
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
