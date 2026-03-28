# 服务器更新指南

## 只改了前端/后端代码（不涉及 moi-core）

```bash
cd ~/data/hk-poc/hk-sfc-poc
git pull
docker compose build app && docker compose up -d --force-recreate app
```

## 只改了知识库配置

```bash
cd ~/data/hk-poc/hk-sfc-poc
git pull
bash scripts/07_configure_knowledge.sh
```

## 只改了 TOML 配置（catalog.toml）

```bash
cd ~/data/hk-poc/hk-sfc-poc
git pull
docker compose up -d --force-recreate catalog
```

## 改了 moi-core 代码（planner/retriever/adapter 等）

```bash
cd ~/data/moi/matrixflow/moi-core
git pull origin dev-poc-fix
make build-image-catalog IMAGE_TAG=poc-fix APK_REPO=https://mirrors.aliyun.com/alpine

cd ~/data/hk-poc/hk-sfc-poc
docker compose up -d --force-recreate catalog
```

## 数据重建（改了建表脚本/预计算/导入逻辑）

```bash
cd ~/data/hk-poc/hk-sfc-poc
git pull
bash scripts/02_import_data.sh
bash scripts/07_configure_knowledge.sh
```

## 全量更新（都改了）

```bash
# 1. moi-core
cd ~/data/moi/matrixflow/moi-core
git pull origin dev-poc-fix
make build-image-catalog IMAGE_TAG=poc-fix APK_REPO=https://mirrors.aliyun.com/alpine

# 2. HK_POC
cd ~/data/hk-poc/hk-sfc-poc
git pull

# 3. 数据 + 知识库
bash scripts/02_import_data.sh
bash scripts/07_configure_knowledge.sh

# 4. 重启服务
docker compose up -d --force-recreate catalog
docker compose build app && docker compose up -d --force-recreate app
```

## 添加新 LLM 模型

```bash
source .env
# 查看现有 backend
curl -s http://localhost:8084/api/v1/workspaces/$POC_WORKSPACE_ID/llm/backends \
  -H "X-API-Key: $MOI_SYSTEM_API_KEY" | python3 -m json.tool

# 更新模型列表（BACKEND_ID 从上面查到）
BACKEND_ID=1
curl -s -X PUT http://localhost:8084/api/v1/workspaces/$POC_WORKSPACE_ID/llm/backends/$BACKEND_ID \
  -H "X-API-Key: $MOI_SYSTEM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"models": ["qwen3-max", "qwen3.5-plus", "qwen3.5-flash", "qwen-plus", "qwen-max"]}'
```
