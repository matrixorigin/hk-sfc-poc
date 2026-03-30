#!/usr/bin/env bash
# HK SFC POC - 数据导入脚本
# 用法: ./scripts/02_import_data.sh
#
# 依赖: mysql client, python3

set -euo pipefail

# ---- 配置 ----
MO_HOST="${MO_HOST:-127.0.0.1}"
MO_PORT="${MO_PORT:-16002}"
MO_DB="hk_sfc"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DATA_DIR="$PROJECT_DIR/POC DATA_01/数据"

# 从 .env 获取 Catalog 凭据，自动推导 workspace 账号
source "$PROJECT_DIR/.env"
CATALOG_URL="${CATALOG_URL:-http://localhost:8084}"

if [ -n "${MO_USER:-}" ] && [ -n "${MO_PASS:-}" ]; then
  log "使用指定账号: $MO_USER"
else
  ACCT=$(curl -s "$CATALOG_URL/api/v1/workspaces/$POC_WORKSPACE_ID" \
    -H "X-API-Key: $MOI_SYSTEM_API_KEY" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['account_name'])" 2>/dev/null)
  if [ -z "$ACCT" ]; then
    log "ERROR: 无法获取 workspace 账号，请确认 Catalog 已启动且 .env 配置正确"
    exit 1
  fi
  MO_USER="${ACCT}:moi_core_system"
  MO_PASS="$MOI_SYSTEM_API_KEY"
  log "使用 workspace 账号: $MO_USER"
fi

MYSQL_CMD="mysql -h $MO_HOST -P $MO_PORT -u $MO_USER -p$MO_PASS --local-infile=1"

# ---- 辅助函数 ----
log() { echo "[$(date '+%H:%M:%S')] $*"; }

run_sql() {
    $MYSQL_CMD "$MO_DB" -e "$1" 2>&1 | { grep -v "Warning.*password" || true; }
}

load_csv() {
    local table="$1"
    local file="$2"
    local extra="${3:-}"

    local rows
    rows=$(wc -l < "$file")
    log "导入 $table ($((rows - 1)) 行) ← $(basename "$file")"

    $MYSQL_CMD "$MO_DB" --local-infile=1 -e "
        LOAD DATA LOCAL INFILE '$file'
        INTO TABLE $table
        FIELDS TERMINATED BY ','
        OPTIONALLY ENCLOSED BY '\"'
        LINES TERMINATED BY '\n'
        IGNORE 1 LINES
        $extra;
    " 2>&1 | { grep -v "Warning.*password" || true; }

    local count
    count=$(run_sql "SELECT COUNT(*) AS cnt FROM $table;" | tail -1)
    log "  -> $table 现有 $count 行"
}

# ---- Step 1: 建库建表 ----
log "========== Step 1: 建库建表 =========="
$MYSQL_CMD < "$SCRIPT_DIR/01_create_tables.sql" 2>&1 | { grep -v "Warning.*password" || true; }
log "建表完成"

# ---- Step 2: 导入 CSV ----
log ""
log "========== Step 2: 导入 CSV 数据 =========="

load_csv "ms_t_stk_hsi" "$DATA_DIR/WORK_FILTER_FOR_MS_T_STK_HSI_0000.csv"
load_csv "ms_t_stk_sis" "$DATA_DIR/WORK_FILTER_FOR_MS_T_STK_SIS.csv"
load_csv "ms_v_stock_capital" "$DATA_DIR/SFC.MS_V_STOCK_CAPITAL Dummy.csv"
load_csv "ds_t_int_hsicl_dtl" "$DATA_DIR/DS_T_INT_HSICL_DTL Dummy.csv"
load_csv "sehknews" "$DATA_DIR/sehknews.csv"

# ---- Step 3: 解析 XML 并导入 profit_loss ----
log ""
log "========== Step 3: 解析 profit_loss XML 并导入 =========="

PROFIT_LOSS_CSV="/tmp/hk_sfc_profit_loss.csv"

python3 - "$DATA_DIR/profit_loss/xml" "$PROFIT_LOSS_CSV" << 'PYEOF'
import sys, os, csv
import xml.etree.ElementTree as ET

xml_dir = sys.argv[1]
out_csv = sys.argv[2]

