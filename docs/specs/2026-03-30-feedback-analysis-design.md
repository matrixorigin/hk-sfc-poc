# Query Feedback & Analysis Feature Design

## Overview

用户查询后觉得结果不准确，点击"结果不准确？"按钮提交反馈，系统后台自动收集上下文并调用 LLM（开启深度思考）分析 SQL 问题，生成优化建议。不修改知识库或表结构，仅展示分析结果。

新增"分析中心"页面，列表展示所有反馈任务及其分析结果。

## Data Model

SQLite 持久化，文件路径 `data/feedback.db`。

```sql
CREATE TABLE feedback_tasks (
    id          TEXT PRIMARY KEY,
    status      TEXT NOT NULL DEFAULT 'pending',  -- pending | analyzing | done | error
    created_at  TEXT NOT NULL,

    -- 输入
    question    TEXT NOT NULL,
    user_note   TEXT,
    sql         TEXT NOT NULL,
    sql_result  TEXT,          -- JSON: {columns, rows, total_count}
    session_id  TEXT,

    -- 分析结果
    analysis    TEXT,          -- JSON: {problems, suggestions, corrected_sql}
    error_msg   TEXT,
    finished_at TEXT
);
```

analysis JSON 结构：

```json
{
  "problems": [
    {"severity": "high|medium|low", "description": "问题描述"}
  ],
  "suggestions": [
    {"type": "knowledge|schema|fewshot", "description": "建议摘要", "detail": "具体建议内容"}
  ],
  "corrected_sql": "SELECT ..."
}
```

## API Design

### POST /api/feedback — 提交反馈

Request:
```json
{
  "question": "用户原始问题",
  "user_note": "用户描述哪里不对（可选）",
  "sql": "LLM 生成的 SQL",
  "sql_result": {"columns": [...], "rows": [...], "total_count": 1517},
  "session_id": "前端 session uuid"
}
```

Response:
```json
{"id": "uuid", "status": "pending"}
```

后端立即返回，起 goroutine 后台分析。

### GET /api/feedback — 任务列表

Response:
```json
{
  "tasks": [
    {
      "id": "uuid",
      "status": "done",
      "question": "检测成交量超过30日平均值3倍的股票",
      "created_at": "2026-03-30T10:00:00Z",
      "analysis": { ... }
    }
  ]
}
```

按 created_at 倒序，返回全部任务。

### GET /api/feedback/:id — 任务详情

Response: 完整的 feedback_task 记录（含 sql、sql_result、analysis 等）。

## Backend Analysis Flow

goroutine 内执行：

### Step 1: 收集上下文

| 信息 | 来源 | 方式 |
|------|------|------|
| 涉及表的 schema + 列注释 | MatrixOne information_schema | 从 SQL 中提取表名，查询 SHOW FULL COLUMNS |
| 知识库规则 | Catalog nl2sql-knowledge API | GET list, 全量拉取 |
| 示例数据 | MatrixOne | 每张涉及表 SELECT * LIMIT 5 |
| SQL 执行结果 | 前端传入 / 后端重新执行 | 优先用前端传入的 |

表名从 SQL 中提取：正则匹配 `FROM <table>` 和 `JOIN <table>` 模式。

### Step 2: 调用 LLM 分析

调用 Catalog LLM API (`/api/v1/workspaces/{ws}/llm/chat/completions`)。

模型：`qwen3-max`，开启思考能力 `enable_thinking: true`，`temperature: 0`。

System Prompt:
```
你是一个专业的 NL2SQL 分析专家。用户提交了一个自然语言查询，系统生成了 SQL 并返回了结果，但用户认为结果不准确。

请分析以下信息，找出 SQL 可能存在的问题，并给出优化建议。

分析要求：
1. 对比用户问题的语义和生成 SQL 的逻辑，找出不匹配之处
2. 检查 SQL 是否正确使用了预计算列（如 trade_date, avg_vol_30d, industry_name, consecutive_above_ma3 等）
3. 检查是否遗漏了必要的过滤条件（如衍生品排除 SISTKC < '10000'、新闻去重等）
4. 检查是否违反了知识库中的业务规则
5. 检查 SQL 方言是否兼容 MatrixOne（如 RIGHT() 不支持、CHANGE 是保留字等）
6. 如果能修正，给出修正后的 SQL

返回 JSON 格式：
{
  "problems": [{"severity": "high|medium|low", "description": "问题描述"}],
  "suggestions": [{"type": "knowledge|schema|fewshot", "description": "建议摘要", "detail": "具体操作建议"}],
  "corrected_sql": "修正后的 SQL，如果无法修正则为空字符串"
}
```

