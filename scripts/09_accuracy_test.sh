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
FILTER=""

while getopts "c:t:" opt; do
  case $opt in
    c) CONCURRENCY="$OPTARG" ;;
    t) FILTER="$OPTARG" ;;
    *) echo "用法: $0 [-c concurrency] [-t case_id]"; exit 1 ;;
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
# 验证：按 checks 规则验证 LLM 结果
#   assert_case <label> <sid> <ground_truth_sql> <checks>
#   checks 格式（分号分隔）：
#     rows=N        精确行数
#     rows~N        行数 ±20%
#     contains=a,b  结果必须包含这些值
#     excludes=a,b  结果不能包含这些值
# ============================================================
assert_case() {
  local label="$1" sid="$2" gt_sql="$3" checks="${4:-}"

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

  # 提取 LLM SQL 并直接在 MO 执行
  local llm_sql
  llm_sql=$(python3 -c "import json;print(json.load(open('$f')).get('sql',''))" 2>/dev/null)
  if [ -z "$llm_sql" ]; then
    echo "  ❌ $label — no SQL in result"
    return 1
  fi

  # 直接执行 SQL，数输出行数（不包装子查询，避免分号/CTE 等兼容问题）
  local llm_full gt_full
  llm_full=$($MYSQL_CMD -e "$llm_sql" 2>/dev/null)
  gt_full=$($MYSQL_CMD -e "$gt_sql" 2>/dev/null)
  local llm_count gt_count
  llm_count=$(echo "$llm_full" | tail -n +2 | grep -c .)  # 跳过 header 行
  gt_count=$(echo "$gt_full" | tail -n +2 | grep -c .)

  # 默认无 checks 时：行数 ±20%
  if [ -z "$checks" ] || [ "$checks" = "-" ]; then
    checks="rows~$gt_count"
  fi

  local details="gt=$gt_count llm=$llm_count"
  local IFS=';'
  for check in $checks; do
    check=$(echo "$check" | xargs)  # trim

    # rows=N  精确行数
    if [[ "$check" == rows=* ]]; then
      local expected="${check#rows=}"
      if [ "$llm_count" != "$expected" ]; then
        echo "  ❌ $label — rows=$llm_count, expected=$expected ($details)"
        return 1
      fi

    # rows~N  行数 ±20%
    elif [[ "$check" == rows~* ]]; then
      local expected="${check#rows\~}"
      local lo hi
      lo=$(python3 -c "print(int($expected * 0.8))" 2>/dev/null)
      hi=$(python3 -c "print(int($expected * 1.2))" 2>/dev/null)
      # gt=0 时 LLM 也应为 0
      if [ "$expected" = "0" ]; then
        if [ "$llm_count" != "0" ]; then
          echo "  ❌ $label — gt=0 but llm=$llm_count rows"
          return 1
        fi
      elif [ "$llm_count" -lt "$lo" ] 2>/dev/null || [ "$llm_count" -gt "$hi" ] 2>/dev/null; then
        echo "  ❌ $label — rows=$llm_count, expected=$lo~$hi ($details)"
        return 1
      fi

    # contains=a,b  必须包含
    elif [[ "$check" == contains=* ]]; then
      local vals="${check#contains=}"
      local IFS=','
      for val in $vals; do
        if ! echo "$llm_full" | grep -q "$val"; then
          echo "  ❌ $label — missing expected value '$val' ($details)"
          return 1
        fi
      done

    # excludes=a,b  不能包含
    elif [[ "$check" == excludes=* ]]; then
      local vals="${check#excludes=}"
      local IFS=','
      for val in $vals; do
        if echo "$llm_full" | grep -q "$val"; then
          echo "  ❌ $label — unexpected value '$val' ($details)"
          return 1
        fi
      done
    fi
  done

  echo "  ✅ $label — $details"
  return 0
}

PASS=0; FAIL=0; SKIP=0; TOTAL=0

# ============================================================
log "========== 环境检查 =========="
# ============================================================
echo -n "  Catalog: "; curl -s "$CATALOG_URL/health" 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin)['status'])" 2>/dev/null || echo "FAIL"
echo -n "  DB: "; $MYSQL_CMD -e "SELECT 'ok'" 2>/dev/null | tail -1 || echo "FAIL"
echo "  并发: $CONCURRENCY"

