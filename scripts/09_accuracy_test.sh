#!/usr/bin/env bash
# HK SFC POC - 准确性测试
# 用法: bash scripts/09_accuracy_test.sh [-c concurrency]
#   -c  并发数（默认 1，即串行）

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
source "$PROJECT_DIR/.env"

CATALOG_URL="http://localhost:8084"
WS="$POC_WORKSPACE_ID"
KEY="$MOI_SYSTEM_API_KEY"
TABLES='["ms_t_stk_hsi","ms_v_stk_hsi_daily","ms_t_stk_sis","ms_v_stock_capital","ds_t_int_hsicl_dtl","sehknews","profit_loss","ccass_holdings"]'
OUT=/tmp/poc_accuracy_test
TIMEOUT=180
CONCURRENCY=1

while getopts "c:" opt; do
  case $opt in
    c) CONCURRENCY="$OPTARG" ;;
    *) echo "用法: $0 [-c concurrency]"; exit 1 ;;
  esac
done

# DB 连接
ACCT=$(curl -s "$CATALOG_URL/api/v1/workspaces/$WS" \
  -H "X-API-Key: $KEY" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['account_name'])" 2>/dev/null)
MYSQL_CMD="mysql -h 127.0.0.1 -P 16002 -u ${ACCT}:moi_core_system -p$KEY hk_sfc -N -B"

