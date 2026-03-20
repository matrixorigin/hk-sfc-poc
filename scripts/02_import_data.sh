#!/usr/bin/env bash
# HK SFC POC - 数据导入脚本
# 用法: ./scripts/02_import_data.sh
#
# 依赖: mysql client, python3

set -euo pipefail

# ---- 配置 ----
MO_HOST="${MO_HOST:-127.0.0.1}"
MO_PORT="${MO_PORT:-16001}"
MO_USER="${MO_USER:-dump}"
MO_PASS="${MO_PASS:-111}"
MO_DB="hk_sfc"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DATA_DIR="$PROJECT_DIR/POC DATA_01/数据"

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
xml_files = sorted([f for f in os.listdir(xml_dir) if f.endswith('.xml')])
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
                """清洗数值：去除非法值如 '--', 'N/A' 等"""
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

# ---- Step 4: 验证 ----
log ""
log "========== Step 4: 数据验证 =========="
run_sql "
SELECT 'ms_t_stk_hsi' AS tbl, COUNT(*) AS cnt FROM ms_t_stk_hsi
UNION ALL SELECT 'ms_t_stk_sis', COUNT(*) FROM ms_t_stk_sis
UNION ALL SELECT 'ms_v_stock_capital', COUNT(*) FROM ms_v_stock_capital
UNION ALL SELECT 'ds_t_int_hsicl_dtl', COUNT(*) FROM ds_t_int_hsicl_dtl
UNION ALL SELECT 'sehknews', COUNT(*) FROM sehknews
UNION ALL SELECT 'profit_loss', COUNT(*) FROM profit_loss;
"

log ""
log "========== 全部导入完成 =========="
