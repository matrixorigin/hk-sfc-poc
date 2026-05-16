# HK SFC POC 环境初始化指南

## 概述

从零搭建完整的 POC 环境，包括 MatrixOne 数据库、moi-core (Catalog + Workers)、数据导入、语义知识库和 Embedding 配置。

## 前置条件

1. **moi-core 镜像**: `matrixflow/moi-catalog:poc-fix`（包含 Explore 引擎修复）
2. **moi-cli**: `/Users/zhangqq/Documents/pythonProject/matrixflow/moi-core/dist/bin/moi-cli`
3. **数据文件**: `POC DATA_01/数据/` 目录下的 CSV 和 XML 文件
4. **Python 3**: 用于 XML 解析和 CCASS 爬虫

## 架构说明

```
前端 (3000) → Go 后端 (8083) → Catalog (8084) → Explore 引擎 → MatrixOne (16002)
                                                                    ↓
                                                              LLM (qwen3-max via dashscope)
```

### MO 多租户机制（重要）

MatrixOne 使用 ACCOUNT 机制实现多租户隔离：
- **sys 租户** (`dump/111`): 系统管理账户，管理 `moi_poc` 系统库
- **workspace 租户** (`ws_xxx:moi_core_system`): Explore 引擎通过此账户连接 MO，执行用户 SQL

**数据必须导入到 workspace account 下**，否则 Explore 引擎看不到。这是因为不同 account 下的数据库完全隔离。

### Workspace Account 密码

Catalog 创建 workspace 时自动在 MO 中创建 account，**密码 = owner 的 API Key (MOI_SYSTEM_API_KEY)**。
- 代码位置: `catalog/pkg/service/workspace/saga_steps.go:167`
- 连接格式: `mysql -u 'ws_xxx:moi_core_system' -p'$MOI_SYSTEM_API_KEY'`

## 初始化步骤

### Step 1: 环境初始化（04_init_poc_env.sh）

```bash
bash scripts/04_init_poc_env.sh
```

此脚本自动完成：
- 启动 MO 容器并等待就绪
- 初始化 `moi_poc` 系统库（schema + 初始数据）
- 用 `moi-cli` 生成 System API Key → 写入 `.env`
- 启动 Catalog + Workers
- 通过 Catalog API 创建 workspace → 写入 `.env`
- 配置 LLM Backend (qwen3-max via dashscope)

产出：
- `.env` 文件包含 `MOI_SYSTEM_API_KEY` 和 `POC_WORKSPACE_ID`
- Workspace account 名称可通过 API 查询

### Step 2: 获取 Workspace Account 信息

```bash
source .env
ACCT=$(curl -s "http://localhost:8084/api/v1/workspaces/$POC_WORKSPACE_ID" \
  -H "X-API-Key: $MOI_SYSTEM_API_KEY" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['account_name'])")
echo "Account: $ACCT"
echo "Password: $MOI_SYSTEM_API_KEY"
```

### Step 3: 配置 LLM Backend（如 04 脚本失败需手动补）

```bash
source .env
C="http://localhost:8084"; W="$POC_WORKSPACE_ID"; K="$MOI_SYSTEM_API_KEY"

# 创建 backend
BID=$(curl -s -X POST "$C/api/v1/workspaces/$W/llm/backends" \
  -H "X-API-Key: $K" -H "Content-Type: application/json" \
  -d '{"name":"qwen","type":0,"api_key":"sk-8e7a35e7fa784756b2459cb228599ab9","timeout_seconds":120,"models":["qwen3-max"]}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['id'])")

# 添加 endpoint
curl -s -X POST "$C/api/v1/workspaces/$W/llm/backends/$BID/endpoints" \
  -H "X-API-Key: $K" -H "Content-Type: application/json" \
  -d '{"address":"https://dashscope.aliyuncs.com/compatible-mode/v1"}' > /dev/null

# 激活
curl -s -X PUT "$C/api/v1/workspaces/$W/llm/backends/$BID/endpoints/1/status" \
  -H "X-API-Key: $K" -H "Content-Type: application/json" -d '{"status":1}' > /dev/null
```

注意：`type` 必须是整数 `0`（OPENAI），不是字符串 `"OPENAI"`。

### Step 4: 配置 Embedding Backend (BGE-m3)

