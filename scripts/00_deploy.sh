#!/usr/bin/env bash
# HK SFC POC - 机房从零到一部署脚本
#
# 前置条件:
#   - Docker + Docker Compose
#   - Go 1.24+
#   - Node.js 18+ (npm)
#   - Python 3.9+
#   - mysql client (用于数据导入)
#
# 准备文件（从本地传到服务器）:
#   1. 整个 HK_POC 项目目录（含 POC DATA_01 数据文件）
#   2. Docker 镜像 tar 包:
#      - moi-catalog-poc-fix.tar.gz
#      - moi-go-worker.tar.gz
#      - moi-python-worker.tar.gz
#      - matrixone-3.0.8.tar.gz
#
# 用法:
#   步骤 0: 本地导出镜像（在开发机执行）
#     bash scripts/00_deploy.sh export-images
#
#   步骤 1-6: 服务器部署（在服务器执行）
#     bash scripts/00_deploy.sh deploy
#
# 也可以分步执行:
#     bash scripts/00_deploy.sh load-images    # 加载镜像
#     bash scripts/00_deploy.sh start-infra    # 启动 MO + Catalog + Workers
#     bash scripts/00_deploy.sh init-env       # 初始化 workspace + LLM 配置
#     bash scripts/00_deploy.sh import-data    # 导入数据 + 预计算
#     bash scripts/00_deploy.sh config-kb      # 配置知识库
#     bash scripts/00_deploy.sh build-app      # 构建前端 + 启动后端
#     bash scripts/00_deploy.sh verify         # 验证

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
IMAGE_DIR="${PROJECT_DIR}/images"

log() { echo "[$(date '+%H:%M:%S')] $*"; }

# ============================================================
# Step 0: 导出镜像（在开发机执行）
# ============================================================
export_images() {
  log "导出 Docker 镜像..."
  mkdir -p "$IMAGE_DIR"

  docker save matrixflow/moi-catalog:poc-fix | gzip > "$IMAGE_DIR/moi-catalog-poc-fix.tar.gz"
  log "  moi-catalog:poc-fix $(du -h "$IMAGE_DIR/moi-catalog-poc-fix.tar.gz" | cut -f1)"

  docker save matrixflow/moi-go-worker:latest | gzip > "$IMAGE_DIR/moi-go-worker.tar.gz"
  log "  moi-go-worker:latest $(du -h "$IMAGE_DIR/moi-go-worker.tar.gz" | cut -f1)"

  docker save matrixflow/moi-python-worker:latest | gzip > "$IMAGE_DIR/moi-python-worker.tar.gz"
  log "  moi-python-worker:latest $(du -h "$IMAGE_DIR/moi-python-worker.tar.gz" | cut -f1)"

  docker save matrixorigin/matrixone:3.0.8 | gzip > "$IMAGE_DIR/matrixone-3.0.8.tar.gz"
  log "  matrixone:3.0.8 $(du -h "$IMAGE_DIR/matrixone-3.0.8.tar.gz" | cut -f1)"

  log "镜像导出完成: $IMAGE_DIR/"
  ls -lh "$IMAGE_DIR/"
}