mkdir -p "$OUT"
rm -f "$OUT"/*.raw "$OUT"/*.result "$OUT"/*.expected

log() { echo "[$(date '+%H:%M:%S')] $*"; }

# ============================================================
# 发送查询（Catalog Explore API）
# ============================================================
fire() {
  local sid="$1" question="$2"
  python3 -c "
import json,sys
print(json.dumps({
  'query':{'question': sys.argv[1]},
  'session':{'session_id': sys.argv[2], 'workspace_id': '$WS'},
  'data_sources':{'tables':{'db_name':'hk_sfc','table_list':$TABLES},'knowledge_bases':[{'knowledge_base_id':10001}]},
  'options':{'planning_mode':'auto','verbose':'steps','llm':{'model':'qwen3-max'}}
}, ensure_ascii=False))
" "$question" "$sid" | \
  curl -s -N --max-time $TIMEOUT -X POST "$CATALOG_URL/api/v1/explore/query/stream" \
    -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
    -H "Accept: text/event-stream" \
    -d @- > "$OUT/$sid.raw" 2>&1
}

# ============================================================
# 提取最后一条 sql.result（而非第一条）
# ============================================================
extract_result() {
  local sid="$1"
  python3 -c "
import json
last = None
with open('$OUT/$sid.raw') as f:
    for line in f:
        if 'sql.result' in line and 'data: ' in line:
            last = json.loads(line.split('data: ', 1)[1])['data']
if last:
    json.dump(last, open('$OUT/$sid.result', 'w'))
" 2>/dev/null
}

# ============================================================
# 跑 ground truth SQL，得到期望行数
# ============================================================
ground_truth_count() {
  local sql="$1"
  $MYSQL_CMD -e "SELECT COUNT(*) FROM ($sql) _gt;" 2>/dev/null | tail -1
}

# ============================================================
# 验证：比对 LLM 结果行数与 ground truth 行数
#   assert_case <label> <sid> <ground_truth_sql> [must_not_contain]
# ============================================================
assert_case() {
  local label="$1" sid="$2" gt_sql="$3" must_not_contain="${4:-}"

  local f="$OUT/$sid.result"
  if [ ! -s "$f" ]; then
    if grep -q "run.error" "$OUT/$sid.raw" 2>/dev/null; then
      local err
      err=$(grep "run.error" "$OUT/$sid.raw" | tail -1 | python3 -c "
import sys,json
line=sys.stdin.read()
if 'data: ' in line:
    d=json.loads(line.split('data: ',1)[1])['data']
    print(d.get('message','unknown')[:120])
" 2>/dev/null)
      echo "  ❌ $label — query failed: ${err:-unknown error}"
    else
      echo "  ❌ $label — no sql.result in response"
    fi
    return 1
  fi

  local actual
  actual=$(python3 -c "import json;print(json.load(open('$f')).get('total_count',0))" 2>/dev/null)

  local expected
  expected=$(ground_truth_count "$gt_sql")
  if [ -z "$expected" ]; then
    echo "  ❌ $label — ground truth SQL failed"
    return 1
  fi

  # 行数比对
  if [ "$actual" != "$expected" ]; then
    echo "  ❌ $label — rows=$actual, expected=$expected"
    return 1
  fi

  # must_not_contain 验证
  if [ -n "$must_not_contain" ]; then
    local IFS=','
    for val in $must_not_contain; do
      if python3 -c "
import json
d=json.load(open('$f'))
rows=d.get('rows') or []
exit(0 if any('$val' in str(cell) for row in rows for cell in row) else 1)
" 2>/dev/null; then
        echo "  ❌ $label — rows=$actual, unexpected value '$val' found"
        return 1
      fi
    done
  fi

  echo "  ✅ $label — rows=$actual (expected=$expected)"
  return 0
}

# ============================================================
# 批量执行 + 并发控制
# ============================================================
PASS=0; FAIL=0; SKIP=0; TOTAL=0

run_case() {
  local sid="$1" label="$2" question="$3" gt_sql="$4" must_not="${5:-}"
  TOTAL=$((TOTAL + 1))
  fire "$sid" "$question"
  extract_result "$sid"
  if assert_case "$label" "$sid" "$gt_sql" "$must_not"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
  fi
}

run_batch() {
  # 从 stdin 读取用例，按 CONCURRENCY 并发执行
  local pids=() count=0

  while IFS=$'\t' read -r sid label question gt_sql must_not; do
    (
      fire "$sid" "$question"
      extract_result "$sid"
    ) &
    pids+=($!)
    count=$((count + 1))

    if [ "$count" -ge "$CONCURRENCY" ]; then
      for pid in "${pids[@]}"; do wait "$pid"; done
      pids=()
      count=0
    fi
  done

  # 等待剩余
  for pid in "${pids[@]}"; do wait "$pid"; done
}

# ============================================================
log "========== 环境检查 =========="
# ============================================================
echo -n "  Catalog: "; curl -s "$CATALOG_URL/health" 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin)['status'])" 2>/dev/null || echo "FAIL"
echo -n "  DB: "; $MYSQL_CMD -e "SELECT 'ok'" 2>/dev/null | tail -1 || echo "FAIL"
echo "  并发: $CONCURRENCY"

# ============================================================
# 用例定义：sid \t label \t question \t ground_truth_sql \t must_not_contain
# ============================================================
CASES=$(cat << 'CASES_EOF'
v1	V1: HSI跌幅>2%成交量	在2026年市场指数日跌幅超过2%的交易日，全市场总成交量是多少？	SELECT SUM(s.SIVOL) AS total_vol FROM ms_v_stk_hsi_daily h JOIN ms_t_stk_sis s ON h.trade_date = s.trade_date WHERE h.hsi_pct_change < -2 AND h.trade_date >= '2026-01-01' AND h.trade_date <= '2026-12-31' AND s.SISTKC < '10000'
v3	V3: MA3连续3天(code<100)	2026年中，对于股票代码是数字且小于100，列出收盘价连续3个交易日高于3日移动均线的股票	SELECT DISTINCT SISTKC, SISTKN FROM ms_t_stk_sis WHERE trade_date >= '2026-01-01' AND trade_date <= '2026-12-31' AND SISTKC < '00100' AND SISTKC >= '00001' AND consecutive_above_ma3 >= 3	00046
v4	V4: 新闻放量3倍	在2025年1月1日到2025年4月30日期间，在重大新闻公告发布前，成交量超过30日平均值3倍的股票，应将第T日排除在平均值计算之外，如果新闻是在非交易日发布使用下一个交易日的交易量进行比较。仅当typeid in (0,3,7,8,10,14,18,21,25,26,28,32)时认为是重大新闻公告。如果一只股票在一天发布多条重大新闻公告则认为当天仅发布一次。列出所有满足条件的公告发布日期、股票代码、股票名称。	SELECT n.trade_date, n.securitycode, s.SISTKN FROM (SELECT securitycode, trade_date FROM sehknews WHERE typeid IN (0,3,7,8,10,14,18,21,25,26,28,32) AND timestamp >= '2025-01-01' AND timestamp < '2025-05-01' GROUP BY securitycode, trade_date) n JOIN ms_t_stk_sis s ON n.securitycode = s.SISTKC AND n.trade_date = s.trade_date WHERE s.SISTKC < '10000' AND s.SIVOL > s.avg_vol_30d * 3
v6	V6: 营收同期对比	"３６０鲁大师控股有限公司"从2023到2025年的营收增长情况	SELECT a.fin_yr, a.quarter, a.turnover, b.turnover AS prev_turnover FROM profit_loss a JOIN profit_loss b ON a.stock_code = b.stock_code AND a.quarter = b.quarter AND CAST(SUBSTRING(a.fin_yr,1,4) AS UNSIGNED) = CAST(SUBSTRING(b.fin_yr,1,4) AS UNSIGNED) + 1 AND SUBSTRING(a.fin_yr,5,2) = SUBSTRING(b.fin_yr,5,2) WHERE a.company_name_sc LIKE '%鲁大师%' AND a.fin_yr >= '202301'
b1	B1: HSI跌幅+TOP20	2025年4月恒指跌幅超过2%时，成交量最大的20只股票是哪些？	SELECT s.SISTKC, s.SISTKN, s.SIVOL FROM ms_t_stk_sis s WHERE s.trade_date IN (SELECT trade_date FROM ms_v_stk_hsi_daily WHERE hsi_pct_change < -2 AND trade_date >= '2025-04-01' AND trade_date <= '2025-04-30') AND s.SISTKC < '10000' ORDER BY s.SIVOL DESC LIMIT 20
b4	B4: Q1新闻放量	检测2025年1月至3月期间，在重大新闻公告发布当天，成交量超过前30日平均成交量3倍的股票。重大新闻定义为sehknews表中typeid in (0,3,7,8,10,14,18,21,25,26,28,32)的记录。	SELECT n.trade_date, n.securitycode, s.SISTKN FROM (SELECT securitycode, trade_date FROM sehknews WHERE typeid IN (0,3,7,8,10,14,18,21,25,26,28,32) AND timestamp >= '2025-01-01' AND timestamp < '2025-04-01' GROUP BY securitycode, trade_date) n JOIN ms_t_stk_sis s ON n.securitycode = s.SISTKC AND n.trade_date = s.trade_date WHERE s.SISTKC < '10000' AND s.SIVOL > s.avg_vol_30d * 3
b5	B5: 股票88营收YoY	展示股票88从2023年到2025年的营收增长情况	SELECT a.fin_yr, a.quarter, a.turnover, b.turnover AS prev FROM profit_loss a JOIN profit_loss b ON a.stock_code = b.stock_code AND a.quarter = b.quarter AND CAST(SUBSTRING(a.fin_yr,1,4) AS UNSIGNED) = CAST(SUBSTRING(b.fin_yr,1,4) AS UNSIGNED) + 1 AND SUBSTRING(a.fin_yr,5,2) = SUBSTRING(b.fin_yr,5,2) WHERE a.stock_code = '88' AND a.fin_yr >= '202301'
b6	B6: 恒指最大跌幅	2025年恒生指数单日最大跌幅是多少？发生在哪一天？	SELECT trade_date, hsi_pct_change FROM ms_v_stk_hsi_daily WHERE trade_date >= '2025-01-01' AND trade_date <= '2025-12-31' ORDER BY hsi_pct_change ASC LIMIT 1
CASES_EOF
)

# V2: 行业市值下降 — 使用预计算的 industry_name
V2_GT="SELECT oct.industry_name, (oct.cap - nov.cap) AS decline FROM (SELECT industry_name, SUM(SICAP) AS cap FROM ms_v_stock_capital WHERE ref_date = '2025-10-31' AND industry_name IS NOT NULL GROUP BY industry_name) oct JOIN (SELECT industry_name, SUM(SICAP) AS cap FROM ms_v_stock_capital WHERE ref_date = '2025-11-30' AND industry_name IS NOT NULL GROUP BY industry_name) nov ON oct.industry_name = nov.industry_name WHERE oct.cap > nov.cap ORDER BY decline DESC LIMIT 3"

# ============================================================
log ""
log "========== 发送查询 (concurrency=$CONCURRENCY) =========="
# ============================================================

# 先并发发送所有查询
pids=()
count=0

while IFS=$'\t' read -r sid label question gt_sql must_not; do
  [ -z "$sid" ] && continue
  log "  提交: $label"
  fire "$sid" "$question" &
  pids+=($!)
  count=$((count + 1))
  if [ "$count" -ge "$CONCURRENCY" ]; then
    for pid in "${pids[@]}"; do wait "$pid"; done
    pids=()
    count=0
  fi
done <<< "$CASES"

# V2 单独提交
log "  提交: V2: 行业市值下降"
fire "v2" "计算各行业2025年11月相对2025年10月总市值下降值，取top3" &
pids+=($!)

for pid in "${pids[@]}"; do wait "$pid"; done
log "全部查询完成"

# ============================================================
log ""
log "========== 验证结果 =========="
# ============================================================

while IFS=$'\t' read -r sid label question gt_sql must_not; do
  [ -z "$sid" ] && continue
  extract_result "$sid"
  TOTAL=$((TOTAL + 1))
  if assert_case "$label" "$sid" "$gt_sql" "$must_not"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
  fi
done <<< "$CASES"

# V2: 特殊处理 — LLM 可能返回 2 或 3 行（只有2个行业真正下降，但 top3 可能含最小上涨）
extract_result "v2"
TOTAL=$((TOTAL + 1))
v2_actual=$(python3 -c "import json;print(json.load(open('$OUT/v2.result')).get('total_count',0))" 2>/dev/null || echo "0")
v2_expected=$(ground_truth_count "$V2_GT")
if [ "$v2_actual" -ge 2 ] 2>/dev/null && [ "$v2_actual" -le "${v2_expected:-3}" ] 2>/dev/null; then
  echo "  ✅ V2: 行业市值下降 — rows=$v2_actual (ground_truth=$v2_expected)"
  PASS=$((PASS + 1))
else
  echo "  ❌ V2: 行业市值下降 — rows=$v2_actual, expected 2~$v2_expected"
  FAIL=$((FAIL + 1))
fi

# V5: CCASS — 数据可能不存在
TOTAL=$((TOTAL + 1))
HAS_CCASS=$($MYSQL_CMD -e "SELECT COUNT(*) FROM ccass_holdings" 2>/dev/null | tail -1 || echo "0")
if [ "${HAS_CCASS:-0}" -gt 0 ]; then
  log "V5: CCASS 持仓变动..."
  fire "v5" "2026年3月18日相比3月17日，CCASS跨券商持仓变动超过30%的股票有哪些？"
  extract_result "v5"
  V5_GT="SELECT DISTINCT a.stock_code FROM ccass_holdings a JOIN ccass_holdings b ON a.stock_code = b.stock_code AND a.participant_id = b.participant_id WHERE a.holding_date = '2026-03-18' AND b.holding_date = '2026-03-17' AND b.shareholding > 0 AND ABS(a.shareholding - b.shareholding) / b.shareholding > 0.3"
  if assert_case "V5: CCASS变动>30%" "v5" "$V5_GT"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
  fi
else
  SKIP=$((SKIP + 1))
  echo "  ⏭️  V5: CCASS变动>30% — SKIP: ccass_holdings 无数据"
fi

# ============================================================
log ""
log "=========================================="
log "准确性测试: $PASS 通过 / $FAIL 失败 / $SKIP 跳过 (共 $TOTAL)"
log "=========================================="

if [ "$FAIL" -gt 0 ]; then
  log "失败详情: $OUT/"
  exit 1
fi
