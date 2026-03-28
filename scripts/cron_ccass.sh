#!/usr/bin/env bash
# CCASS 每日自动爬取脚本（配合 cron 使用）
#
# 用法:
#   # 手动执行
#   bash scripts/cron_ccass.sh
#
#   # 配置 cron（每天港股收盘后执行，如晚上 8 点）
#   0 20 * * 1-5 cd /root/data/hk-poc/hk-sfc-poc && bash scripts/cron_ccass.sh >> logs/ccass_cron.log 2>&1
#
# 逻辑: 爬取最近 2 个交易日的数据（今天和昨天），供 Q5 持仓变动分析

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# 计算最近两个工作日（跳过周末）
get_recent_trading_days() {
    local days=()
    local d
    d=$(date +%Y/%m/%d)
    local dow
    dow=$(date +%u)  # 1=Mon, 7=Sun

    # 今天
    if [ "$dow" -le 5 ]; then
        days+=("$d")
    fi

    # 往前找到上一个工作日
    for i in 1 2 3 4; do
        d=$(date -d "-${i} days" +%Y/%m/%d 2>/dev/null || date -v-${i}d +%Y/%m/%d)
        dow=$(date -d "$d" +%u 2>/dev/null || date -j -f "%Y/%m/%d" "$d" +%u)
        if [ "$dow" -le 5 ]; then
            days+=("$d")
            if [ ${#days[@]} -ge 2 ]; then
                break
            fi
        fi
    done

    echo "${days[@]}"
}

DATES=$(get_recent_trading_days)
log "爬取日期: $DATES"

if [ -z "$DATES" ]; then
    log "无法计算交易日，退出"
    exit 1
fi

# 爬取前 200 只股票（平衡速度和覆盖率）
python3 "$SCRIPT_DIR/03_import_ccass.py" --dates $DATES --top 200

log "CCASS 爬取完成"