# ============================================================
# Step 1: 加载镜像
# ============================================================
load_images() {
  log "========== Step 1: 加载 Docker 镜像 =========="
  for f in "$IMAGE_DIR"/*.tar.gz; do
    log "  加载 $(basename "$f")..."
    docker load < "$f"
  done
  log "镜像加载完成"
  docker images | grep -E "moi-|matrixone"
}

# ============================================================
# Step 2: 启动基础设施
# ============================================================
start_infra() {
  log "========== Step 2: 启动基础设施 =========="
  cd "$PROJECT_DIR"

  # 确保 .env 存在（首次部署时需要一个占位值，后面 init-env 会更新）
  if [ ! -f .env ]; then
    echo "MOI_SYSTEM_API_KEY=placeholder" > .env
    echo "POC_WORKSPACE_ID=placeholder" >> .env
  fi

  docker compose up -d
  log "等待服务启动..."
  sleep 10

  # 等 MO 就绪
  for i in $(seq 1 30); do
    if mysql -h 127.0.0.1 -P 16002 -u dump -p111 -e "SELECT 1" &>/dev/null; then
      log "  MO 就绪"
      break
    fi
    sleep 2
  done

  # 等 Catalog 就绪
  for i in $(seq 1 30); do
    if curl -s http://localhost:8084/health | grep -q healthy; then
      log "  Catalog 就绪"
      break
    fi
    sleep 2
  done

  docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" | grep -E "hk-poc|NAME"
}

# ============================================================
# Step 3: 初始化环境（workspace + LLM 配置）
# ============================================================
init_env() {
  log "========== Step 3: 初始化 Workspace 环境 =========="
  bash "$SCRIPT_DIR/04_init_poc_env.sh"

  # 重新加载 .env（04 脚本会更新它）
  source "$PROJECT_DIR/.env"
  log "MOI_SYSTEM_API_KEY=${MOI_SYSTEM_API_KEY:0:20}..."
  log "POC_WORKSPACE_ID=$POC_WORKSPACE_ID"
}

# ============================================================
# Step 4: 导入数据
# ============================================================
import_data() {
  log "========== Step 4: 导入数据 =========="
  source "$PROJECT_DIR/.env"

  # 4a: 基础表 + CSV 导入 + 预计算列 + 日线表
  bash "$SCRIPT_DIR/02_import_data.sh"

  # 4b: CCASS 数据（如果有缓存直接导入）
  if [ -d "/tmp/ccass_cache" ] || [ -f "$SCRIPT_DIR/03_import_ccass.py" ]; then
    log "导入 CCASS 数据..."
    python3 "$SCRIPT_DIR/03_import_ccass.py" --from-cache 2>/dev/null || \
    python3 "$SCRIPT_DIR/03_import_ccass.py" || \
    log "  CCASS 导入跳过（需要网络访问 HKEX）"
  fi
}

# ============================================================
# Step 5: 配置知识库
# ============================================================
config_kb() {
  log "========== Step 5: 配置知识库 =========="
  source "$PROJECT_DIR/.env"
  bash "$SCRIPT_DIR/07_configure_knowledge.sh"
}

# ============================================================
# Step 6: 构建应用
# ============================================================
build_app() {
  log "========== Step 6: 构建应用 =========="
  source "$PROJECT_DIR/.env"

  # 前端构建
  log "构建前端..."
  cd "$PROJECT_DIR/web"
  npm install
  npm run build
  log "前端构建完成: dist/"

  # 后端编译
  log "编译后端..."
  cd "$PROJECT_DIR/backend"
  go build -o hk-poc-backend .
  log "后端编译完成: hk-poc-backend"

  # 启动后端
  log "启动后端..."
  export MOI_SYSTEM_API_KEY POC_WORKSPACE_ID
  nohup ./hk-poc-backend -config config.yaml > /tmp/hk-poc-backend.log 2>&1 &
  sleep 2

  if curl -s -o /dev/null -w "%{http_code}" http://localhost:8083/api/chat -X OPTIONS | grep -q 204; then
    log "后端启动成功: http://localhost:8083"
  else
    log "后端启动失败，查看 /tmp/hk-poc-backend.log"
  fi

  # 启动前端（生产模式）
  log "启动前端..."
  cd "$PROJECT_DIR/web"
  nohup npx vite preview --port 3000 --host 0.0.0.0 > /tmp/hk-poc-frontend.log 2>&1 &
  sleep 2
  log "前端启动: http://localhost:3000"
}

# ============================================================
# Step 7: 验证
# ============================================================
verify() {
  log "========== 验证 =========="
  source "$PROJECT_DIR/.env"

  echo -n "  MO: "; mysql -h 127.0.0.1 -P 16002 -u dump -p111 -e "SELECT 1" &>/dev/null && echo "OK" || echo "FAIL"
  echo -n "  Catalog: "; curl -s http://localhost:8084/health | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])" 2>/dev/null || echo "FAIL"
  echo -n "  Backend: "; curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://localhost:8083/api/chat -X OPTIONS 2>/dev/null; echo ""
  echo -n "  Frontend: "; curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://localhost:3000 2>/dev/null; echo ""

  log ""
  log "快速测试..."
  curl -N -s -X POST "http://localhost:8083/api/chat" \
    -H "Content-Type: application/json" \
    -d '{"question":"恒生指数2025年跌幅最大的3天","session_id":"deploy-verify"}' 2>&1 | \
    grep "run.completed" | python3 -c "
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
  load_images
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
  export-images) export_images ;;
  load-images) load_images ;;
  start-infra) start_infra ;;
  init-env) init_env ;;
  import-data) import_data ;;
  config-kb) config_kb ;;
  build-app) build_app ;;
  verify) verify ;;
  deploy) deploy ;;
  *)
    echo "用法: bash scripts/00_deploy.sh <command>"
    echo ""
    echo "Commands:"
    echo "  export-images  在开发机导出 Docker 镜像 tar 包"
    echo "  deploy         一键部署（load → start → init → import → config → build → verify）"
    echo ""
    echo "分步执行:"
    echo "  load-images    加载 Docker 镜像"
    echo "  start-infra    启动 MO + Catalog + Workers"
    echo "  init-env       初始化 workspace + LLM 配置"
    echo "  import-data    导入数据 + 预计算"
    echo "  config-kb      配置知识库"
    echo "  build-app      构建前端 + 启动后端"
    echo "  verify         验证各服务状态"
    ;;
esac
