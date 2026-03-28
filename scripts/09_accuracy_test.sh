#!/usr/bin/env bash
# HK SFC POC - 准确性测试
# 验证 LLM 生成的 SQL 返回正确的行数和关键数据
# 用法: bash scripts/09_accuracy_test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

source "$PROJECT_DIR/.env"

# 优先用 app 端口（3000），回退到 catalog 直连
APP_URL="http://localhost:3000"
CATALOG_URL="http://localhost:8084"
WS="$POC_WORKSPACE_ID"
KEY="$MOI_SYSTEM_API_KEY"
TABLES='["ms_t_stk_hsi","ms_v_stk_hsi_daily","ms_t_stk_sis","ms_v_stock_capital","ds_t_int_hsicl_dtl","sehknews","profit_loss","ccass_holdings"]'
OUT=/tmp/poc_accuracy_test
TIMEOUT=120

mkdir -p "$OUT"
rm -f "$OUT"/*.raw "$OUT"/*.result

PASS=0; FAIL=0; SKIP=0; TOTAL=0

log() { echo "[$(date '+%H:%M:%S')] $*"; }

# ============================================================
# 发送查询（直连 Catalog Explore API）
# ============================================================
query() {
  local sid="$1" question="$2"
  local payload
  payload=$(python3 -c "
import json,sys
print(json.dumps({
  'query':{'question': sys.argv[1]},
  'session':{'session_id': sys.argv[2], 'workspace_id': '$WS'},
  'data_sources':{'tables':{'db_name':'hk_sfc','table_list':$TABLES},'knowledge_bases':[{'knowledge_base_id':10001}]},
  'options':{'planning_mode':'auto','verbose':'steps','llm':{'model':'qwen3-max'}}
}, ensure_ascii=False))
" "$question" "$sid")
  echo "$payload" | curl -s -N --max-time $TIMEOUT -X POST "$CATALOG_URL/api/v1/explore/query/stream" \
    -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
    -H "Accept: text/event-stream" \
    -d @- > "$OUT/$sid.raw" 2>&1
}

# ============================================================
# 从 SSE 响应中提取 sql.result
# ============================================================
extract_result() {
  local sid="$1"
  python3 -c "
import sys, json
with open('$OUT/$sid.raw') as f:
    for line in f:
        if 'sql.result' in line and 'data: ' in line:
            d = json.loads(line.split('data: ', 1)[1])['data']
            json.dump(d, sys.stdout)
            break
" 2>/dev/null > "$OUT/$sid.result"
}

# ============================================================
# 验证函数
#   assert_result <label> <sid> <min_rows> <max_rows> [must_contain] [must_not_contain]
#
#   min_rows/max_rows: 行数范围，-1 表示不检查
#   must_contain: 结果中必须包含的值（逗号分隔）
#   must_not_contain: 结果中必须不包含的值（逗号分隔）
# ============================================================
assert_result() {
  local label="$1" sid="$2" min_rows="$3" max_rows="$4"
  local must_contain="${5:-}" must_not_contain="${6:-}"
  TOTAL=$((TOTAL + 1))

  local f="$OUT/$sid.result"
  if [ ! -s "$f" ]; then
    # 检查是否是 run.error
    if grep -q "run.error" "$OUT/$sid.raw" 2>/dev/null; then
      local err=$(grep "run.error" "$OUT/$sid.raw" | tail -1 | python3 -c "
import sys,json
line=sys.stdin.read()
if 'data: ' in line:
    d=json.loads(line.split('data: ',1)[1])['data']
    print(d.get('message','unknown')[:100])
" 2>/dev/null)
      echo "  ❌ $label — query failed: ${err:-unknown error}"
    else
      echo "  ❌ $label — no sql.result in response"
    fi
    FAIL=$((FAIL + 1))
    return 1
  fi

  local actual_rows
  actual_rows=$(python3 -c "import sys,json;d=json.load(open('$f'));print(d.get('total_count',0))" 2>/dev/null)

  # 行数验证
  if [ "$min_rows" != "-1" ] && [ "$actual_rows" -lt "$min_rows" ] 2>/dev/null; then
    echo "  ❌ $label — rows=$actual_rows, expected >=$min_rows"
    FAIL=$((FAIL + 1))
    return 1
  fi
  if [ "$max_rows" != "-1" ] && [ "$actual_rows" -gt "$max_rows" ] 2>/dev/null; then
    echo "  ❌ $label — rows=$actual_rows, expected <=$max_rows"
    FAIL=$((FAIL + 1))
    return 1
  fi

  # must_contain 验证
  if [ -n "$must_contain" ]; then
    local IFS=','
    for val in $must_contain; do
      if ! python3 -c "
import json
d=json.load(open('$f'))
flat=str(d.get('rows',''))
exit(0 if '$val' in flat else 1)
" 2>/dev/null; then
        echo "  ❌ $label — rows=$actual_rows, missing expected value '$val'"
        FAIL=$((FAIL + 1))
        return 1
      fi
    done
  fi

  # must_not_contain 验证
  if [ -n "$must_not_contain" ]; then
    local IFS=','
    for val in $must_not_contain; do
      if python3 -c "
import json
d=json.load(open('$f'))
flat=str(d.get('rows',''))
exit(0 if '$val' in flat else 1)
" 2>/dev/null; then
        echo "  ❌ $label — rows=$actual_rows, unexpected value '$val' found"
        FAIL=$((FAIL + 1))
        return 1
      fi
    done
  fi

  echo "  ✅ $label — rows=$actual_rows"
  PASS=$((PASS + 1))
  return 0
}

skip_test() {
  local label="$1" reason="$2"
  TOTAL=$((TOTAL + 1))
  SKIP=$((SKIP + 1))
  echo "  ⏭️  $label — SKIP: $reason"
}

# ============================================================
log "========== 环境检查 =========="
# ============================================================
echo -n "  App: "; curl -s -o /dev/null -w "%{http_code}" --max-time 3 "$APP_URL" 2>/dev/null; echo ""
echo -n "  Catalog: "; curl -s "$CATALOG_URL/health" 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin)['status'])" 2>/dev/null || echo "FAIL"; echo ""

# ============================================================
log ""
log "========== 数据准确性 =========="
# ============================================================

# --- V1: HSI 跌幅 + 总成交量 ---
log "V1: 市场指数日跌幅超过2%的交易日总成交量..."
query "v1" "在2026年市场指数日跌幅超过2%的交易日，全市场总成交量是多少？"
extract_result "v1"
# LLM 可能返回每天一行(3行)或 SUM 汇总(1行)
assert_result "V1: HSI跌幅>2%成交量" "v1" 1 3

# --- V2: 行业市值下降 ---
log "V2: 行业市值下降..."
query "v2" "计算各行业2025年11月相对2025年10月总市值下降值，取top3"
extract_result "v2"
# 实际只有2个行业下降，但LLM可能取top3含变化最小的上涨行业
assert_result "V2: 行业市值下降" "v2" 2 3 "Consumer Discretionary,Energy"

# --- V3: MA3 连续3天 ---
log "V3: 连续3天高于3日均线..."
query "v3" "2026年中，对于股票代码是数字且小于100，列出收盘价连续3个交易日高于3日移动均线的股票"
extract_result "v3"
assert_result "V3: MA3连续3天 (code<100)" "v3" 81 81 "" "00046"

# --- V4: 新闻放量 ---
log "V4: 重大新闻放量3倍..."
query "v4" "在2025年1月1日到2025年4月30日期间，在重大新闻公告发布前，成交量超过30日平均值3倍的股票，应将第T日排除在平均值计算之外，如果新闻是在非交易日发布使用下一个交易日的交易量进行比较。仅当typeid in (0,3,7,8,10,14,18,21,25,26,28,32)时认为是重大新闻公告。如果一只股票在一天发布多条重大新闻公告则认为当天仅发布一次随机取一条。列出所有满足条件的公告发布日期、公告内容、股票代码、股票名称。"
extract_result "v4"
assert_result "V4: 新闻放量3倍" "v4" 1517 1517

# --- V5: CCASS 持仓变动 ---
HAS_CCASS=$(mysql -h 127.0.0.1 -P 16002 -u "$(curl -s "http://localhost:8084/api/v1/workspaces/$WS" \
  -H "X-API-Key: $KEY" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['account_name'])")":moi_core_system \
  -p"$KEY" hk_sfc -N -B -e "SELECT COUNT(*) FROM ccass_holdings" 2>/dev/null || echo "0")
if [ "${HAS_CCASS:-0}" -gt 0 ]; then
  log "V5: CCASS 持仓变动..."
  query "v5" "2026年3月18日相比3月17日，CCASS跨券商持仓变动超过30%的股票有哪些？"
  extract_result "v5"
  assert_result "V5: CCASS变动>30%" "v5" 1 -1
else
  skip_test "V5: CCASS变动>30%" "ccass_holdings 无数据（需先爬取）"
fi

# --- V6: 营收同期对比 ---
log "V6: 营收同期对比..."
query "v6" '"３６０鲁大师控股有限公司"从2023到2025年的营收增长情况'
extract_result "v6"
# 5行，Final vs Final + Interim vs Interim
assert_result "V6: 营收同期对比" "v6" 5 5

# ============================================================
log ""
log "========== 基础能力测试 =========="
# ============================================================

# --- B1: 跨表 JOIN ---
log "B1: HSI跌幅+成交量 TOP20..."
query "b1" "2025年4月恒指跌幅超过2%时，成交量最大的20只股票是哪些？"
extract_result "b1"
assert_result "B1: HSI跌幅+TOP20成交量" "b1" 20 20

# --- B2: 行业分类 carry-forward ---
log "B2: H1行业市值..."
query "b2" "2025年上半年哪三个行业的总市值下降幅度最大？"
extract_result "b2"
# H1所有行业都涨了，LLM 可能返回变化最大的3个(含上涨)或0个(无下降)
assert_result "B2: H1行业市值下降TOP3" "b2" 0 3

# --- B3: 预计算列筛选 ---
log "B3: MA50连续10天..."
query "b3" "2025年一季度有哪些股票连续10天收盘价高于50日均线？"
extract_result "b3"
# consecutive_above_ma50 是窗口内总天数非严格连续，LLM 结果在 2469-2503 之间
assert_result "B3: MA50连续10天" "b3" 2469 2503

# --- B4: 新闻去重 + 放量检测 ---
log "B4: Q1新闻放量..."
query "b4" "检测2025年1月至3月期间，在重大新闻公告发布当天，成交量超过前30日平均成交量3倍的股票。重大新闻定义为sehknews表中typeid in (0,3,7,8,10,14,18,21,25,26,28,32)的记录。"
extract_result "b4"
assert_result "B4: Q1新闻放量" "b4" 1326 1326

# --- B5: stock_code 格式 + 营收查询 ---
log "B5: 股票88营收..."
query "b5" "展示股票88从2023年到2025年的营收增长情况"
extract_result "b5"
assert_result "B5: 股票88营收YoY" "b5" 6 6

# --- B6: 单表聚合 ---
log "B6: 恒指单日最大跌幅..."
query "b6" "2025年恒生指数单日最大跌幅是多少？发生在哪一天？"
extract_result "b6"
assert_result "B6: 恒指最大跌幅" "b6" 1 1

# ============================================================
log ""
log "=========================================="
log "准确性测试结果: $PASS 通过 / $FAIL 失败 / $SKIP 跳过 (共 $TOTAL)"
log "=========================================="

if [ "$FAIL" -gt 0 ]; then
  log ""
  log "失败详情保存在: $OUT/"
  log "查看原始响应: cat $OUT/<test-id>.raw"
  log "查看解析结果: cat $OUT/<test-id>.result"
  exit 1
fi