```bash
source .env
C="http://localhost:8084"; W="$POC_WORKSPACE_ID"; K="$MOI_SYSTEM_API_KEY"

# 创建 backend
EBID=$(curl -s -X POST "$C/api/v1/workspaces/$W/embeddings/backends" \
  -H "X-API-Key: $K" -H "Content-Type: application/json" \
  -d '{"name":"siliconflow-bge-m3","type":0,"api_key":"sk-etpoezborerprqydjtzcppfikkanqfcfezgcttttujnvyfkd","timeout_seconds":120,"models":["BAAI/bge-m3"]}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['id'])")

# 添加 endpoint
curl -s -X POST "$C/api/v1/workspaces/$W/embeddings/backends/$EBID/endpoints" \
  -H "X-API-Key: $K" -H "Content-Type: application/json" \
  -d '{"address":"https://api.siliconflow.cn/v1"}' > /dev/null

# 激活
curl -s -X PUT "$C/api/v1/workspaces/$W/embeddings/backends/$EBID/endpoints/$EBID/status" \
  -H "X-API-Key: $K" -H "Content-Type: application/json" -d '{"status":1}' > /dev/null

# 配置 router
curl -s -X PUT "$C/api/v1/workspaces/$W/embeddings/router-config" \
  -H "X-API-Key: $K" -H "Content-Type: application/json" \
  -d '{"strategy":2,"health_check_interval_seconds":30,"max_retries":2}' > /dev/null
```

用途：为 case_library 的 few-shot 示例选择提供语义相似度匹配。代码中硬编码使用 `BAAI/bge-m3` 模型（`adapter.go:235`）。

### Step 5: 导入数据（使用 workspace account）

```bash
source .env
ACCT="<从 Step 2 获取的 account_name>"

export MO_HOST=127.0.0.1
export MO_PORT=16002
export MO_USER="${ACCT}:moi_core_system"
export MO_PASS="$MOI_SYSTEM_API_KEY"

bash scripts/02_import_data.sh
```

此脚本自动完成：
- 创建 `hk_sfc` 数据库和 7 张表
- 导入 5 个 CSV 文件（HSI、SIS、Stock Capital、Industry Classification、News）
- 解析 profit_loss XML 文件并导入

### Step 6: 更新列注释 + 标准化日期

```bash
source .env
ACCT="<account_name>"

mysql -h 127.0.0.1 -P 16002 -u "${ACCT}:moi_core_system" -p"${MOI_SYSTEM_API_KEY}" hk_sfc \
  < scripts/05_update_comments.sql

mysql -h 127.0.0.1 -P 16002 -u "${ACCT}:moi_core_system" -p"${MOI_SYSTEM_API_KEY}" hk_sfc \
  < scripts/06_standardize_dates.sql
```

### Step 7: 配置语义知识库

```bash
bash scripts/07_configure_knowledge.sh
```

配置 27 条知识：
- Glossary 4 条（字段定义）
- Logic 12 条（数据模型特征 + 表间关系 + SQL 方言约束）
- Synonyms 5 条（中英文映射）
- Case Library 6 条（6 类问题的 SQL 示例，用于 few-shot）

### Step 8: CCASS 爬虫（可选，Q5 测试需要）

```bash
source .env
ACCT="<account_name>"

.venv/bin/python scripts/03_import_ccass.py \
  --dates 2026/03/17 2026/03/18 \
  --mo-host 127.0.0.1 --mo-port 16002 \
  --mo-user "${ACCT}:moi_core_system" --mo-pass "${MOI_SYSTEM_API_KEY}" \
  --mo-db hk_sfc
```

只爬测试需要的日期即可，不要全量爬取。

### Step 9: 启动 Go 后端

```bash
cd backend
set -a; source ../.env; set +a
go run . -config config.yaml
```

后端读取 `.env` 中的环境变量（`MOI_SYSTEM_API_KEY`、`POC_WORKSPACE_ID`），通过 `config.yaml` 中的 `${...}` 展开。

### Step 10: 启动前端

```bash
cd web && npm run dev
```

## 验证清单

```bash
source .env
ACCT="<account_name>"

# 1. MO 连接
mysql -h 127.0.0.1 -P 16002 -u "${ACCT}:moi_core_system" -p"${MOI_SYSTEM_API_KEY}" hk_sfc \
  -e "SELECT 'ok' AS status"

# 2. 数据行数
mysql ... -N -e "SELECT 'hsi', COUNT(*) FROM ms_t_stk_hsi UNION ALL ..."

# 3. Catalog 健康
curl -s http://localhost:8084/health

# 4. 知识库
curl -s -X POST "http://localhost:8084/api/v1/workspaces/$POC_WORKSPACE_ID/nl2sql-knowledge/list" \
  -H "X-API-Key: $MOI_SYSTEM_API_KEY" -H "Content-Type: application/json" \
  -d '{"page_size":50}'

# 5. 后端
curl -s -X OPTIONS http://localhost:8083/api/chat

# 6. 端到端测试
curl -s -N -X POST http://localhost:8083/api/chat \
  -H "Content-Type: application/json" \
  -d '{"question":"Show me revenue of stock 88","session_id":"test"}'
```

