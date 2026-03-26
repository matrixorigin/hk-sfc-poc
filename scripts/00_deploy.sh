#!/usr/bin/env bash
# HK SFC POC - 机房从零到一部署脚本
#
# 前置条件:
#   - Docker + Docker Compose
#   - Go 1.24+
#   - Node.js 18+ (npm)
#   - Python 3.9+
#   - mysql client
#   - git (能访问 github.com)
#
# 部署步骤:
#   1. git clone 两个仓库
#   2. bash scripts/00_deploy.sh deploy
#
# 仓库:
#   - HK_POC:  https://github.com/aqqi666/hk-sfc-poc.git
#   - moi-core: git@github.com:matrixorigin/matrixflow.git (branch: dev-poc-fix)
#
# 用法:
#   bash scripts/00_deploy.sh deploy          # 一键全部
#   bash scripts/00_deploy.sh build-images    # 只构建镜像
#   bash scripts/00_deploy.sh start-infra     # 只启动基础设施
#   bash scripts/00_deploy.sh init-env        # 只初始化环境
#   bash scripts/00_deploy.sh import-data     # 只导入数据
#   bash scripts/00_deploy.sh config-kb       # 只配置知识库
#   bash scripts/00_deploy.sh build-app       # 只构建/启动应用
#   bash scripts/00_deploy.sh verify          # 验证

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# moi-core 仓库位置（和 HK_POC 同级目录）
MOI_CORE_DIR="${MOI_CORE_DIR:-$(dirname "$PROJECT_DIR")/matrixflow/moi-core}"

log() { echo "[$(date '+%H:%M:%S')] $*"; }

# ============================================================
# Step 1: 构建 Docker 镜像（从 moi-core 源码）
# ============================================================
build_images() {
  log "========== Step 1: 构建 Docker 镜像 =========="

  if [ ! -d "$MOI_CORE_DIR" ]; then
    log "moi-core 目录不存在: $MOI_CORE_DIR"
    log "请先 clone:"
    log "  git clone git@github.com:matrixorigin/matrixflow.git"
    log "  cd matrixflow/moi-core && git checkout dev-poc-fix"
    exit 1
  fi

  log "moi-core 目录: $MOI_CORE_DIR"

  # 确认在 dev-poc-fix 分支
  cd "$MOI_CORE_DIR"
  BRANCH=$(git branch --show-current)
  if [ "$BRANCH" != "dev-poc-fix" ]; then
    log "切换到 dev-poc-fix 分支 (当前: $BRANCH)..."
    git checkout dev-poc-fix
  fi

  # 构建 catalog (poc-fix)
  log "构建 moi-catalog:poc-fix..."
  docker build -t matrixflow/moi-catalog:poc-fix -f catalog/Dockerfile . 2>&1 | tail -3

  # 构建 go-worker
  if [ -f go-worker/Dockerfile ]; then
    log "构建 moi-go-worker:latest..."
    docker build -t matrixflow/moi-go-worker:latest -f go-worker/Dockerfile . 2>&1 | tail -3
  else
    log "go-worker Dockerfile 不存在，尝试 make..."
    cd "$MOI_CORE_DIR/.." && make build-go-worker 2>&1 | tail -3 || log "  go-worker 构建跳过"
  fi

  # 构建 python-worker
  if [ -f python-worker/Dockerfile ]; then
    log "构建 moi-python-worker:latest..."
    docker build -t matrixflow/moi-python-worker:latest -f python-worker/Dockerfile . 2>&1 | tail -3
  else
    log "python-worker Dockerfile 不存在，尝试 make..."
    cd "$MOI_CORE_DIR/.." && make build-python-worker 2>&1 | tail -3 || log "  python-worker 构建跳过"
  fi

  # MO 直接 pull
  log "拉取 matrixone:3.0.8..."
  docker pull matrixorigin/matrixone:3.0.8 2>&1 | tail -1

  cd "$PROJECT_DIR"
  log "镜像构建完成:"
  docker images --format "  {{.Repository}}:{{.Tag}} ({{.Size}})" | grep -E "moi-|matrixone:3.0.8"
}