fields_map = {
    'Turnover': 'turnover',
    'CostofSales': 'cost_of_sales',
    'GrossProfit': 'gross_profit',
    'PLBT': 'plbt',
    'Taxation': 'taxation',
    'PLAttrtoShHolder': 'pl_attr_to_shareholder',
    'NetFinancialCosts': 'net_financial_costs',
    'DeprecAmort': 'deprec_amort',
}

csv_columns = [
    'stock_code', 'company_name_en', 'company_name_sc', 'company_name_tc',
    'fin_yr', 'quarter', 'currency',
    'turnover', 'cost_of_sales', 'gross_profit', 'plbt', 'taxation',
    'pl_attr_to_shareholder', 'net_financial_costs', 'deprec_amort',
    'eps', 'dps', 'nbv_per_share',
]

rows = []
xml_files = sorted([f for f in os.listdir(xml_dir) if f.endswith('.xml') and not f.startswith('._')])
print(f"解析 {len(xml_files)} 个 XML 文件...")

for fname in xml_files:
    try:
        tree = ET.parse(os.path.join(xml_dir, fname))
        root = tree.getroot()

        stock_code = (root.findtext('StockCode') or '').strip()
        name_en = (root.findtext('CompanyNameEN') or '').strip()
        name_sc = (root.findtext('CompanyNameSC') or '').strip()
        name_tc = (root.findtext('CompanyNameTC') or '').strip()

        pl = root.find('ProfitAndLoss')
        if pl is None:
            continue

        for fy in pl.findall('FinancialYr'):
            fin_yr = fy.get('FinYr', '')
            quarter = fy.get('Quarter', '')
            currency = (fy.findtext('Currency') or '').strip()

            row = {
                'stock_code': stock_code,
                'company_name_en': name_en,
                'company_name_sc': name_sc,
                'company_name_tc': name_tc,
                'fin_yr': fin_yr,
                'quarter': quarter,
                'currency': currency,
            }

            def clean_num(v):
                if not v:
                    return None
                v = v.strip()
                if v in ('', '--', 'N/A', '-'):
                    return None
                try:
                    float(v)
                    return v
                except ValueError:
                    return None

            for xml_field, csv_field in fields_map.items():
                val = (fy.findtext(xml_field) or '').strip()
                row[csv_field] = clean_num(val)

            mvi = fy.find('MarketValueIndicator')
            if mvi is not None:
                for tag, col in [('EPS', 'eps'), ('DPS', 'dps'), ('NBVPerShare', 'nbv_per_share')]:
                    val = (mvi.findtext(tag) or '').strip()
                    row[col] = clean_num(val)
            else:
                row['eps'] = row['dps'] = row['nbv_per_share'] = None

            rows.append(row)
    except Exception as e:
        print(f"  警告: 解析 {fname} 失败: {e}")

with open(out_csv, 'w', newline='', encoding='utf-8') as f:
    writer = csv.DictWriter(f, fieldnames=csv_columns)
    writer.writeheader()
    writer.writerows(rows)

print(f"生成 {len(rows)} 行 -> {out_csv}")
PYEOF

load_csv "profit_loss" "$PROFIT_LOSS_CSV"
rm -f "$PROFIT_LOSS_CSV"

# ---- Step 4: 日期标准化 ----
log ""
log "========== Step 4: 日期标准化 =========="

log "ms_t_stk_hsi.trade_date..."
run_sql "
UPDATE ms_t_stk_hsi SET trade_date = CAST(
  CONCAT(
    SUBSTR(HSTXDT, 6, 4), '-',
    CASE SUBSTR(HSTXDT, 3, 3)
      WHEN 'JAN' THEN '01' WHEN 'FEB' THEN '02' WHEN 'MAR' THEN '03'
      WHEN 'APR' THEN '04' WHEN 'MAY' THEN '05' WHEN 'JUN' THEN '06'
      WHEN 'JUL' THEN '07' WHEN 'AUG' THEN '08' WHEN 'SEP' THEN '09'
      WHEN 'OCT' THEN '10' WHEN 'NOV' THEN '11' WHEN 'DEC' THEN '12'
    END, '-',
    SUBSTR(HSTXDT, 1, 2)
  ) AS DATE
) WHERE trade_date IS NULL;
"