## 注意事项

### 绝对不要做的事

1. **不要 `docker compose down`** — 这会停掉 MO，如果 MO 数据卷损坏会丢失所有数据
2. **不要 `docker volume rm`** — 等同于删除数据库
3. **不要手动 `ALTER ACCOUNT` 改密码** — 会导致 Catalog 连不上 workspace
4. **不要用 sys 租户 (dump) 导入 hk_sfc 数据** — Explore 引擎看不到

### MatrixOne hostname

`docker-compose.yaml` 中 `mo` 服务必须保留固定的 `hostname: hk-poc-mo`。MatrixOne/Dragonboat 会把节点身份写入数据卷，断电或重建容器后如果容器内 hostname 变化，可能出现 `shard not bootstrapped` panic，导致 MO 无法用原 named volume 启动。

### 重启服务的正确方式

```bash
# 只重启 Catalog（最常用）
docker compose restart catalog

# 重启 Catalog + Workers（代码更新后）
docker compose restart catalog go-worker python-worker

# 重建 Catalog（镜像更新后）
docker compose up -d --force-recreate catalog
```

**永远不要用 `docker compose down` 来重启服务。**

### Endpoint 激活问题

通过 API 创建的 LLM/Embedding endpoint 默认状态为 OFFLINE。需要通过 API 激活：

```bash
# 激活 LLM endpoint
curl -s -X PUT "$C/api/v1/workspaces/$W/llm/backends/$BID/endpoints/$EID/status" \
  -H "X-API-Key: $K" -H "Content-Type: application/json" -d '{"status":1}'
```

如果 API 激活没生效（返回空），可以直接在数据库中修改：

```bash
# 通过 workspace account 连接 moi 库
mysql -u "${ACCT}:moi_core_system" -p"${API_KEY}" moi

# 查看状态
SELECT id, backend_id, address, status FROM llm_backend_endpoint;
SELECT id, backend_id, address, status FROM embedding_backend_endpoint;

# 激活
UPDATE llm_backend_endpoint SET status='ONLINE' WHERE id=<endpoint_id>;
UPDATE embedding_backend_endpoint SET status='ONLINE' WHERE id=<endpoint_id>;
```

**修改后必须重启 Catalog** (`docker compose restart catalog`) 才能生效，因为 config cache 有 30 秒轮询间隔，但重启更可靠。

### 常见问题

| 问题 | 原因 | 解决 |
|------|------|------|
| `Access denied for user ws_xxx` | Catalog 存的密码和 MO 不一致 | 删除 workspace 重新创建 |
| `workspace not found` | .env 中 workspace ID 过期 | 重新运行 04 脚本 |
| `has_fewshot=false` | Embedding backend 未配置或未激活 | 检查 Step 4 |
| `hk_sfc not found` (Explore) | 数据在 sys 租户而非 workspace | 用 workspace account 重新导入 |
| LLM Backend 创建失败 `Invalid request body` | type 用了字符串而非整数 | `"type": 0` (OPENAI) |
| 04 脚本检查镜像失败 | 镜像名不匹配 | 检查 `poc-fix` vs `latest` |

### 环境信息

| 组件 | 端口 | 说明 |
|------|------|------|
| MatrixOne | 16002 | 独立实例，不影响现有 16001 |
| Catalog | 8084 | moi-core Explore 引擎 |
| Go 后端 | 8083 | SSE 透传 + knowledge_base 注入 |
| 前端 | 3000 | React 对话 UI |

### 数据规模

| 表 | 行数 | 说明 |
|----|------|------|
| ms_t_stk_hsi | 3,224,677 | 恒生指数盘中快照 |
| ms_t_stk_sis | 4,007,140 | 个股日行情 |
| ms_v_stock_capital | 1,199,988 | 月末市值 |
| ds_t_int_hsicl_dtl | 349,976 | 行业分类变更 |
| sehknews | 200,000 | 新闻公告 |
| profit_loss | 26,419 | 利润表 (XML) |
| ccass_holdings | 按需爬取 | CCASS 持仓 |
