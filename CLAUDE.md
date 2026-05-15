# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

HK SFC POC: NL2SQL system for Hong Kong securities market data analysis. Users ask natural language questions → Go backend → Catalog Explore API (LLM: qwen3-max) → SQL generation → MatrixOne execution → streaming results with chart visualization.

## Build & Deploy

```bash
# Start all services (mo, catalog, workers, app)
docker compose up -d

# Rebuild and deploy app only (3 steps: local verify → build → deploy)
cd web && npm run build && cd ..   # 本地先跑，和 Docker 内同一命令，确保 TS 编译通过
docker compose build app && docker compose up -d --force-recreate app

# Catalog image must be built from moi-core repo:
# cd /path/to/moi-core && make build-image-catalog
```

> **⚠ 前端验证必须用 `npm run build`（即 `tsc -b && vite build`），不要用 `tsc --noEmit`。**
> 两者严格程度不同，`--noEmit` 通过不代表 Docker 内能编译成功。

## Testing

```bash
# Accuracy test (streaming validation: finishes → validates → any failure stops all)
python3 scripts/09_accuracy_test.py -c 2    # -c = concurrency

# Integration test
bash scripts/08_integration_test.sh
```

## Key Scripts (run in order for fresh setup)

| Script | Purpose |
|--------|---------|
| `01_create_tables.sql` | DDL for 8 tables with column comments |
| `02_import_data.sh` | CSV import + date standardization + pre-computed columns (MA, consecutive days, industry carry-forward) |
| `04_init_poc_env.sh` | Catalog workspace initialization |
| `07_configure_knowledge.sh` | Semantic knowledge base rules (logic/case_library/glossary) |
| `09_accuracy_test.py` | Streaming accuracy test (ThreadPoolExecutor + as_completed + fail-fast) |
| `accuracy_cases.tsv` | Test case data (sid/label/question/gt_sql/checks), loaded by 09_accuracy_test.py |

## Architecture

```
React Frontend (web/) → Go Backend (backend/:3000) → Catalog API (:8084) → MatrixOne (:16002)
```

**Chat flow**: ChatHandler receives question → Clarifier checks for missing params (time range, stock code) via LLM → maps frontend UUID session to Catalog numeric session → sends to Explore API → EventProcessor transforms SSE stream (injects chart.recommendation) → streams to frontend.

**Knowledge base**: 3 types in Catalog nl2sql-knowledge API (knowledge_base_id=10001):
- `logic`: business constraints (news dedup, SQL dialect limits)
- `case_library`: fewshot SQL templates (CCASS change, YoY comparison, news volume anomaly, HSI monthly)
- `glossary`: term-to-table/column mapping

## MatrixOne 3.0.8 Constraints (Critical)

These are NOT in official docs — discovered through testing:
- `RIGHT()` not supported → use `SUBSTRING(col, LENGTH(col)-N+1, N)`
- `CHANGE`, `RANK` are reserved words → use aliases like `turnover_change`, `rnk`
- `LAG/LEAD` wrapping `CASE WHEN` causes panic → pre-compute flag columns first
- Correlated subqueries in SELECT may return NULL → prefer LAG/self-JOIN
- `CAST(VARCHAR AS UNSIGNED)` combined with window functions may panic → filter strings in inner subquery
- `UPDATE...JOIN` broken on nightly builds → stay on 3.0.8

## Database (hk_sfc)

8 tables. Key conventions:
- **SISTKC**: 5-digit zero-padded VARCHAR (`'00001'`), compare as string
- **profit_loss.stock_code**: NOT zero-padded (e.g. `88` not `00088`)
- **Pre-computed columns on ms_t_stk_sis**: `ma_3/20/50/100`, `consecutive_above_ma3/ma20/ma50`, `avg_vol_30d`, `trade_date`
- **Pre-computed on ms_v_stock_capital**: `industry_name` (carry-forward from ds_t_int_hsicl_dtl)
- **sehknews.trade_date**: pre-computed nearest trading day (use this for JOIN, not timestamp)
- Data range is auto-written to column comments by `02_import_data.sh`

## Environment

`.env` file (git-ignored) must contain:
- `MOI_SYSTEM_API_KEY` — Catalog API key
- `POC_WORKSPACE_ID` — Workspace UUID
- `DASHSCOPE_API_KEY` — Alibaba Cloud LLM API key (used by Catalog)

## Docker Services

| Service | Internal Port | External Port |
|---------|-------------|---------------|
| hk-poc-mo | 6001 | 16002 |
| hk-poc-catalog | 8081 | 8084 |
| hk-poc-app | 3000 | 3000 |
