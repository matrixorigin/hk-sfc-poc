#!/usr/bin/env bash
# HK SFC POC - 集成测试
# 中英文各 6 个问题 + 前端示例问题验证
# 用法: bash scripts/08_integration_test.sh
#
# 串行执行，避免并发打爆 MO

set -euo pipefail

source /Users/zhangqq/Documents/pythonProject/HK_POC/.env
CATALOG="http://localhost:8084"
COMMON='["ms_t_stk_hsi","ms_t_stk_sis","ms_v_stock_capital","ds_t_int_hsicl_dtl","sehknews","profit_loss","ccass_holdings"]'
WS="$POC_WORKSPACE_ID"
KEY="$MOI_SYSTEM_API_KEY"
OUT=/tmp/poc_integration_test
PASS=0
FAIL=0
TOTAL=0

mkdir -p "$OUT"

log() { echo "[$(date '+%H:%M:%S')] $*"; }

test_question() {
  local label="$1" question="$2" sid="$3" expect_keyword="$4"
  TOTAL=$((TOTAL+1))

  echo '{"query":{"question":"'"$question"'"},"session":{"session_id":"'"$sid"'","workspace_id":"'"$WS"'"},"data_sources":{"tables":{"db_name":"hk_sfc","table_list":'"$COMMON"'},"knowledge_bases":[{"knowledge_base_id":10001}]},"options":{"planning_mode":"auto","verbose":"steps","llm":{"model":"qwen3-max"}}}' | \
  curl -N -s -X POST "$CATALOG/api/v1/explore/query/stream" \
    -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
    -d @- > "$OUT/$sid.raw" 2>&1

  # 检查结果
  local run_status=$(grep "run.completed" "$OUT/$sid.raw" | python3 -c "
import sys,json
for l in sys.stdin:
  if 'data:' in l:
    d=json.loads(l.split('data: ',1)[1])['data']
    print(d.get('status','unknown'))
" 2>/dev/null)

  local has_answer=$(grep -c "synthesis.done" "$OUT/$sid.raw" 2>/dev/null || echo 0)

  local answer=""
  if [ "$has_answer" -gt 0 ]; then
    answer=$(grep "synthesis.done" "$OUT/$sid.raw" | python3 -c "
import sys,json
for l in sys.stdin:
  if 'data:' in l:
    d=json.loads(l.split('data: ',1)[1])['data']
    for b in d.get('blocks',[]):
      c=b.get('content','')
      if c: print(c[:200])
" 2>/dev/null)
  fi

  # 判断是否通过
  local result="FAIL"
  if [ "$run_status" = "completed" ] && [ "$has_answer" -gt 0 ] && [ -n "$answer" ]; then
    if [ -n "$expect_keyword" ]; then
      if echo "$answer" | grep -qi "$expect_keyword"; then
        result="PASS"
      else
        result="FAIL(keyword '$expect_keyword' not found)"
      fi
    else
      result="PASS"
    fi
  fi

  if [[ "$result" == PASS* ]]; then
    PASS=$((PASS+1))
    echo "  ✅ $label"
  else
    FAIL=$((FAIL+1))
    echo "  ❌ $label — status=$run_status answer=${answer:0:80}"
  fi
}

# ============================================================
log "========== 环境检查 =========="
# ============================================================

echo -n "  MO: "; curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://localhost:8084/health 2>/dev/null && echo " OK" || echo " FAIL"
echo -n "  Backend: "; curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://localhost:8083/api/chat -X OPTIONS 2>/dev/null && echo " OK" || echo " FAIL"
echo -n "  Frontend: "; curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://localhost:3000 2>/dev/null && echo " OK" || echo " FAIL"

# ============================================================
log ""
log "========== 英文测试 =========="
# ============================================================

test_question "EN-Q1: HSI drop >2% volume" \
  "What was the total trading volume on days when the Hang Seng Index dropped by over 2% between January and June 2025?" \
  "en-q1" "volume"

test_question "EN-Q2: Top 3 industry market cap decline" \
  "Which three industries saw the largest aggregate market cap decline between January and June 2025?" \
  "en-q2" ""

test_question "EN-Q3: 50-day MA consecutive 10 days" \
  "List stocks that closed above their 50-day moving average for 10 consecutive trading days between January and March 2025." \
  "en-q3" ""

test_question "EN-Q4: Volume 3x before material news" \
  "Detect stocks with trading volume more than 3 times the 30-day average volume on the day of material news announcements between January and March 2025. Material news is defined as typeid in (0,3,7,8,10,14,18,21,25,26,28,32)." \
  "en-q4" ""

test_question "EN-Q5: CCASS movement >30%" \
  "Identify stocks with inter-broker CCASS shareholding movement greater than 30% on 2026-03-18 compared to 2026-03-17." \
  "en-q5" ""

test_question "EN-Q6: Revenue growth" \
  "Show me the revenue growth of stock 88 from 2023 to 2025." \
  "en-q6" "88"

# ============================================================
log ""
log "========== 中文测试 =========="
# ============================================================

test_question "CN-Q1: 指数跌幅>2%成交量" \
  "在2025年1月至6月期间，市场指数单日跌幅超过2%的交易日，全市场总成交量是多少？" \
  "cn-q1" ""

test_question "CN-Q2: 三大行业市值下降" \
  "2025年1月至6月期间，哪三个行业的总市值下降幅度最大？" \
  "cn-q2" ""

test_question "CN-Q3: 50日均线连续10天" \
  "列出2025年1月至3月期间，收盘价连续10个交易日高于50日移动均线的股票。" \
  "cn-q3" ""

test_question "CN-Q4: 新闻前成交量异常" \
  "检测2025年1月至3月期间，在重大新闻公告发布当天，成交量超过前30日平均成交量3倍的股票。重大新闻定义为sehknews表中typeid in (0,3,7,8,10,14,18,21,25,26,28,32)的记录。" \
  "cn-q4" ""

test_question "CN-Q5: CCASS持仓变动>30%" \
  "识别在2026年3月18日相比3月17日，CCASS跨券商持仓变动超过30%的股票。" \
  "cn-q5" ""

test_question "CN-Q6: 营收增长" \
  "展示股票88从2023年到2025年的营收增长情况。" \
  "cn-q6" ""

# ============================================================
log ""
log "========== 前端示例问题（英文） =========="
# ============================================================

test_question "FE-EN-1: HSI drop volume" \
  "What was the total trading volume when HSI dropped over 2%?" \
  "fe-en-1" ""

test_question "FE-EN-2: Industry market cap" \
  "Which 3 industries saw the largest market cap decline?" \
  "fe-en-2" ""

test_question "FE-EN-3: 50-day MA" \
  "List stocks above 50-day moving average for 10 days" \
  "fe-en-3" ""

test_question "FE-EN-4: Revenue growth" \
  "Show revenue growth of stock 88 from 2023 to 2025" \
  "fe-en-4" ""

# ============================================================
log ""
log "========== 前端示例问题（中文） =========="
# ============================================================

test_question "FE-CN-1: 恒指跌幅成交量" \
  "恒生指数单日跌幅超过2%时，全市场总成交量是多少？" \
  "fe-cn-1" ""

test_question "FE-CN-2: 行业市值下降" \
  "哪三个行业的总市值下降幅度最大？" \
  "fe-cn-2" ""

test_question "FE-CN-3: 50日均线" \
  "列出收盘价连续10天高于50日均线的股票" \
  "fe-cn-3" ""

test_question "FE-CN-4: 营收增长" \
  "展示股票88从2023年到2025年的营收增长情况" \
  "fe-cn-4" ""

# ============================================================
log ""
log "=========================================="
log "测试结果: $PASS/$TOTAL 通过, $FAIL 失败"
log "=========================================="

if [ "$FAIL" -gt 0 ]; then
  log ""
  log "失败详情请查看: $OUT/*.raw"
  exit 1
fi
