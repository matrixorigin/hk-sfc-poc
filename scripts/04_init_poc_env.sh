#!/usr/bin/env bash
# HK SFC POC - 一键初始化独立 moi-core 环境
# 用法: bash scripts/04_init_poc_env.sh
#
# 独立 MO (16002) + Catalog (8082) + Workers
#
# 前置条件:
#   - moi-core 镜像已构建: cd ../matrixflow/moi-core && make build-images-demo
#   - moi-cli 已编译: cd ../matrixflow/moi-core && make build-cli

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
MOI_CORE_DIR="${MOI_CORE_DIR:-$(dirname "$(dirname "$SCRIPT_DIR")")/matrixflow/moi-core}"

MO_HOST="127.0.0.1"
MO_PORT="16002"
MO_USER="dump"
MO_PASS="111"
CATALOG_PORT="8084"
CATALOG_URL="http://localhost:$CATALOG_PORT"

MYSQL_CMD="mysql -h $MO_HOST -P $MO_PORT -u $MO_USER -p$MO_PASS"
MOI_CLI="$MOI_CORE_DIR/dist/bin/moi-cli"
SCHEMA_DIR="$SCRIPT_DIR/schema"
ENV_FILE="$PROJECT_DIR/.env"

log() { echo "[$(date '+%H:%M:%S')] $*"; }

# 检查 DASHSCOPE_API_KEY
DASHSCOPE_API_KEY="${DASHSCOPE_API_KEY:-}"
if [ -z "$DASHSCOPE_API_KEY" ]; then
    echo -n "请输入 DashScope API Key: "
    read -r DASHSCOPE_API_KEY
    if [ -z "$DASHSCOPE_API_KEY" ]; then
        log "ERROR: DASHSCOPE_API_KEY 不能为空"
        exit 1
    fi
fi

# ============================================================
# Step 1: 检查前置条件
# ============================================================
log "========== Step 1: 启动容器并检查前置条件 =========="

if [ ! -f "$MOI_CLI" ]; then
    log "ERROR: moi-cli 不存在: $MOI_CLI"
    log "请先执行: cd $MOI_CORE_DIR && make build-cli"
    exit 1
fi
log "moi-cli 可用"

if ! docker image inspect matrixflow/moi-catalog:poc-fix &>/dev/null; then
    log "WARNING: moi-catalog:poc-fix 镜像不存在, 检查 latest..."
    if ! docker image inspect matrixflow/moi-catalog:latest &>/dev/null; then
        log "ERROR: moi-catalog 镜像不存在"
        exit 1
    fi
fi
log "Docker 镜像可用"

# 先启动 MO 容器
cd "$PROJECT_DIR"
docker compose up -d 2>/dev/null || docker-compose up -d mo
log "等待 MatrixOne 就绪..."
for i in $(seq 1 60); do
    if $MYSQL_CMD -e "SELECT 1" &>/dev/null; then
        log "MatrixOne 就绪"
        break
    fi
    if [ "$i" -eq 60 ]; then
        log "ERROR: MatrixOne 启动超时"
        exit 1
    fi
    sleep 3
done

# ============================================================
# Step 2: 初始化 moi_poc 系统库（独立于现有 moi 库）
# ============================================================
log ""
log "========== Step 2: 初始化 moi_poc 系统库 =========="

if $MYSQL_CMD -N -e "SELECT 1 FROM information_schema.tables WHERE table_schema='moi_poc' AND table_name='users' LIMIT 1" 2>/dev/null | grep -q 1; then
    log "moi_poc 库已初始化，跳过"
else
    log "创建并初始化 moi_poc 库..."
    $MYSQL_CMD -e "CREATE DATABASE IF NOT EXISTS moi_poc;" 2>&1 | { grep -v "Warning.*password" || true; }
    $MYSQL_CMD moi_poc < "$SCHEMA_DIR/system_init.sql" 2>&1 | { grep -v "Warning.*password" || true; }
    $MYSQL_CMD moi_poc < "$SCHEMA_DIR/tenant_init.sql" 2>&1 | { grep -v "Warning.*password" || true; }
    log "moi_poc 库初始化完成"
fi

# ============================================================
# Step 3: 生成 API Key
# ============================================================
log ""
log "========== Step 3: 生成 API Key =========="

if [ -f "$ENV_FILE" ] && grep -q 'MOI_SYSTEM_API_KEY=.' "$ENV_FILE" 2>/dev/null; then
    log "已有 .env，跳过"
    API_KEY=$(grep 'MOI_SYSTEM_API_KEY=' "$ENV_FILE" | cut -d= -f2)
else
    log "生成 System API Key..."
    API_KEY=$("$MOI_CLI" apikey generate 2>/dev/null)
    echo "MOI_SYSTEM_API_KEY=$API_KEY" > "$ENV_FILE"
    log "API Key 已写入 .env"
fi

log "API_KEY: ${API_KEY:0:20}..."

# ============================================================
# Step 4: 启动 Catalog + Workers
# ============================================================
log ""
log "========== Step 4: 启动 Catalog + Workers =========="
cd "$PROJECT_DIR"
docker compose up -d 2>/dev/null || docker-compose up -d catalog go-worker python-worker
log "等待 Catalog 就绪..."

for i in $(seq 1 30); do
    if curl -s "$CATALOG_URL/health" 2>/dev/null | grep -q "healthy"; then
        log "Catalog 就绪"
        break
    fi
    if [ "$i" -eq 30 ]; then
        log "ERROR: Catalog 启动超时"
        docker compose logs catalog 2>&1 | tail -20
        exit 1
    fi
    sleep 2