# ============================================================
# Step 2: 启动基础设施
# ============================================================
start_infra() {
  log "========== Step 2: 启动基础设施 =========="
  cd "$PROJECT_DIR"

  # 确保 .env 存在
  if [ ! -f .env ]; then
    echo "MOI_SYSTEM_API_KEY=placeholder" > .env
    echo "POC_WORKSPACE_ID=placeholder" >> .env
    log "创建了占位 .env（init-env 步骤会更新）"
  fi

  docker compose up -d 2>/dev/null || docker-compose up -d
  log "等待服务启动..."

  # 等 MO 就绪
  for i in $(seq 1 60); do
    if mysql -h 127.0.0.1 -P 16002 -u dump -p111 -e "SELECT 1" &>/dev/null; then
      log "  MO 就绪 (${i}s)"
      break
    fi
    sleep 2
  done

  # 等 Catalog 就绪
  for i in $(seq 1 60); do
    if curl -s http://localhost:8084/health | grep -q healthy; then
      log "  Catalog 就绪 (${i}s)"
      break
    fi
    sleep 2
  done

  docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" | grep -E "hk-poc|NAME"
}

# ============================================================
# Step 3: 初始化环境
# ============================================================
init_env() {
  log "========== Step 3: 初始化 Workspace 环境 =========="
  cd "$PROJECT_DIR"
  bash "$SCRIPT_DIR/04_init_poc_env.sh"
  source "$PROJECT_DIR/.env"
  log "MOI_SYSTEM_API_KEY=${MOI_SYSTEM_API_KEY:0:20}..."
  log "POC_WORKSPACE_ID=$POC_WORKSPACE_ID"
}

# ============================================================
# Step 4: 导入数据
# ============================================================
import_data() {
  log "========== Step 4: 导入数据 =========="
  cd "$PROJECT_DIR"
  source "$PROJECT_DIR/.env"

  bash "$SCRIPT_DIR/02_import_data.sh"

  # CCASS 数据
  if [ -f "$SCRIPT_DIR/03_import_ccass.py" ]; then
    log "导入 CCASS 数据..."
    python3 "$SCRIPT_DIR/03_import_ccass.py" --from-cache 2>/dev/null || \
    python3 "$SCRIPT_DIR/03_import_ccass.py" 2>/dev/null || \
    log "  CCASS 导入跳过（需要网络访问 HKEX）"
  fi
}

# ============================================================
# Step 5: 配置知识库
# ============================================================
config_kb() {
  log "========== Step 5: 配置知识库 =========="
  cd "$PROJECT_DIR"
  source "$PROJECT_DIR/.env"
  bash "$SCRIPT_DIR/07_configure_knowledge.sh"
}

# ============================================================
# Step 6: 构建应用
# ============================================================
build_app() {
  log "========== Step 6: 构建应用 =========="
  cd "$PROJECT_DIR"
  source "$PROJECT_DIR/.env"
  export MOI_SYSTEM_API_KEY POC_WORKSPACE_ID

  # 前端
  log "构建前端..."
  cd "$PROJECT_DIR/web"
  npm install --legacy-peer-deps
  npm run build
  log "前端构建完成"

  # 后端
  log "编译后端..."
  cd "$PROJECT_DIR/backend"
  go build -o hk-poc-backend .
  log "后端编译完成"

  # 停掉旧进程
  pkill -f "hk-poc-backend" 2>/dev/null || true
  pkill -f "vite preview.*3000" 2>/dev/null || true
  sleep 1

  # 启动后端
  log "启动后端 (port 8083)..."
  nohup ./hk-poc-backend -config config.yaml > /tmp/hk-poc-backend.log 2>&1 &
  sleep 2

  # 启动前端（生产预览模式）
  log "启动前端 (port 3000)..."
  cd "$PROJECT_DIR/web"
  nohup npx vite preview --port 3000 --host 0.0.0.0 > /tmp/hk-poc-frontend.log 2>&1 &
  sleep 2

  echo -n "  Backend: "; curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://localhost:8083/api/chat -X OPTIONS 2>/dev/null; echo ""
  echo -n "  Frontend: "; curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://localhost:3000 2>/dev/null; echo ""
}