# ============================================================
# 用例定义：sid \t label \t question \t ground_truth_sql \t checks
# checks 格式（分号分隔）：rows=N | rows~N | contains=a,b | excludes=a,b
# 无 checks 时默认 rows~{gt_count}（行数 ±20%）
# ============================================================
CASES=$(cat << 'CASES_EOF'
v1	V1: HSI跌幅>2%成交量	在2026年市场指数日跌幅超过2%的交易日，全市场总成交量是多少？	SELECT SUM(s.SIVOL) AS total_vol FROM ms_v_stk_hsi_daily h JOIN ms_t_stk_sis s ON h.trade_date = s.trade_date WHERE h.hsi_pct_change < -2 AND h.trade_date >= '2026-01-01' AND h.trade_date <= '2026-12-31'	rows=1
v3	V3: MA3连续3天(code<100)	2026年中，对于股票代码是数字且小于100，列出收盘价连续3个交易日高于3日移动均线的股票	SELECT DISTINCT SISTKC, SISTKN FROM ms_t_stk_sis WHERE trade_date >= '2026-01-01' AND trade_date <= '2026-12-31' AND SISTKC < '00100' AND SISTKC >= '00001' AND consecutive_above_ma3 >= 3	excludes=00046
v4	V4: 新闻放量3倍	在2025年1月1日到2025年4月30日期间，在重大新闻公告发布前，成交量超过30日平均值3倍的股票，应将第T日排除在平均值计算之外，如果新闻是在非交易日发布使用下一个交易日的交易量进行比较。仅当typeid in (0,3,7,8,10,14,18,21,25,26,28,32)时认为是重大新闻公告。如果一只股票在一天发布多条重大新闻公告则认为当天仅发布一次。列出所有满足条件的公告发布日期、股票代码、股票名称。	SELECT n.trade_date, n.securitycode, s.SISTKN FROM (SELECT securitycode, trade_date FROM sehknews WHERE typeid IN (0,3,7,8,10,14,18,21,25,26,28,32) AND timestamp >= '2025-01-01' AND timestamp < '2025-05-01' GROUP BY securitycode, trade_date) n JOIN ms_t_stk_sis s ON n.securitycode = s.SISTKC AND n.trade_date = s.trade_date WHERE s.avg_vol_30d > 0 AND s.SIVOL > s.avg_vol_30d * 3
v6	V6: 营收同期对比(简体)	"３６０鲁大师控股有限公司"从2023到2025年的营收增长情况	SELECT a.fin_yr, a.quarter, a.turnover, b.turnover AS prev_turnover FROM profit_loss a JOIN profit_loss b ON a.stock_code = b.stock_code AND a.quarter = b.quarter AND CAST(SUBSTRING(a.fin_yr,1,4) AS UNSIGNED) = CAST(SUBSTRING(b.fin_yr,1,4) AS UNSIGNED) + 1 AND SUBSTRING(a.fin_yr,5,2) = SUBSTRING(b.fin_yr,5,2) WHERE a.company_name_sc LIKE '%鲁大师%' AND a.fin_yr >= '202301'	rows=5;contains=鲁大师
v6tc	V6: 营收同期对比(繁体)	"３６０魯大師控股有限公司"從2023年到2025年的營收增長情況	SELECT a.fin_yr, a.quarter, a.turnover, b.turnover AS prev_turnover FROM profit_loss a JOIN profit_loss b ON a.stock_code = b.stock_code AND a.quarter = b.quarter AND CAST(SUBSTRING(a.fin_yr,1,4) AS UNSIGNED) = CAST(SUBSTRING(b.fin_yr,1,4) AS UNSIGNED) + 1 AND SUBSTRING(a.fin_yr,5,2) = SUBSTRING(b.fin_yr,5,2) WHERE a.company_name_tc LIKE '%魯大師%' AND a.fin_yr >= '202301'	rows=5;contains=魯大師
v6en	V6: 营收同期对比(English)	360 LUDASHI HOLDINGS LIMITED revenue growth from 2023 to 2025	SELECT a.fin_yr, a.quarter, a.turnover, b.turnover AS prev_turnover FROM profit_loss a JOIN profit_loss b ON a.stock_code = b.stock_code AND a.quarter = b.quarter AND CAST(SUBSTRING(a.fin_yr,1,4) AS UNSIGNED) = CAST(SUBSTRING(b.fin_yr,1,4) AS UNSIGNED) + 1 AND SUBSTRING(a.fin_yr,5,2) = SUBSTRING(b.fin_yr,5,2) WHERE a.company_name_en LIKE '%LUDASHI%' AND a.fin_yr >= '202301'	rows=5;contains=LUDASHI
b1	B1: HSI跌幅+TOP20	2025年4月恒指跌幅超过2%时，成交量最大的20只股票是哪些？	SELECT s.SISTKC, s.SISTKN, s.SIVOL FROM ms_t_stk_sis s WHERE s.trade_date IN (SELECT trade_date FROM ms_v_stk_hsi_daily WHERE hsi_pct_change < -2 AND trade_date >= '2025-04-01' AND trade_date <= '2025-04-30') ORDER BY s.SIVOL DESC LIMIT 20	rows=20
b4	B4: Q1新闻放量	检测2025年1月至3月期间，在重大新闻公告发布当天，成交量超过前30日平均成交量3倍的股票。重大新闻定义为sehknews表中typeid in (0,3,7,8,10,14,18,21,25,26,28,32)的记录。	SELECT n.trade_date, n.securitycode, s.SISTKN FROM (SELECT securitycode, trade_date FROM sehknews WHERE typeid IN (0,3,7,8,10,14,18,21,25,26,28,32) AND timestamp >= '2025-01-01' AND timestamp < '2025-04-01' GROUP BY securitycode, trade_date) n JOIN ms_t_stk_sis s ON n.securitycode = s.SISTKC AND n.trade_date = s.trade_date WHERE s.avg_vol_30d > 0 AND s.SIVOL > s.avg_vol_30d * 3
b5	B5: 股票88营收YoY	展示股票88从2023年到2025年的营收增长情况	SELECT a.fin_yr, a.quarter, a.turnover, b.turnover AS prev FROM profit_loss a JOIN profit_loss b ON a.stock_code = b.stock_code AND a.quarter = b.quarter AND CAST(SUBSTRING(a.fin_yr,1,4) AS UNSIGNED) = CAST(SUBSTRING(b.fin_yr,1,4) AS UNSIGNED) + 1 AND SUBSTRING(a.fin_yr,5,2) = SUBSTRING(b.fin_yr,5,2) WHERE a.stock_code = '88' AND a.fin_yr >= '202301'	rows=6
b6	B6: 恒指最大跌幅	2025年恒生指数单日最大跌幅是多少？发生在哪一天？	SELECT trade_date, hsi_pct_change FROM ms_v_stk_hsi_daily WHERE trade_date >= '2025-01-01' AND trade_date <= '2025-12-31' ORDER BY hsi_pct_change ASC LIMIT 1	rows=1
s1	S1: 行业市值增长率	2025年一季度，哪些行业的平均市值增长率最高？	SELECT industry_name, (AVG(CASE WHEN ref_date='2025-03-31' THEN SICAP END) - AVG(CASE WHEN ref_date='2025-01-31' THEN SICAP END)) / AVG(CASE WHEN ref_date='2025-01-31' THEN SICAP END) AS growth FROM ms_v_stock_capital WHERE ref_date IN ('2025-01-31','2025-03-31') AND industry_name IS NOT NULL GROUP BY industry_name HAVING AVG(CASE WHEN ref_date='2025-01-31' THEN SICAP END) IS NOT NULL ORDER BY growth DESC	contains=Information Technology
s2	S2: 2月新闻放量TOP20	2025年2月份有哪些股票在发布重大新闻公告的当天成交量异常放大（超过前30日均量3倍以上）？列出前20条	SELECT n.trade_date, n.securitycode, s.SISTKN FROM (SELECT securitycode, trade_date FROM sehknews WHERE typeid IN (0,3,7,8,10,14,18,21,25,26,28,32) AND timestamp >= '2025-02-01' AND timestamp < '2025-03-01' GROUP BY securitycode, trade_date) n JOIN ms_t_stk_sis s ON n.securitycode = s.SISTKC AND n.trade_date = s.trade_date WHERE s.avg_vol_30d > 0 AND s.SIVOL > s.avg_vol_30d * 3 LIMIT 20
s3	S3: 连续5天>MA20	2025年1月到3月，哪些股票代码小于1000的股票收盘价连续5天高于20日均线？	SELECT DISTINCT SISTKC, SISTKN FROM ms_t_stk_sis WHERE trade_date BETWEEN '2025-01-01' AND '2025-03-31' AND SISTKC < '01000' AND SISTKC >= '00001' AND consecutive_above_ma20 >= 5
s4	S4: 恒指月末+涨跌幅	2025年各月的恒生指数月末收盘值和当月涨跌幅分别是多少？	SELECT trade_date, HSHSI FROM (SELECT trade_date, HSHSI, ROW_NUMBER() OVER (PARTITION BY YEAR(trade_date), MONTH(trade_date) ORDER BY trade_date DESC) AS rn FROM ms_v_stk_hsi_daily WHERE trade_date >= '2025-01-01' AND trade_date <= '2025-12-31') t WHERE rn = 1	rows=12
v2	V2: 行业市值下降	计算各行业2025年11月相对2025年10月总市值下降值，取top3	SELECT industry_name, (oct_total - nov_total) AS decline FROM (SELECT industry_name, SUM(CASE WHEN ref_date='2025-10-31' THEN SICAP ELSE 0 END) AS oct_total, SUM(CASE WHEN ref_date='2025-11-30' THEN SICAP ELSE 0 END) AS nov_total FROM ms_v_stock_capital WHERE ref_date IN ('2025-10-31','2025-11-30') AND industry_name IS NOT NULL GROUP BY industry_name) t WHERE oct_total > nov_total ORDER BY decline DESC LIMIT 3	contains=Consumer Discretionary,Energy
s5	S5: H2行业市值下降TOP3	2025年下半年哪三个行业的总市值下降幅度最大？	SELECT industry_name FROM (SELECT industry_name, SUM(CASE WHEN ref_date = '2025-07-31' THEN SICAP ELSE 0 END) AS market_cap_start, SUM(CASE WHEN ref_date = '2025-12-31' THEN SICAP ELSE 0 END) AS market_cap_end, SUM(CASE WHEN ref_date = '2025-12-31' THEN SICAP ELSE 0 END) - SUM(CASE WHEN ref_date = '2025-07-31' THEN SICAP ELSE 0 END) AS market_cap_change FROM ms_v_stock_capital WHERE ref_date IN ('2025-07-31', '2025-12-31') AND industry_name IS NOT NULL GROUP BY industry_name HAVING SUM(CASE WHEN ref_date = '2025-07-31' THEN SICAP ELSE 0 END) > 0 AND SUM(CASE WHEN ref_date = '2025-12-31' THEN SICAP ELSE 0 END) > 0) t WHERE market_cap_change < 0 ORDER BY market_cap_change ASC LIMIT 3
c3	C3: 连续站上MA50+起止日期	在2025年3月至2026年3月期间，收盘价连续10个交易日高于50日移动均线的股票代码、股票名称、连续高出的交易日总数、以及起止日期范围	SELECT stock_code, stock_name, max_streak, start_date, end_date FROM (SELECT SISTKC AS stock_code, SISTKN AS stock_name, consecutive_above_ma50 AS max_streak, consecutive_above_ma50_start AS start_date, trade_date AS end_date, ROW_NUMBER() OVER (PARTITION BY SISTKC ORDER BY consecutive_above_ma50 DESC, trade_date DESC) AS rn FROM ms_t_stk_sis WHERE consecutive_above_ma50 >= 10 AND trade_date >= '2025-03-01' AND trade_date <= '2026-03-03') t WHERE rn = 1 ORDER BY max_streak DESC
c4	C4: 新闻放量(客户格式)	在2025年1月1日到2025年4月30日期间，在重大新闻公告发布当天，成交量超过30日平均值3倍的股票代码、股票名称、交易日期、当日成交量、前30日平均成交量	SELECT n.trade_date, n.securitycode AS stock_code, s.SISTKN AS stock_name, s.SIVOL AS daily_volume, s.avg_vol_30d FROM (SELECT securitycode, trade_date FROM sehknews WHERE typeid IN (0,3,7,8,10,14,18,21,25,26,28,32) AND timestamp >= '2025-01-01' AND timestamp < '2025-05-01' GROUP BY securitycode, trade_date) n JOIN ms_t_stk_sis s ON n.securitycode = s.SISTKC AND n.trade_date = s.trade_date WHERE s.avg_vol_30d > 0 AND s.SIVOL > s.avg_vol_30d * 3
CASES_EOF
)

