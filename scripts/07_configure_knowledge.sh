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
# Step 2: 数据范围（引擎无法从 schema 推断）
# ============================================================
log ""
log "配置数据范围..."

add "logic" "data_coverage_hsi" "ms_t_stk_hsi date range" \
  '"ms_t_stk_hsi has trade_date from 2025-01-02 to 2026-03-03."' \
  '"ms_t_stk_hsi"'

add "logic" "data_coverage_sis" "ms_t_stk_sis date range" \
  '"ms_t_stk_sis has trade_date from 2025-01-02 to 2026-03-03."' \
  '"ms_t_stk_sis"'

add "logic" "data_coverage_capital" "ms_v_stock_capital date range" \
  '"ms_v_stock_capital has ref_date monthly from 2025-01-31 to 2025-12-31 (12 months, no 2024 data). H1 2025 market cap comparison should use ref_date 2025-01-31 vs 2025-06-30."' \
  '"ms_v_stock_capital"'

add "logic" "data_coverage_industry" "ds_t_int_hsicl_dtl date range" \
  '"ds_t_int_hsicl_dtl has MODIFIED_DATE from 2025-01-01 to 2025-12-31."' \
  '"ds_t_int_hsicl_dtl"'

add "logic" "data_coverage_news" "sehknews date range" \
  '"sehknews has timestamp from 2025-01-01 to 2025-12-31."' \
  '"sehknews"'

add "logic" "data_coverage_profit" "profit_loss date range" \
  '"profit_loss has fin_yr from 202003 to 202509."' \
  '"profit_loss"'

add "logic" "data_coverage_ccass" "ccass_holdings date range" \
  '"ccass_holdings has holding_date 2026-03-17 and 2026-03-18 only (limited crawl)."' \
  '"ccass_holdings"'

# ============================================================
# Step 3: 业务知识（引擎无法从列注释推断）
# ============================================================
log ""
log "配置业务知识..."

add "logic" "profit_loss_stock_code" "profit_loss stock_code is not zero-padded" \
  '"In profit_loss, stock_code is NOT zero-padded (e.g. 88 instead of 00088, 700 instead of 00700). Always use stock_code to filter, not company_name_en (company names are abbreviated uppercase like TENCENT HOLDINGS LTD. and will not match common formats)."' \
  '"profit_loss"'

add "logic" "material_news_typeid" "Material news typeid definition" \
  '"Material news in sehknews is defined as typeid IN (0, 3, 7, 8, 10, 14, 18, 21, 25, 26, 28, 32)."' \
  '"sehknews"'

add "logic" "derivative_filter" "SISTKC >= 10000 are derivatives, exclude by default" \
  '"In ms_t_stk_sis, SISTKC >= 10000 are derivatives (warrants, CBBCs, 29000+ codes). Always add WHERE SISTKC < '\''10000'\'' to exclude derivatives unless the user explicitly asks about warrants/CBBCs/derivatives."' \
  '"ms_t_stk_sis"'

add "logic" "ccass_participant_granularity" "CCASS inter-broker movement must compare at participant level" \
  '"In ccass_holdings, each row is a (holding_date, stock_code, participant_id) record. When analyzing inter-broker shareholding movement or changes, always compare at the participant_id level — JOIN ON stock_code AND participant_id between two dates. Do NOT aggregate (SUM/GROUP BY) all participants into a stock-level total, as that loses the inter-broker granularity the user is asking about."' \
  '"ccass_holdings"'

add "logic" "industry_carry_forward" "Industry classification uses carry-forward logic" \
  '"ds_t_int_hsicl_dtl only records classification changes, NOT monthly snapshots. To find a stock'\''s industry at a given date, use ROW_NUMBER() OVER (PARTITION BY STOCK_CODE ORDER BY MODIFIED_DATE DESC) with WHERE MODIFIED_DATE <= target_date, then filter rn = 1. Do NOT use correlated subqueries with MAX(MODIFIED_DATE) — use window functions with inline derived tables instead."' \
  '"ds_t_int_hsicl_dtl"'

add "logic" "news_non_trading_day" "sehknews.trade_date is pre-computed nearest trading day" \
  '"sehknews.trade_date is pre-computed as the nearest trading day on or after the news timestamp. To match news with trading data, JOIN sehknews.trade_date = ms_t_stk_sis.trade_date directly. Do NOT use DATE(timestamp) with subqueries to find the nearest trading day — use the pre-computed trade_date column."' \
  '"sehknews","ms_t_stk_sis"'