# ============================================================
# Step 7: 验证
# ============================================================
verify() {
  log "========== 验证 =========="
  source "$PROJECT_DIR/.env" 2>/dev/null || true

  echo -n "  MO: "; mysql -h 127.0.0.1 -P 16002 -u dump -p111 -e "SELECT 1" &>/dev/null && echo "OK" || echo "FAIL"
  echo -n "  Catalog: "; curl -s http://localhost:8084/health | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])" 2>/dev/null || echo "FAIL"
  echo -n "  Backend: "; curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://localhost:8083/api/chat -X OPTIONS 2>/dev/null; echo ""
  echo -n "  Frontend: "; curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://localhost:3000 2>/dev/null; echo ""

  log ""
  log "快速 Explore 测试..."
  curl -N -s -X POST "http://localhost:8083/api/chat" \
    -H "Content-Type: application/json" \
    -d '{"question":"恒生指数2025年跌幅最大的3天","session_id":"deploy-verify"}' 2>&1 | \
    grep "run.completed" | head -1 | python3 -c "
import sys,json
for l in sys.stdin:
  if 'data:' in l:
    d=json.loads(l.split('data: ',1)[1])['data']
    print(f'  Explore: status={d.get(\"status\",\"?\")}')
" 2>/dev/null || echo "  Explore: TIMEOUT/FAIL"

  log ""
  log "========== 部署完成 =========="
  log "前端: http://<server-ip>:3000"
  log "后端: http://<server-ip>:8083"
  log "Catalog: http://<server-ip>:8084"
}

# ============================================================
# 一键部署
# ============================================================
deploy() {
  build_images
  start_infra
  init_env
  import_data
  config_kb
  build_app
  verify
}

# ============================================================
# 入口
# ============================================================
case "${1:-help}" in
  build-images) build_images ;;
  start-infra) start_infra ;;
  init-env) init_env ;;
  import-data) import_data ;;
  config-kb) config_kb ;;
  build-app) build_app ;;
  verify) verify ;;
  deploy) deploy ;;
  *)
    echo "HK SFC POC 部署脚本"
    echo ""
    echo "部署前准备:"
    echo "  1. git clone https://github.com/aqqi666/hk-sfc-poc.git"
    echo "  2. git clone git@github.com:matrixorigin/matrixflow.git"
    echo "     cd matrixflow/moi-core && git checkout dev-poc-fix"
    echo "  3. 将 POC DATA_01 数据目录放到 hk-sfc-poc/ 下"
    echo ""
    echo "用法: bash scripts/00_deploy.sh <command>"
    echo ""
    echo "Commands:"
    echo "  deploy         一键部署（构建 → 启动 → 初始化 → 导入 → 知识库 → 应用 → 验证）"
    echo ""
    echo "分步执行:"
    echo "  build-images   从 moi-core 源码构建 Docker 镜像"
    echo "  start-infra    启动 MO + Catalog + Workers"
    echo "  init-env       初始化 workspace + LLM 配置"
    echo "  import-data    导入数据 + 预计算列 + 日线表"
    echo "  config-kb      配置语义知识库"
    echo "  build-app      构建前端 + 编译后端 + 启动"
    echo "  verify         验证各服务状态"
    echo ""
    echo "环境变量:"
    echo "  MOI_CORE_DIR   moi-core 目录路径 (默认: ../matrixflow/moi-core)"
    ;;
esac