# ============================================================
log ""
log "========== 并发发送查询 (concurrency=$CONCURRENCY) =========="
# ============================================================

pids=()
count=0

while IFS=$'\t' read -r sid label question gt_sql checks; do
  [ -z "$sid" ] && continue
  if [ -n "$FILTER" ]; then
    echo ",$FILTER," | grep -q ",$sid," || continue
  fi
  log "  提交: $label"
  fire "$sid" "$question" &
  pids+=($!)
  count=$((count + 1))
  if [ "$count" -ge "$CONCURRENCY" ]; then
    for pid in "${pids[@]+"${pids[@]}"}"; do wait "$pid"; done
    pids=()
    count=0
  fi
done <<< "$CASES"

for pid in "${pids[@]+"${pids[@]}"}"; do wait "$pid"; done
log "全部查询完成"

# ============================================================
log ""
log "========== 验证结果 (fail-fast) =========="
# ============================================================

check_or_die() {
  local label="$1" sid="$2" gt_sql="$3" checks="${4:-}"
  extract_result "$sid"
  TOTAL=$((TOTAL + 1))

  if assert_case "$label" "$sid" "$gt_sql" "$checks"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    log "❌ 测试失败，终止执行。详情: $OUT/"
    log "准确性测试: $PASS 通过 / $FAIL 失败 / $SKIP 跳过 (共 $TOTAL)"
    exit 1
  fi
}