add "logic" "news_dedup_before_join" "Deduplicate news per stock per day before JOIN" \
  '"When joining sehknews with ms_t_stk_sis for volume or price analysis, ALWAYS deduplicate news first: GROUP BY securitycode, trade_date (keeping one random row per stock per day) BEFORE joining with trading data. This prevents result inflation from multiple news articles for the same stock on the same day. Use a subquery like: SELECT securitycode, trade_date, MIN(text) AS text FROM sehknews WHERE ... GROUP BY securitycode, trade_date."' \
  '"sehknews","ms_t_stk_sis"'

add "logic" "profit_loss_query_pattern" "How to query profit_loss for revenue growth" \
  '"profit_loss.fin_yr is YYYYMM format where MM is the fiscal year ending month. The quarter column is Final (annual) or Interim (half-year). When querying revenue growth across years, do NOT hardcode specific fin_yr values — use a range filter (e.g. fin_yr >= 202303 AND fin_yr <= 202509) and return all matching rows with fin_yr and quarter columns. This lets the user see all available periods. The data range is fin_yr 202003 to 202509."' \
  '"profit_loss"'

add "logic" "chart_friendly_output" "Generate chart-friendly SQL when visualization is requested" \
  '"When the question asks for charts, plots, trends, or visualization (图表/绘制/趋势/走势), generate SQL that returns time series data with a date column and numeric value columns suitable for line chart rendering. Limit results to top 5 representative items (e.g. ORDER BY ... DESC LIMIT 5) if the full result set would be too large for visualization. The frontend can automatically render ECharts line charts from time series data."' \
  '"ms_t_stk_sis","ms_v_stk_hsi_daily","profit_loss","ms_v_stock_capital"'

# ============================================================
# Step 3b: 日线汇总表知识
# ============================================================
log ""
log "配置日线汇总表知识..."

add "logic" "data_coverage_hsi_daily" "ms_v_stk_hsi_daily date range and usage" \
  '"ms_v_stk_hsi_daily is a daily summary table (one row per trading day, ~286 rows). It has pre-computed hsi_pct_change column. Use this table for daily-level HSI analysis instead of ms_t_stk_hsi (which is tick data with ~11000 rows/day)."' \
  '"ms_v_stk_hsi_daily"'

# ============================================================
# Step 3c: 术语表（glossary）
# ============================================================
log ""
log "配置术语表..."

add "glossary" "hk_stock_terminology" "HK stock market terminology" \
  '"恒生指数/恒指/HSI daily data → table ms_v_stk_hsi_daily (NOT ms_t_stk_hsi which is tick data)","成交量/交易量/volume → SIVOL column in ms_t_stk_sis","收盘价/closing price → SICLSE column in ms_t_stk_sis","行业分类/industry classification → table ds_t_int_hsicl_dtl","市值/market cap → table ms_v_stock_capital","新闻/公告/news/announcement → table sehknews","利润/营收/profit/revenue → table profit_loss","CCASS持仓/券商持仓/CCASS holdings → table ccass_holdings"' \
  '"ms_v_stk_hsi_daily","ms_t_stk_sis","ms_v_stock_capital","ds_t_int_hsicl_dtl","sehknews","profit_loss","ccass_holdings"'

# ============================================================
# Step 3d: Fewshot 示例（case_library）
# ============================================================
log ""
log "配置 fewshot 示例..."

add "case_library" \
  "Find stocks where a specific broker increased holdings by more than 50% between two dates" \
  "CCASS broker-level holding change between two dates" \
  '"SELECT a.stock_code, a.participant_id, a.shareholding AS shares_day2, b.shareholding AS shares_day1, (a.shareholding - b.shareholding) / b.shareholding AS change_ratio FROM ccass_holdings a JOIN ccass_holdings b ON a.stock_code = b.stock_code AND a.participant_id = b.participant_id WHERE a.holding_date = '\''2026-03-18'\'' AND b.holding_date = '\''2026-03-17'\'' AND b.shareholding > 0 AND ABS(a.shareholding - b.shareholding) / b.shareholding > 0.5","CCASS data is at (date, stock, participant) granularity. To compare holding changes between dates, always JOIN on both stock_code AND participant_id. Never aggregate participants into stock-level totals when the question asks about broker/inter-broker movement."' \
  '"ccass_holdings"'

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