User Content 包含：
```
## 用户问题
{question}

## 用户反馈
{user_note}

## 生成的 SQL
{sql}

## SQL 执行结果（前20行）
{sql_result}

## 涉及表的 Schema
{schema_with_comments}

## 示例数据
{sample_data}

## 知识库规则
{knowledge_rules}
```

### Step 3: 解析结果写入 SQLite

解析 LLM 返回的 JSON，写入 analysis 字段，状态改为 `done`。如果 LLM 调用失败或解析失败，状态改为 `error`，错误信息写入 error_msg。

## Frontend Design

### 聊天页改动 (MessageBubble.tsx)

查询完成后（`isDone && sqlResults.length > 0`），在 SQL 折叠区下方显示：

```
[💬 结果不准确？]  ← 按钮
```

点击展开：
```
┌──────────────────────────────────────────┐
│  请描述哪里不对（可选）：                    │
│  ┌────────────────────────────────────┐  │
│  │                                    │  │
│  └────────────────────────────────────┘  │
│                              [提交反馈]   │
└──────────────────────────────────────────┘
```

提交后变为：
```
✅ 已提交分析任务，可在分析中心查看
```

### 新增分析中心页 (AnalysisPanel.tsx)

侧边栏新增菜单入口，与 Knowledge Base 同级。

**列表视图：**

```
┌─────────────────────────────────────────────────────┐
│  分析中心                                             │
├─────────────────────────────────────────────────────┤
│  🔵 分析中  | 检测成交量超过30日...   | 03-30 10:05  │
│  ✅ 已完成  | 360鲁大师营收增长...    | 03-30 09:30  │
│  ✅ 已完成  | 恒指月末收盘值...       | 03-30 09:15  │
│  ❌ 失败    | 行业市值下降...         | 03-30 09:00  │
└─────────────────────────────────────────────────────┘
```

**详情视图（点击展开）：**

```
┌─────────────────────────────────────────────────────┐
│  原始问题: 检测在重大新闻公告发布前...                    │
│  用户备注: 数字比预期多了很多                            │
│                                                       │
│  生成的 SQL:                                           │
│  ┌─ sql ──────────────────────────────────────────┐  │
│  │ SELECT ... FROM sehknews n JOIN ...             │  │
│  └────────────────────────────────────────────────┘  │
│                                                       │
│  🔴 高严重性问题:                                      │
│  • 使用 DATE(timestamp) 匹配交易日，未使用预计算的       │
│    trade_date 列，非交易日新闻会丢失                     │
│                                                       │
│  🟡 中等问题:                                          │
│  • 未对同一股票同天多条新闻去重，导致结果膨胀              │
│                                                       │
│  💡 优化建议:                                          │
│  • [知识规则] 添加规则指导使用 sehknews.trade_date       │
│  • [Fewshot] 添加新闻成交量分析的 SQL 模板               │
│                                                       │
│  修正 SQL:                                             │
│  ┌─ sql ──────────────────────────────────────────┐  │
│  │ SELECT ... FROM (SELECT ... GROUP BY ...) n ... │  │
│  └────────────────────────────────────────── [复制] ┘  │
└─────────────────────────────────────────────────────┘
```

### 轮询策略

- 列表页打开时轮询 `GET /api/feedback`，5秒一次
- 当所有任务都是 done/error 状态时停止轮询
- 切离页面时停止轮询

## File Changes

### 新增文件

| 文件 | 说明 |
|------|------|
| `backend/feedback.go` | FeedbackHandler + Analyzer，API 处理 + LLM 分析逻辑 |
| `backend/feedbackdb.go` | SQLite 操作封装（建表、CRUD） |
| `web/src/components/AnalysisPanel.tsx` | 分析中心页面 |
| `web/src/components/AnalysisPanel.css` | 分析中心样式 |
| `web/src/components/FeedbackButton.tsx` | 聊天页反馈按钮组件 |

### 修改文件

| 文件 | 改动 |
|------|------|
| `backend/main.go` | 注册 /api/feedback 路由，初始化 SQLite |
| `backend/go.mod` | 添加 `modernc.org/sqlite` 依赖 |
| `web/src/components/MessageBubble.tsx` | 引入 FeedbackButton |
| `web/src/App.tsx` | 添加分析中心菜单入口和页面切换 |
| `web/src/i18n/zh.json` | 中文文案 |
| `web/src/i18n/en.json` | 英文文案 |

## Key Decisions

1. **SQLite 持久化** — 重启不丢失，文件级存储无外部依赖
2. **后台 goroutine 分析** — 用户不用等，异步体验
3. **开启 LLM 思考能力** — `enable_thinking: true`，质量优先
4. **上下文尽量丰富** — schema + 知识规则 + 示例数据 + 执行结果，让 LLM 有足够信息做深度分析
5. **只读建议** — 不自动修改任何东西，人决定是否采纳