done

# ============================================================
# Step 5: 创建 Workspace
# ============================================================
log ""
log "========== Step 5: 创建 POC Workspace =========="

WS_RESP=$(curl -s -X POST "$CATALOG_URL/api/v1/workspaces" \
    -H "X-API-Key: $API_KEY" \
    -H "Content-Type: application/json" \
    -d '{"name":"hk-sfc-poc","description":"Hong Kong SFC POC - AI Data Exploration"}')

WS_ID=$(echo "$WS_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('id',''))" 2>/dev/null || true)

if [ -z "$WS_ID" ]; then
    log "Workspace 可能已存在，尝试查找..."
    WS_ID=$(curl -s "$CATALOG_URL/api/v1/workspaces" -H "X-API-Key: $API_KEY" | \
        python3 -c "
import sys, json
ws_list = json.load(sys.stdin).get('data',{}).get('workspaces',[])
for ws in ws_list:
    if ws.get('name') == 'hk-sfc-poc':
        print(ws['id'])
        break
" 2>/dev/null || true)
fi

if [ -z "$WS_ID" ]; then
    log "ERROR: 无法创建或找到 workspace"
    echo "$WS_RESP"
    exit 1
fi

log "Workspace ID: $WS_ID"

# 保存到 .env
grep -q "POC_WORKSPACE_ID=" "$ENV_FILE" 2>/dev/null && \
    sed -i '' "s/POC_WORKSPACE_ID=.*/POC_WORKSPACE_ID=$WS_ID/" "$ENV_FILE" || \
    echo "POC_WORKSPACE_ID=$WS_ID" >> "$ENV_FILE"

# ============================================================
# Step 6: 配置 LLM Backend（qwen3-max）
# ============================================================
log ""
log "========== Step 6: 配置 LLM Backend =========="

BACKEND_COUNT=$(curl -s "$CATALOG_URL/api/v1/workspaces/$WS_ID/llm/backends" \
    -H "X-API-Key: $API_KEY" | \
    python3 -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('total',0))" 2>/dev/null || echo "0")

if [ "$BACKEND_COUNT" -gt 0 ]; then
    log "LLM Backend 已配置，跳过"
else
    log "创建 LLM Backend (qwen3-max)..."

    BACKEND_RESP=$(curl -s -X POST "$CATALOG_URL/api/v1/workspaces/$WS_ID/llm/backends" \
        -H "X-API-Key: $API_KEY" \
        -H "Content-Type: application/json" \
        -d '{
            "name": "qwen-openai-compatible",
            "type": 0,
            "api_key_encrypted": "'${DASHSCOPE_API_KEY}'",
            "timeout_seconds": 120,
            "models": ["qwen3-max"]
        }')

    BACKEND_ID=$(echo "$BACKEND_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('id',''))" 2>/dev/null || true)

    if [ -n "$BACKEND_ID" ]; then
        log "Backend ID: $BACKEND_ID"

        curl -s -X POST "$CATALOG_URL/api/v1/workspaces/$WS_ID/llm/backends/$BACKEND_ID/endpoints" \
            -H "X-API-Key: $API_KEY" \
            -H "Content-Type: application/json" \
            -d '{"address": "https://dashscope.aliyuncs.com/compatible-mode/v1"}' > /dev/null

        log "LLM Endpoint 已配置 (dashscope)"
    else
        log "WARNING: 创建 LLM Backend 失败"
        echo "$BACKEND_RESP"
    fi
fi

# ============================================================
# Step 7: 验证
# ============================================================
log ""
log "========== Step 7: 环境验证 =========="

echo ""
echo "  MatrixOne  : $MO_HOST:$MO_PORT (复用现有)"
echo "  Catalog    : $CATALOG_URL (独立)"
echo "  API Key    : ${API_KEY:0:20}..."
echo "  Workspace  : $WS_ID"
echo "  hk_sfc 数据: 已在 MO 中"
echo ""

# 验证 hk_sfc 数据
$MYSQL_CMD hk_sfc -N -e "SELECT 'ms_t_stk_hsi', COUNT(*) FROM ms_t_stk_hsi
UNION ALL SELECT 'ms_t_stk_sis', COUNT(*) FROM ms_t_stk_sis
UNION ALL SELECT 'ms_v_stock_capital', COUNT(*) FROM ms_v_stock_capital
UNION ALL SELECT 'ds_t_int_hsicl_dtl', COUNT(*) FROM ds_t_int_hsicl_dtl
UNION ALL SELECT 'sehknews', COUNT(*) FROM sehknews
UNION ALL SELECT 'profit_loss', COUNT(*) FROM profit_loss;" 2>&1 | { grep -v "Warning.*password" || true; }

echo ""
curl -s "$CATALOG_URL/health" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'  Catalog: {d[\"status\"]}')" 2>/dev/null

log ""
log "========== POC 环境初始化完成 =========="
log ""
log "测试 Explore:"
log "  curl -N -X POST $CATALOG_URL/api/v1/explore/query/stream \\"
log "    -H 'X-API-Key: $API_KEY' \\"
log "    -H 'Content-Type: application/json' \\"
log "    -d '{\"query\":{\"question\":\"show tables\"},\"session\":{\"session_id\":\"test\",\"workspace_id\":\"$WS_ID\"},\"data_sources\":{\"tables\":{\"db_name\":\"hk_sfc\",\"table_list\":[\"ms_t_stk_hsi\",\"ms_t_stk_sis\"]}}}'"
