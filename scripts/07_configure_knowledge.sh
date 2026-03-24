#!/usr/bin/env bash
# HK SFC POC - 语义知识库配置脚本
# 用法: bash scripts/07_configure_knowledge.sh
#
# 前置条件: Catalog 已启动, .env 中有 MOI_SYSTEM_API_KEY 和 POC_WORKSPACE_ID
# 幂等: 先删除旧条目再重建

set -euo pipefail

source /Users/zhangqq/Documents/pythonProject/HK_POC/.env
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
# Step 2: Glossary（术语定义）
# ============================================================
log ""
log "配置 Glossary..."

add "glossary" "closing_field" "CLOSING field in ms_t_stk_hsi" \
  '"The CLOSING column in ms_t_stk_hsi indicates record type: 0 = intraday snapshot captured during trading hours, 9 = end-of-day official closing record."' \
  '"ms_t_stk_hsi"'

add "glossary" "material_news_definition" "Material news definition" \
  '"Material news announcements are records in sehknews where typeid IN (0, 3, 7, 8, 10, 14, 18, 21, 25, 26, 28, 32)."' \
  '"sehknews"'

add "glossary" "fin_yr_format" "Financial year format in profit_loss" \
  '"fin_yr in profit_loss is in YYYYMM format where MM is the fiscal year-end month. Different companies have different fiscal year-end months (e.g. 03=March, 06=June, 09=September, 12=December). Do NOT assume all companies use December (12). When querying revenue for a specific stock, first check what fin_yr values exist for that stock, or use a range query like fin_yr >= 202301 AND fin_yr <= 202512 to capture all fiscal periods."' \
  '"profit_loss"'

add "glossary" "trade_date_column" "Standard date columns" \
  '"trade_date (DATE type) is available in ms_t_stk_hsi and ms_t_stk_sis. ref_date (DATE type) is available in ms_v_stock_capital. Use these standard DATE columns for filtering, ordering, and joins."' \
  '"ms_t_stk_hsi","ms_t_stk_sis","ms_v_stock_capital"'

# ============================================================
# Step 3: Logic（数据模型特征）
# ============================================================
log ""
log "配置 Logic（数据模型）..."

add "logic" "hsi_data_granularity" "HSI table data granularity" \
  '"ms_t_stk_hsi contains approximately 11,000 intraday snapshot records per trading day, capturing index values every few seconds. Only 1 record per day has CLOSING=9 which is the official end-of-day closing value. For daily-level analysis, the table must be filtered to CLOSING=9 first, otherwise JOINs with other daily-granularity tables will produce billions of rows."' \
  '"ms_t_stk_hsi"'

add "logic" "sis_data_granularity" "SIS table data granularity" \
  '"ms_t_stk_sis has exactly 1 record per stock per trading day. Each row contains that stock'\''s daily closing price, high, low, and trading volume."' \
  '"ms_t_stk_sis"'

add "logic" "industry_classification_model" "Industry classification data model" \
  '"ds_t_int_hsicl_dtl only records industry classification CHANGES, not monthly snapshots. If a stock has no record for a given month, it retains its most recent classification (carry forward). When multiple records exist in one month for the same stock, the one with the latest MODIFIED_DATE is the effective classification."' \
  '"ds_t_int_hsicl_dtl"'

add "logic" "stock_capital_granularity" "Stock capital data granularity" \
  '"ms_v_stock_capital has 1 record per stock per month-end (12 months in 2025). SICAP is the market capitalization."' \
  '"ms_v_stock_capital"'

add "logic" "profit_loss_stock_code_format" "Profit loss stock code not zero-padded" \
  '"In profit_loss, stock_code is NOT zero-padded (e.g. 88 instead of 00088). Other tables use 5-digit zero-padded codes. To join profit_loss with other tables, use LPAD(stock_code, 5, '\''0'\'')."' \
  '"profit_loss"'

# ============================================================
# Step 4: Logic（表间关系）
# ============================================================
log ""
log "配置 Logic（表间关系）..."

add "logic" "hsi_sis_relationship" "How to join HSI with SIS" \
  '"ms_t_stk_hsi and ms_t_stk_sis are both keyed by trade_date. However, HSI has ~11,000 rows per day (intraday snapshots) while SIS has ~11,000 rows per day (one per stock). A direct JOIN on trade_date without filtering HSI to CLOSING=9 first will produce ~130 million rows per day. Always aggregate or filter HSI to daily level before joining with SIS."' \
  '"ms_t_stk_hsi","ms_t_stk_sis"'

add "logic" "capital_industry_relationship" "How to join market cap with industry" \
  '"To analyze market cap by industry, join ms_v_stock_capital with ds_t_int_hsicl_dtl on STKCD = STOCK_CODE. Since industry classification uses carry-forward logic, for a given month the effective industry is determined by the most recent MODIFIED_DATE on or before the month-end ref_date."' \
  '"ms_v_stock_capital","ds_t_int_hsicl_dtl"'

add "logic" "news_trading_relationship" "How to join news with trading data" \
  '"To correlate news with trading data, join sehknews with ms_t_stk_sis using securitycode = SISTKC and matching on date. The news timestamp is a datetime, while SIS trade_date is DATE, so extract the date part from timestamp for comparison."' \
  '"sehknews","ms_t_stk_sis"'

add "logic" "ccass_comparison_model" "CCASS day-over-day comparison model" \
  '"To find CCASS inter-broker movements, self-join ccass_holdings for two consecutive dates on stock_code + participant_id. Compare shareholding values between the two dates. Filter out cases where the earlier date shareholding is 0 to avoid division by zero."' \
  '"ccass_holdings"'

add "logic" "sql_dialect_constraints" "Database SQL dialect constraints" \
  '"This database has the following SQL constraints: 1) Window functions (LAG, LEAD, ROW_NUMBER, AVG OVER, etc.) cannot be used directly in WHERE clauses. Always wrap them in a CTE or subquery first, then filter in an outer query. 2) Subqueries in JOIN conditions are not supported. Use CTEs (WITH ... AS) instead. 3) Scalar subqueries with non-equal predicates (< > >= <=) and aggregation are not supported. Use CTEs with window functions instead. Preferred pattern: WITH cte AS (SELECT ..., LAG(...) OVER (...) AS prev_val FROM ...) SELECT ... FROM cte WHERE prev_val IS NOT NULL AND ..."' \
  '"ms_t_stk_hsi","ms_t_stk_sis","ms_v_stock_capital","ds_t_int_hsicl_dtl","sehknews","profit_loss","ccass_holdings"'

# ============================================================
# Step 5: Synonyms（同义词）
# ============================================================
log ""
log "配置 Synonyms..."

add "synonyms" "volume_synonyms" "Trading volume terms" \
  '"trading volume","total volume","market volume","成交量","SIVOL"' \
  '"ms_t_stk_sis"'

add "synonyms" "market_cap_synonyms" "Market capitalization terms" \
  '"market cap","market capitalization","market value","总市值","SICAP"' \
  '"ms_v_stock_capital"'

add "synonyms" "revenue_synonyms" "Revenue terms" \
  '"revenue","turnover","sales","营收","营业收入"' \
  '"profit_loss"'

add "synonyms" "hsi_synonyms" "Hang Seng Index terms" \
  '"HSI","Hang Seng Index","恒生指数","market index","HSHSI"' \
  '"ms_t_stk_hsi"'

add "synonyms" "price_synonyms" "Closing price terms" \
  '"closing price","close price","last price","收盘价","SICLSE"' \
  '"ms_t_stk_sis"'

# ============================================================
# Step 6: 验证
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

log "语义知识库配置完成"
