# HK SFC POC 架构设计

## 概述

为香港证监会(SFC)构建 AI 数据探索 POC。用户通过对话界面用自然语言查询香港股市数据，系统通过 moi-core Explore 引擎自动生成 SQL、执行查询、合成答案。

## 架构

```
用户浏览器 (localhost:3000)
    │
    │  POST /api/chat (SSE 响应)
    │
Go 后端 (localhost:8083)
    │  - 接收问题 + session_id
    │  - 拼装 ExploreRequest（注入配置参数）
    │  - 透传 Explore SSE 流
    │
    │  POST /api/v1/explore/query/stream
    │
POC Catalog (localhost:8082)
    │  - Explore: Planner → SQL Retriever → Synthesizer
    │  - LLM: qwen3-max (dashscope)
    │
MatrixOne (localhost:16001)
    └── hk_sfc 库 (7 张表)
```

## Go 后端

### 职责

1. 接收前端的问题 + session_id
2. 拼装 ExploreRequest（固定注入 workspace_id、db_name、全量 table_list）
3. 透传 Explore 的 SSE 事件流给前端

无状态。会话管理全交给 Explore。

### 项目结构

```
server/
├── main.go          # 入口，启动 HTTP 服务
├── config.go        # 配置加载
├── handler.go       # HTTP handler（chat 接口 + 预处理/后处理钩子）
├── explore.go       # Explore API 调用 + SSE 转发
└── config.yaml      # 配置
```

### 配置

```yaml
catalog_url: "http://localhost:8082"
api_key: "moi_xxx"
workspace_id: "xxx"
db_name: "hk_sfc"
tables:
  - ms_t_stk_hsi
  - ms_t_stk_sis
  - ms_v_stock_capital
  - ds_t_int_hsicl_dtl
  - sehknews
  - profit_loss
  - ccass_holdings
```

### API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/chat` | 提问，返回 SSE 流 |

请求体：
```json
{
  "question": "What was the total trading volume when HSI dropped over 2%?",
  "session_id": "sess_abc"
}
```

后端拼装为 ExploreRequest：
```json
{
  "query": { "question": "..." },
  "session": { "session_id": "sess_abc", "workspace_id": "<config>" },
  "data_sources": { "tables": { "db_name": "hk_sfc", "table_list": ["<all 7>"] } },
  "options": { "planning_mode": "auto", "verbose": "steps" },
  "trace": { "enabled": true }
}
```

响应：透传 Explore SSE 事件流（`Content-Type: text/event-stream`）。

### 扩展点

handler.go 中预留钩子函数，当前为空实现：
- `preProcess(question string) string` — 未来可加问题增强（注入日期格式提示等）
- `postProcess(event SSEEvent) SSEEvent` — 未来可加结果加工

## 前端

### 技术栈

- React + Vite + TypeScript
- ECharts（图表）
- i18n JSON（双语：英文默认，可切换中文）

### 项目结构

```
web/
├── package.json
├── vite.config.ts
├── src/
│   ├── main.tsx
│   ├── App.tsx               # 布局 + 语言切换
│   ├── components/
│   │   ├── ChatPanel.tsx     # 对话面板（消息列表 + 输入框）
│   │   ├── MessageBubble.tsx # 单条消息（流式渲染）
│   │   ├── DataTable.tsx     # SQL 结果表格
│   │   ├── Chart.tsx         # ECharts 图表
│   │   └── LangSwitch.tsx    # EN/CN 切换
│   ├── hooks/
│   │   └── useExploreSSE.ts  # SSE 连接 + 事件解析
│   ├── i18n/
│   │   ├── en.json
│   │   └── zh.json
│   └── types.ts              # 事件类型定义
```

### SSE 事件处理

| Explore 事件 | 前端处理 |
|---|---|
| `run.started` | 显示加载状态 |
| `planning.plan.ready` | 可选：显示"正在分析..." |
| `sql.generated` | 可选：折叠展示 SQL |
| `sql.result` | 渲染 DataTable；含日期+数值列时提供 Chart |
| `synthesis.delta` | 追加文字（打字机效果） |
| `synthesis.done` | 标记消息完成 |
| `run.completed` | 关闭 SSE，恢复输入框 |
| `run.error` | 显示错误 |
| 其他 | 忽略 |

### 消息渲染结构

```
┌─ MessageBubble ──────────────────────┐
│  [AI 文字回答，流式渲染]              │
│  ┌─ DataTable ─────────────────────┐ │
│  │ 股票代码 | 日期  | 成交量       │ │
│  └─────────────────────────────────┘ │
│  ┌─ Chart (ECharts) ───────────────┐ │
│  │       📈 折线图                  │ │
│  └─────────────────────────────────┘ │
│  ▶ 查看 SQL（折叠）                  │
└──────────────────────────────────────┘
```

### 图表策略

不做自动图表检测。前端根据 `sql.result` 事件中的数据结构判断：如果列名包含日期类型 + 数值类型，展示折线图选项。问题 3（收盘价趋势图）的日期+价格数据由 ECharts 画折线图。

### 双语

- UI 文案（按钮、占位符）用 i18n JSON 文件切换
- 对话内容语言由用户输入决定，Explore 自动适配

## 迭代策略

先跑通 → 测试 6 类问题 → 针对性处理。

1. 先用当前架构（后端透传）把 6 类问题全跑一遍
2. 哪个问题效果不好，针对性在后端 preProcess/postProcess 加适配
3. 如果是 Explore 引擎本身的能力问题，再考虑改 moi-core 代码

可能需要后续处理的点：
- 非标日期格式（SAS `02JAN2025:09:20:00`）→ 在 schema comment 标注或 preProcess 注入提示
- 复杂 SQL（50日均线、连续天数）→ 测试 Explore 效果，不行则后端兜底
- 跨表日期 JOIN → 可能需要建视图统一日期列

## 数据源

7 张表，全部在 MatrixOne hk_sfc 库中：

| 表 | 用途 | 行数 |
|---|---|---|
| ms_t_stk_hsi | 恒生指数 | 3.2M |
| ms_t_stk_sis | 个股行情 | 4M |
| ms_v_stock_capital | 月末市值 | 1.2M |
| ds_t_int_hsicl_dtl | 行业分类 | 350K |
| sehknews | 新闻公告 | 200K |
| profit_loss | 利润表 | 26K |
| ccass_holdings | CCASS 持仓 | 按需爬取 |

## 部署

```
docker-compose.yaml  → POC Catalog (8082) + Workers
config/catalog.toml  → 连 MO (host.docker.internal:16001)
server/              → Go 后端 (8083)
web/                 → React 前端 (3000)
```

初始化：`bash scripts/04_init_poc_env.sh`