log "ms_t_stk_sis.trade_date..."
run_sql "
UPDATE ms_t_stk_sis SET trade_date = CAST(
  CONCAT(
    SUBSTR(SITXDT, 6, 4), '-',
    CASE SUBSTR(SITXDT, 3, 3)
      WHEN 'JAN' THEN '01' WHEN 'FEB' THEN '02' WHEN 'MAR' THEN '03'
      WHEN 'APR' THEN '04' WHEN 'MAY' THEN '05' WHEN 'JUN' THEN '06'
      WHEN 'JUL' THEN '07' WHEN 'AUG' THEN '08' WHEN 'SEP' THEN '09'
      WHEN 'OCT' THEN '10' WHEN 'NOV' THEN '11' WHEN 'DEC' THEN '12'
    END, '-',
    SUBSTR(SITXDT, 1, 2)
  ) AS DATE
) WHERE trade_date IS NULL;
"

log "ms_v_stock_capital.ref_date..."
run_sql "
UPDATE ms_v_stock_capital SET ref_date = CAST(
  CONCAT(
    '20', SUBSTR(SIRXDT, 8, 2), '-',
    CASE SUBSTR(SIRXDT, 4, 3)
      WHEN 'JAN' THEN '01' WHEN 'FEB' THEN '02' WHEN 'MAR' THEN '03'
      WHEN 'APR' THEN '04' WHEN 'MAY' THEN '05' WHEN 'JUN' THEN '06'
      WHEN 'JUL' THEN '07' WHEN 'AUG' THEN '08' WHEN 'SEP' THEN '09'
      WHEN 'OCT' THEN '10' WHEN 'NOV' THEN '11' WHEN 'DEC' THEN '12'
    END, '-',
    SUBSTR(SIRXDT, 1, 2)
  ) AS DATE
) WHERE ref_date IS NULL;
"
log "sehknews.trade_date (nearest trading day)..."
run_sql "
UPDATE sehknews n
JOIN (
    SELECT news_date, trade_date
    FROM (
        SELECT nd.dt AS news_date, td.trade_date,
               ROW_NUMBER() OVER (PARTITION BY nd.dt ORDER BY td.trade_date) AS rn
        FROM (SELECT DISTINCT DATE(\`timestamp\`) AS dt FROM sehknews) nd
        JOIN (SELECT DISTINCT trade_date FROM ms_t_stk_sis) td
          ON td.trade_date >= nd.dt
          AND td.trade_date <= DATE_ADD(nd.dt, INTERVAL 7 DAY)
    ) ranked WHERE rn = 1
) mapping ON DATE(n.\`timestamp\`) = mapping.news_date
SET n.trade_date = mapping.trade_date
WHERE n.trade_date IS NULL;
"

log "日期标准化完成"

# ---- Step 4b: ms_v_stock_capital.industry_name (carry-forward) ----
log ""
log "计算 ms_v_stock_capital.industry_name..."
# 对每只股票每个月，取 MODIFIED_DATE <= ref_date 的最新行业分类
# 用 Python 计算避免 MO 窗口函数限制
$MYSQL_CMD "$MO_DB" -N -B -e "
SELECT STOCK_CODE, MODIFIED_DATE, INDUSTRY_NAME
FROM ds_t_int_hsicl_dtl ORDER BY STOCK_CODE, MODIFIED_DATE;
" 2>/dev/null > /tmp/_industry_cls.tsv

$MYSQL_CMD "$MO_DB" -N -B -e "
SELECT DISTINCT STKCD, ref_date FROM ms_v_stock_capital WHERE ref_date IS NOT NULL ORDER BY STKCD, ref_date;
" 2>/dev/null > /tmp/_cap_dates.tsv

python3 -c "
import sys
from bisect import bisect_right

# 读取行业分类变更记录
cls = {}  # stock_code -> [(date, industry_name), ...]
with open('/tmp/_industry_cls.tsv') as f:
    for line in f:
        parts = line.strip().split('\t')
        if len(parts) >= 3:
            code, date, name = parts[0], parts[1], parts[2]
            cls.setdefault(code, []).append((date, name))

# 对每只股票的分类按日期排序
for code in cls:
    cls[code].sort()

# 对每个 (STKCD, ref_date) 找最新分类
with open('/tmp/_cap_industry.csv', 'w') as out:
    with open('/tmp/_cap_dates.tsv') as f:
        for line in f:
            parts = line.strip().split('\t')
            if len(parts) < 2: continue
            stkcd, ref_date = parts[0], parts[1]
            records = cls.get(stkcd, [])
            if not records:
                continue
            dates = [r[0] for r in records]
            idx = bisect_right(dates, ref_date) - 1
            if idx >= 0:
                industry = records[idx][1]
                out.write(f'{stkcd},{ref_date},{industry}\n')

import os
count = sum(1 for _ in open('/tmp/_cap_industry.csv'))
print(f'{count} rows')
"

run_sql "DROP TABLE IF EXISTS _tmp_cap_industry;"
run_sql "CREATE TABLE _tmp_cap_industry (STKCD VARCHAR(10), ref_date DATE, industry_name VARCHAR(100));"
$MYSQL_CMD "$MO_DB" --local-infile=1 -e "
LOAD DATA LOCAL INFILE '/tmp/_cap_industry.csv'
INTO TABLE _tmp_cap_industry
FIELDS TERMINATED BY ','
LINES TERMINATED BY '\n';
" 2>&1 | { grep -v "Warning.*password" || true; }
run_sql "
UPDATE ms_v_stock_capital t
JOIN _tmp_cap_industry c ON t.STKCD = c.STKCD AND t.ref_date = c.ref_date
SET t.industry_name = c.industry_name;
"
run_sql "DROP TABLE IF EXISTS _tmp_cap_industry;"
rm -f /tmp/_industry_cls.tsv /tmp/_cap_dates.tsv /tmp/_cap_industry.csv

filled=$($MYSQL_CMD "$MO_DB" -N -B -e "SELECT COUNT(*) FROM ms_v_stock_capital WHERE industry_name IS NOT NULL;" 2>/dev/null)
log "  industry_name 填充: $filled 行"

# ---- Step 5: 预计算列 (ms_t_stk_sis) ----
log ""
log "========== Step 5: 预计算列 =========="

log "计算 MA3/MA20/MA50/MA100..."
run_sql "
UPDATE ms_t_stk_sis t
JOIN (
    SELECT SISTKC, trade_date,
           AVG(SICLSE) OVER (PARTITION BY SISTKC ORDER BY trade_date ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) AS ma3,
           AVG(SICLSE) OVER (PARTITION BY SISTKC ORDER BY trade_date ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS ma20,
           AVG(SICLSE) OVER (PARTITION BY SISTKC ORDER BY trade_date ROWS BETWEEN 49 PRECEDING AND CURRENT ROW) AS ma50,
           AVG(SICLSE) OVER (PARTITION BY SISTKC ORDER BY trade_date ROWS BETWEEN 99 PRECEDING AND CURRENT ROW) AS ma100
    FROM ms_t_stk_sis
    WHERE SISTKC < '10000'
) calc ON t.SISTKC = calc.SISTKC AND t.trade_date = calc.trade_date
SET t.ma_3 = calc.ma3, t.ma_20 = calc.ma20, t.ma_50 = calc.ma50, t.ma_100 = calc.ma100;
"

log "计算 consecutive_above_ma3 (Python + temp table)..."
# 导出 → Python 计算连续天数 → 写 CSV → LOAD DATA LOCAL
$MYSQL_CMD "$MO_DB" -N -B -e "
SELECT SISTKC, trade_date, CASE WHEN SICLSE > ma_3 THEN 1 ELSE 0 END
FROM ms_t_stk_sis
WHERE SISTKC < '10000' AND ma_3 IS NOT NULL
ORDER BY SISTKC, trade_date;
" 2>/dev/null | python3 -c "
import sys
prev, streak = None, 0
for line in sys.stdin:
    code, date, above = line.strip().split('\t')
    if code != prev: streak = 0; prev = code
    streak = streak + 1 if above == '1' else 0
    print(f'{code},{date},{streak}')
" > /tmp/_consecutive_ma3.csv

row_count=$(wc -l < /tmp/_consecutive_ma3.csv)
log "  Python 计算完成: $row_count 行"

run_sql "DROP TABLE IF EXISTS _tmp_consec_ma3;"
run_sql "CREATE TABLE _tmp_consec_ma3 (SISTKC VARCHAR(10), trade_date DATE, streak INT);"
$MYSQL_CMD "$MO_DB" --local-infile=1 -e "
LOAD DATA LOCAL INFILE '/tmp/_consecutive_ma3.csv'
INTO TABLE _tmp_consec_ma3
FIELDS TERMINATED BY ','
LINES TERMINATED BY '\n';
" 2>&1 | { grep -v "Warning.*password" || true; }
run_sql "
UPDATE ms_t_stk_sis t
JOIN _tmp_consec_ma3 c ON t.SISTKC = c.SISTKC AND t.trade_date = c.trade_date
SET t.consecutive_above_ma3 = c.streak;
"
run_sql "DROP TABLE IF EXISTS _tmp_consec_ma3;"
rm -f /tmp/_consecutive_ma3.csv

log "计算 consecutive_above_ma20 (Python + temp table)..."
$MYSQL_CMD "$MO_DB" -N -B -e "
SELECT SISTKC, trade_date, CASE WHEN SICLSE > ma_20 THEN 1 ELSE 0 END
FROM ms_t_stk_sis
WHERE SISTKC < '10000' AND ma_20 IS NOT NULL
ORDER BY SISTKC, trade_date;
" 2>/dev/null | python3 -c "
import sys
prev, streak = None, 0
for line in sys.stdin:
    code, date, above = line.strip().split('\t')
    if code != prev: streak = 0; prev = code
    streak = streak + 1 if above == '1' else 0
    print(f'{code},{date},{streak}')
" > /tmp/_consecutive_ma20.csv

row_count=$(wc -l < /tmp/_consecutive_ma20.csv)
log "  Python 计算完成: $row_count 行"

run_sql "DROP TABLE IF EXISTS _tmp_consec_ma20;"
run_sql "CREATE TABLE _tmp_consec_ma20 (SISTKC VARCHAR(10), trade_date DATE, streak INT);"
$MYSQL_CMD "$MO_DB" --local-infile=1 -e "
LOAD DATA LOCAL INFILE '/tmp/_consecutive_ma20.csv'
INTO TABLE _tmp_consec_ma20
FIELDS TERMINATED BY ','
LINES TERMINATED BY '\n';
" 2>&1 | { grep -v "Warning.*password" || true; }
run_sql "
UPDATE ms_t_stk_sis t
JOIN _tmp_consec_ma20 c ON t.SISTKC = c.SISTKC AND t.trade_date = c.trade_date
SET t.consecutive_above_ma20 = c.streak;
"
run_sql "DROP TABLE IF EXISTS _tmp_consec_ma20;"
rm -f /tmp/_consecutive_ma20.csv

log "计算 consecutive_above_ma50..."
run_sql "
UPDATE ms_t_stk_sis t
JOIN (
    SELECT SISTKC, trade_date,
           SUM(CASE WHEN SICLSE > ma_50 THEN 1 ELSE 0 END) OVER (
               PARTITION BY SISTKC ORDER BY trade_date
               ROWS BETWEEN 49 PRECEDING AND CURRENT ROW
           ) AS consec
    FROM ms_t_stk_sis
    WHERE SISTKC < '10000' AND ma_50 IS NOT NULL
) calc ON t.SISTKC = calc.SISTKC AND t.trade_date = calc.trade_date
SET t.consecutive_above_ma50 = calc.consec;
"

log "计算 avg_vol_30d..."
run_sql "
UPDATE ms_t_stk_sis t
JOIN (
    SELECT SISTKC, trade_date,
           AVG(SIVOL) OVER (PARTITION BY SISTKC ORDER BY trade_date ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING) AS avg30
    FROM ms_t_stk_sis
    WHERE SISTKC < '10000'
) calc ON t.SISTKC = calc.SISTKC AND t.trade_date = calc.trade_date
SET t.avg_vol_30d = calc.avg30;
"
log "预计算列完成"

# 验证预计算列
log "验证预计算列..."
run_sql "SELECT SUM(CASE WHEN ma_50 IS NOT NULL THEN 1 ELSE 0 END) as has_ma50, SUM(CASE WHEN consecutive_above_ma50 IS NOT NULL THEN 1 ELSE 0 END) as has_consec, SUM(CASE WHEN avg_vol_30d IS NOT NULL THEN 1 ELSE 0 END) as has_avgvol FROM ms_t_stk_sis;"

# ---- Step 6: 日线汇总表 (ms_v_stk_hsi_daily) ----
log ""
log "========== Step 6: HSI 日线汇总表 =========="
run_sql "DROP TABLE IF EXISTS ms_v_stk_hsi_daily;"
run_sql "
CREATE TABLE ms_v_stk_hsi_daily AS
SELECT trade_date, HSHSI, HSFIN, HSUTL, HSPROP, HSCANI,
       (HSHSI - LAG(HSHSI) OVER (ORDER BY trade_date))
       / LAG(HSHSI) OVER (ORDER BY trade_date) * 100 AS hsi_pct_change
FROM ms_t_stk_hsi
WHERE CLOSING = 9
ORDER BY trade_date;
"
run_sql "UPDATE ms_v_stk_hsi_daily SET hsi_pct_change = 0 WHERE hsi_pct_change IS NULL;"
run_sql "ALTER TABLE ms_v_stk_hsi_daily MODIFY COLUMN trade_date DATE COMMENT 'Trading date (one row per trading day, excludes weekends/holidays). 交易日期（每个交易日一行，不含周末和节假日）。To query a specific month closing, use <= month_end_date ORDER BY trade_date DESC LIMIT 1.';"
run_sql "ALTER TABLE ms_v_stk_hsi_daily MODIFY COLUMN HSHSI DECIMAL(16,4) COMMENT 'Hang Seng Index daily closing value. 恒生指数/恒指收盘值。';"
run_sql "ALTER TABLE ms_v_stk_hsi_daily MODIFY COLUMN HSFIN DECIMAL(16,4) COMMENT 'Hang Seng Finance Sub-index daily closing. 恒生金融分类指数。';"
run_sql "ALTER TABLE ms_v_stk_hsi_daily MODIFY COLUMN HSUTL DECIMAL(16,4) COMMENT 'Hang Seng Utilities Sub-index daily closing. 恒生公用事业分类指数。';"
run_sql "ALTER TABLE ms_v_stk_hsi_daily MODIFY COLUMN HSPROP DECIMAL(16,4) COMMENT 'Hang Seng Properties Sub-index daily closing. 恒生地产分类指数。';"
run_sql "ALTER TABLE ms_v_stk_hsi_daily MODIFY COLUMN HSCANI DECIMAL(16,4) COMMENT 'Hang Seng Commerce & Industry Sub-index daily closing. 恒生工商业分类指数。';"
run_sql "ALTER TABLE ms_v_stk_hsi_daily MODIFY COLUMN hsi_pct_change DECIMAL(16,10) COMMENT 'HSI daily percentage change vs previous trading day. 恒指日涨跌幅(%)。Negative means decline, e.g. -2.5 means dropped 2.5%.';"
log "日线汇总表完成 ($(run_sql "SELECT COUNT(*) FROM ms_v_stk_hsi_daily" | tail -1) 行)"

# ---- Step 7: 列注释更新 ----
log ""
log "========== Step 7: 列注释更新 =========="
run_sql "ALTER TABLE ms_t_stk_hsi MODIFY COLUMN CLOSING TINYINT COMMENT 'Record type: 0=intraday tick (~11000 rows/day), 9=daily closing (1 row/day). For any daily-level analysis, MUST filter WHERE CLOSING = 9.';"
log "列注释更新完成"

# ---- Step 8: 创建索引（忽略已存在的错误） ----
log ""
log "========== Step 8: 创建索引 =========="
run_sql "CREATE INDEX idx_hsi_closing_date ON ms_t_stk_hsi(CLOSING, trade_date);" || true
run_sql "CREATE INDEX idx_sis_stk_date ON ms_t_stk_sis(SISTKC, trade_date);" || true
run_sql "CREATE INDEX idx_cap_date_stk ON ms_v_stock_capital(ref_date, STKCD);" || true
run_sql "CREATE INDEX idx_ind_stk_date ON ds_t_int_hsicl_dtl(STOCK_CODE, MODIFIED_DATE);" || true
run_sql "CREATE INDEX idx_news_date_sec ON sehknews(securitycode, timestamp);" || true
run_sql "CREATE INDEX idx_pl_stk_yr ON profit_loss(stock_code, fin_yr);" || true
run_sql "CREATE INDEX idx_hsi_daily_date ON ms_v_stk_hsi_daily(trade_date);" || true
log "索引创建完成"

# ---- Step 9: 验证 ----
log ""
log "========== Step 9: 数据验证 =========="
run_sql "
SELECT 'ms_t_stk_hsi' AS tbl, COUNT(*) AS cnt FROM ms_t_stk_hsi
UNION ALL SELECT 'ms_v_stk_hsi_daily', COUNT(*) FROM ms_v_stk_hsi_daily
UNION ALL SELECT 'ms_t_stk_sis', COUNT(*) FROM ms_t_stk_sis
UNION ALL SELECT 'ms_v_stock_capital', COUNT(*) FROM ms_v_stock_capital
UNION ALL SELECT 'ds_t_int_hsicl_dtl', COUNT(*) FROM ds_t_int_hsicl_dtl
UNION ALL SELECT 'sehknews', COUNT(*) FROM sehknews
UNION ALL SELECT 'profit_loss', COUNT(*) FROM profit_loss;
"

# 验证关键字段非空
log ""
log "关键字段验证:"
run_sql "SELECT 'trade_date NULL' AS chk, COUNT(*) AS cnt FROM ms_t_stk_sis WHERE trade_date IS NULL UNION ALL SELECT 'ma_50 NULL', COUNT(*) FROM ms_t_stk_sis WHERE ma_50 IS NULL AND SISTKC < '10000' UNION ALL SELECT 'ref_date NULL', COUNT(*) FROM ms_v_stock_capital WHERE ref_date IS NULL;"

# ---- Step 10: 自动更新日期列注释（写入实际数据范围）----
log ""
log "========== Step 10: 更新日期列注释 =========="

update_date_comment() {
  local table="$1" col="$2" base_comment="$3"
  local range
  range=$($MYSQL_CMD "$MO_DB" -N -B -e "SELECT CONCAT(MIN($col), ' to ', MAX($col)) FROM $table WHERE $col IS NOT NULL;" 2>/dev/null)
  if [ -n "$range" ]; then
    local full_comment="${base_comment} Data range: ${range}."
    local coltype
    coltype=$($MYSQL_CMD "$MO_DB" -N -B -e "
      SELECT CONCAT(COLUMN_TYPE, IF(IS_NULLABLE='YES',' NULL',' NOT NULL'))
      FROM information_schema.columns
      WHERE table_schema='$MO_DB' AND table_name='$table' AND column_name='$col';
    " 2>/dev/null | sed 's/DATE(0)/DATE/g')
    run_sql "ALTER TABLE $table MODIFY COLUMN $col $coltype COMMENT '${full_comment}';"
    log "  $table.$col → $range"
  fi
}

update_date_comment "ms_t_stk_hsi" "trade_date" "Trading date (standardized from HSTXDT)."
update_date_comment "ms_t_stk_sis" "trade_date" "Trading date (standardized from SITXDT). Use this column for date filtering, JOIN, and window functions."
update_date_comment "ms_v_stock_capital" "ref_date" "Month-end reference date (standardized from SIRXDT). Use this column for date filtering and comparison."
update_date_comment "ds_t_int_hsicl_dtl" "MODIFIED_DATE" "Effective date of this classification (YYYY-MM-DD)."
update_date_comment "sehknews" "trade_date" "Nearest trading day on or after the news timestamp. Use for JOIN with ms_t_stk_sis."
update_date_comment "profit_loss" "fin_yr" "Fiscal year in YYYYMM format (e.g. 202312 = Dec 2023). Quarter is Final or Interim."
update_date_comment "ccass_holdings" "holding_date" "CCASS shareholding date."

log ""
log "========== 全部导入完成 =========="
