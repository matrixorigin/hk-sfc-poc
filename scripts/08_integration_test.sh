#!/usr/bin/env bash
# HK SFC POC - 集成测试（并发）
# 中英文各 6 个问题 + 前端示例 8 个 = 20 个测试用例
# 分批并发：每批最多 6 个，共 4 批
# 用法: bash scripts/08_integration_test.sh

set -euo pipefail

source /Users/zhangqq/Documents/pythonProject/HK_POC/.env
CATALOG="http://localhost:8084"
COMMON='["ms_t_stk_hsi","ms_v_stk_hsi_daily","ms_t_stk_sis","ms_v_stock_capital","ds_t_int_hsicl_dtl","sehknews","profit_loss","ccass_holdings"]'
WS="$POC_WORKSPACE_ID"
KEY="$MOI_SYSTEM_API_KEY"
OUT=/tmp/poc_integration_test

mkdir -p "$OUT"
rm -f "$OUT"/*.raw

log() { echo "[$(date '+%H:%M:%S')] $*"; }

# 发送请求（后台）
fire() {
  local sid="$1" question="$2"
  echo '{"query":{"question":"'"$question"'"},"session":{"session_id":"'"$sid"'","workspace_id":"'"$WS"'"},"data_sources":{"tables":{"db_name":"hk_sfc","table_list":'"$COMMON"'},"knowledge_bases":[{"knowledge_base_id":10001}]},"options":{"planning_mode":"auto","verbose":"steps","llm":{"model":"qwen3-max"}}}' | \
  curl -N -s -X POST "$CATALOG/api/v1/explore/query/stream" \
    -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
    -d @- > "$OUT/$sid.raw" 2>&1
}

# 检查单个结果
check() {
  local label="$1" sid="$2" expect_keyword="${3:-}"
  local f="$OUT/$sid.raw"

  if [ ! -f "$f" ] || [ ! -s "$f" ]; then
    echo "  ❌ $label — no response file"
    return 1
  fi

  local run_status=$(grep "run.completed" "$f" | python3 -c "
import sys,json
for l in sys.stdin:
  if 'data:' in l:
    d=json.loads(l.split('data: ',1)[1])['data']
    print(d.get('status','unknown'))
" 2>/dev/null | tail -1)

  local answer=$(grep "synthesis.done" "$f" | python3 -c "
import sys,json
for l in sys.stdin:
  if 'data:' in l:
    d=json.loads(l.split('data: ',1)[1])['data']
    for b in d.get('blocks',[]):
      c=b.get('content','')
      if not c: continue
      # dev 版 synthesis 输出 JSON 格式，提取 answer 字段
      c=c.strip()
      if c.startswith('{'):
        try:
          parsed=json.loads(c)
          c=parsed.get('answer',c)
        except: pass
      if c: print(c[:200])
" 2>/dev/null | head -1)

  if [ "$run_status" = "completed" ] && [ -n "$answer" ]; then
    if [ -n "$expect_keyword" ]; then
      if echo "$answer" | grep -qi "$expect_keyword"; then
        echo "  ✅ $label"
        return 0
      else
        echo "  ❌ $label — keyword '$expect_keyword' not found in: ${answer:0:80}"
        return 1
      fi
    else
      echo "  ✅ $label"
      return 0
    fi
  else
    echo "  ❌ $label — status=$run_status answer=${answer:0:80}"
    return 1
  fi
}

# ============================================================
log "========== 环境检查 =========="
# ============================================================

echo -n "  Catalog: "; curl -s http://localhost:8084/health | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])" 2>/dev/null || echo "FAIL"
echo -n "  Backend: "; curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://localhost:8083/api/chat -X OPTIONS 2>/dev/null; echo ""
echo -n "  Frontend: "; curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://localhost:3000 2>/dev/null; echo ""

# ============================================================
log ""
log "========== Batch 1: 英文 Q1-Q6 (并发) =========="
# ============================================================

fire "en-q1" "What was the total trading volume on days when the Hang Seng Index dropped by over 2% between January and June 2025?" &
fire "en-q2" "Which three industries saw the largest aggregate market cap decline between January and June 2025?" &
fire "en-q3" "List stocks that closed above their 50-day moving average for 10 consecutive trading days between January and March 2025." &

log "3 个英文问题 (1/2) 已提交，等待..."
wait

fire "en-q4" "Detect stocks with trading volume more than 3 times the 30-day average volume on the day of material news announcements between January and March 2025. Material news is defined as typeid in (0,3,7,8,10,14,18,21,25,26,28,32)." &
fire "en-q5" "Identify stocks with inter-broker CCASS shareholding movement greater than 30% on 2026-03-18 compared to 2026-03-17." &
fire "en-q6" "Show me the revenue growth of stock 88 from 2023 to 2025." &

log "3 个英文问题 (2/2) 已提交，等待..."
wait
log "Batch 1 完成"

PASS=0; FAIL=0
check "EN-Q1: HSI drop >2% volume" "en-q1" "volume" && PASS=$((PASS+1)) || FAIL=$((FAIL+1))
check "EN-Q2: Top 3 industry decline" "en-q2" "" && PASS=$((PASS+1)) || FAIL=$((FAIL+1))
check "EN-Q3: 50-day MA 10 days" "en-q3" "" && PASS=$((PASS+1)) || FAIL=$((FAIL+1))
check "EN-Q4: Volume 3x news" "en-q4" "" && PASS=$((PASS+1)) || FAIL=$((FAIL+1))
check "EN-Q5: CCASS >30%" "en-q5" "" && PASS=$((PASS+1)) || FAIL=$((FAIL+1))
check "EN-Q6: Revenue growth" "en-q6" "88" && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

# ============================================================
log ""
log "========== Batch 2: 中文 Q1-Q6 (并发) =========="
# ============================================================

fire "cn-q1" "在2025年1月至6月期间，市场指数单日跌幅超过2%的交易日，全市场总成交量是多少？" &
fire "cn-q2" "2025年1月至6月期间，哪三个行业的总市值下降幅度最大？" &
fire "cn-q3" "列出2025年1月至3月期间，收盘价连续10个交易日高于50日移动均线的股票。" &

log "3 个中文问题 (1/2) 已提交，等待..."
wait

fire "cn-q4" "检测2025年1月至3月期间，在重大新闻公告发布当天，成交量超过前30日平均成交量3倍的股票。重大新闻定义为sehknews表中typeid in (0,3,7,8,10,14,18,21,25,26,28,32)的记录。" &
fire "cn-q5" "识别在2026年3月18日相比3月17日，CCASS跨券商持仓变动超过30%的股票。" &
fire "cn-q6" "展示股票88从2023年到2025年的营收增长情况。" &

log "3 个中文问题 (2/2) 已提交，等待..."
wait
log "Batch 2 完成"

check "CN-Q1: 指数跌幅成交量" "cn-q1" "" && PASS=$((PASS+1)) || FAIL=$((FAIL+1))
check "CN-Q2: 行业市值下降" "cn-q2" "" && PASS=$((PASS+1)) || FAIL=$((FAIL+1))
check "CN-Q3: 50日均线" "cn-q3" "" && PASS=$((PASS+1)) || FAIL=$((FAIL+1))
check "CN-Q4: 新闻成交量异常" "cn-q4" "" && PASS=$((PASS+1)) || FAIL=$((FAIL+1))
check "CN-Q5: CCASS变动" "cn-q5" "" && PASS=$((PASS+1)) || FAIL=$((FAIL+1))
check "CN-Q6: 营收增长" "cn-q6" "" && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

# ============================================================
log ""
log "========== Batch 3: 前端示例-英文 (并发) =========="
# ============================================================

fire "fe-en-1" "In April 2025, which top 20 stocks had the highest volume when HSI dropped over 2%?" &
fire "fe-en-2" "Which 3 industries saw the largest market cap decline in H1 2025?" &
fire "fe-en-3" "List stocks above 50-day moving average for 10 consecutive days in Q1 2025" &
fire "fe-en-4" "Show revenue growth of stock 88 from 2023 to 2025" &

log "4 个前端英文示例已提交，等待..."
wait
log "Batch 3 完成"

check "FE-EN-1: HSI volume" "fe-en-1" "" && PASS=$((PASS+1)) || FAIL=$((FAIL+1))
check "FE-EN-2: Industry decline" "fe-en-2" "" && PASS=$((PASS+1)) || FAIL=$((FAIL+1))
check "FE-EN-3: 50-day MA" "fe-en-3" "" && PASS=$((PASS+1)) || FAIL=$((FAIL+1))
check "FE-EN-4: Revenue" "fe-en-4" "" && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

# ============================================================
log ""
log "========== Batch 4: 前端示例-中文 (并发) =========="
# ============================================================

fire "fe-cn-1" "2025年4月恒指跌幅超过2%时，成交量最大的20只股票是哪些？" &
fire "fe-cn-2" "2025年上半年哪三个行业的总市值下降幅度最大？" &
fire "fe-cn-3" "2025年一季度有哪些股票连续10天收盘价高于50日均线？" &
fire "fe-cn-4" "股票88从2023年到2025年的营收增长情况" &

log "4 个前端中文示例已提交，等待..."
wait
log "Batch 4 完成"

check "FE-CN-1: 恒指成交量" "fe-cn-1" "" && PASS=$((PASS+1)) || FAIL=$((FAIL+1))
check "FE-CN-2: 行业下降" "fe-cn-2" "" && PASS=$((PASS+1)) || FAIL=$((FAIL+1))
check "FE-CN-3: 均线" "fe-cn-3" "" && PASS=$((PASS+1)) || FAIL=$((FAIL+1))
check "FE-CN-4: 营收" "fe-cn-4" "" && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

# ============================================================
log ""
log "=========================================="
log "测试结果: $PASS/20 通过, $FAIL 失败"
log "=========================================="

# MO 状态
docker stats hk-poc-mo --no-stream --format "MO: CPU={{.CPUPerc}} MEM={{.MemUsage}}" 2>/dev/null

if [ "$FAIL" -gt 0 ]; then
  log "失败详情: $OUT/*.raw"
  exit 1
fi