while IFS=$'\t' read -r sid label question gt_sql checks; do
  [ -z "$sid" ] && continue
  if [ -n "$FILTER" ]; then
    echo ",$FILTER," | grep -q ",$sid," || continue
  fi
  check_or_die "$label" "$sid" "$gt_sql" "$checks"
done <<< "$CASES"

# V5: CCASS — 数据可能不存在
if [ -z "$FILTER" ] || [ "$FILTER" = "v5" ]; then
TOTAL=$((TOTAL + 1))
HAS_CCASS=$($MYSQL_CMD -e "SELECT COUNT(*) FROM ccass_holdings" 2>/dev/null | tail -1 || echo "0")
if [ "${HAS_CCASS:-0}" -gt 0 ]; then
  log "  [v5] V5: CCASS 持仓变动..."
  fire "v5" "2026年3月27日相比3月26日，CCASS跨券商持仓变动超过30%的股票有哪些？"
  check_or_die "V5: CCASS变动>30%" "v5" "SELECT a.stock_code, a.participant_id, a.shareholding AS shares_day2, b.shareholding AS shares_day1, (a.shareholding - b.shareholding) / b.shareholding AS change_ratio FROM ccass_holdings a JOIN ccass_holdings b ON a.stock_code = b.stock_code AND a.participant_id = b.participant_id WHERE a.holding_date = '2026-03-27' AND b.holding_date = '2026-03-26' AND b.shareholding > 0 AND ABS(a.shareholding - b.shareholding) / b.shareholding > 0.3"
else
  SKIP=$((SKIP + 1))
  echo "  ⏭️  V5: CCASS变动>30% — SKIP: ccass_holdings 无数据"
fi
fi

# ============================================================
log ""
log "=========================================="
log "准确性测试: $PASS 通过 / $FAIL 失败 / $SKIP 跳过 (共 $TOTAL)"
log "=========================================="
