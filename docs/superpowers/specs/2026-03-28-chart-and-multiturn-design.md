# 图表支持 + 多轮对话修复 设计文档

## 概述

HK SFC POC 当前存在两个设计缺陷：
1. 用户请求图表时，Explore 引擎回复"我无法生成图表"，且前端只支持时序折线图
2. 多轮对话上下文丢失，用户说"这些股票"时系统无法解析引用

本文档描述 POC 范围内的解决方案。

## 问题根因

### 图表

用户问题中包含两个独立意图：**数据意图**（查什么数据）和**可视化意图**（怎么展示）。当前系统把两者混在一起发给 Explore 引擎，导致：

- Explore Synthesizer（LLM）看到"柱状图"等词，回复"我无法生成图表"
- 前端 `Chart.tsx` 硬编码时序折线图假设：必须有日期列、只支持 `type: 'line'`
- 分类数据（股票代码作 x 轴）完全无法渲染图表

### 多轮对话

- Go 后端 `ExploreOptions` 不含 `Memory` 字段，`EnableResultContext` 被 Go 零值覆盖为 `false`，导致上轮查询的 SQL/列名/样本数据不存储
- moi-core `orchestrator.buildBaseParams()` 未将 `is_follow_up` 和 `result_context` 注入 SQL retriever params，`sql.go` 中已有的 follow-up SQL 生成链路断开

## 方案

### 一、图表支持

#### 1.1 moi-core Planner 扩展（dev-poc-fix 分支）

**字段归属层级**：`PresentationSpec` 作为 `IntentOutputSpec` 的子字段存在，在 Step1 schema 中位于 `intent_frame.output_spec.presentation`。数据流路径统一为：Step1 LLM 输出 → `draft.IntentFrame.OutputSpec.Presentation` → `UnifiedPlan.IntentFrame` → `planning.plan.ready` SSE payload。

**`explore/planner/types.go`** — `IntentOutputSpec` 新增 `Presentation *PresentationSpec` 字段：

```go
type PresentationSpec struct {
    ChartType   string   `json:"chart_type"`            // "bar"|"line"|"pie"|"auto"|"none"
    XField      string   `json:"x_field,omitempty"`
    YFields     []string `json:"y_fields,omitempty"`
    SeriesField string   `json:"series_field,omitempty"`
    DisplayMode string   `json:"display_mode"`           // "chart"|"table"|"both"
}
```

语义约定（统一规则，前后端一致）：
- `chart_type=none` — 用户明确说"不要图表"，前端禁用图表（包括跳过 canRenderChart fallback）
- `chart_type=auto` 或 chartSpec 缺失 — 行为一致：前端走 canRenderChart() fallback heuristics 自行判断
- `chart_type` 为 bar/line/pie — 明确图表类型，前端按 spec 渲染
- Go 后端 fallback 规则仅在 `planning.plan.ready` 不含 presentation 时生效，此时后端从 sql.result 推断 ChartSpec 并设 `chart_type=auto`，最终仍由前端 fallback 决定

**`explore/planner/schema.go`** — 两处改动：
- Step1 JSON schema（通用分支 `Step1JSONSchema`）的 `output_spec.properties` 下新增 `presentation` 定义
- `Step1Response` 解析结构体（`ParseStep1Response`）同步支持 presentation 字段

**`explore/planner/planner.go`** — 四处改动：
- SQL-only Step1 解析结构体（~L252）新增 `presentation` 字段
- SQL-only Step1 prompt schema 定义（~L1262 附近）新增 presentation
- `buildStep1SQLPrompt()`（~L1102）新增 presentation 提取说明
- `buildStep1GenericPrompt()` 新增 presentation 提取说明（通用分支一致性）

Prompt 指导 LLM：
- 从用户问题中提取可视化意图（"柱状图"→bar，"走势"→line，"占比"→pie）
- 未提及可视化时 `chart_type` 设为 `"auto"`

**`explore/planner/intent_frame.go`** — `cloneIntentFrame()` 和 `normalizeIntentFrame()` 同步处理 `Presentation` 字段。

**`explore/engine/orchestrator.go`** — `planning.plan.ready` SSE 事件（~L359）payload 扩展，直接带 `presentation` 字段。这是 Go 后端获取 presentation 的唯一来源，不依赖 trace 或其他事件。

**`explore/engine/orchestrator.go` ~L9289 + `explore/engine/engine.go` ~L1374 + `explore/trace/analysis.go` + `explore/config/response.go`** — plan-analysis 映射链和 trace 分析结构同步保留 presentation 字段。

#### 1.2 moi-core Synthesizer 改动

防止 Synthesizer 说"我不能画图"需要两层保障：

**第一层：Presentation Context 提示注入**

当 presentation 存在且 `chart_type` 为 bar/line/pie 时，在 Synthesizer 的 user content 中注入提示（`auto` 和 `none` 不注入）：

```
=== Presentation Context ===
A bar chart will be rendered by the client alongside this response.
Focus on data analysis. Do not mention chart generation capabilities or limitations.
```

实现方式：
- `explore/engine/orchestrator.go` 或 `engine.go`：在构造 retrieval results 传给 synthesizer 时，将 `PresentationSpec` 附加为 result metadata
- `explore/synthesizer/prompt.go`：`buildUserContentWithSlots()` 中新增 `extractPresentationPromptHints(results)`，从 metadata 提取并渲染上述提示

**第二层：Synthesizer 使用的 question 处理**

当前 Synthesizer 使用原始 `req.Query.Question`（见 `engine.go:262`, `prompt.go:64`），`rewrite_queries` 仅用于 SQL retriever。因此单靠 rewrite 去掉图表词不能阻止 Synthesizer 看到"柱状图"。

POC 中不改 Synthesizer 的 question 来源，**依赖 Presentation Context 提示**引导 LLM 不发表图表能力相关言论。如果实测中 LLM 仍然说"我不能画图"，则追加改动：让 Synthesizer 使用 `rewrite_queries[0]`（已去掉图表词）替代原始 question。

#### 1.3 Go 后端改动（HK_POC）

**`backend/handler.go`** — SSE 处理重构：

当前 `bufio.Scanner` 按行扫描 + `postProcess(string) string` 的模式无法跨行收集状态和注入事件。改为：

```go
type EventProcessor struct {
    presentation *PresentationSpec // 从 planning.plan.ready 提取
    sqlResults   []SQLResultMeta   // 累积的 sql.result 元信息
    chartSent    bool              // 防重：chart.recommendation 只发一次
    downstreamSeq int              // 下游自管 seq 计数器
}
```

处理流程：
1. 解析完整 SSE event block（`event:` + `data:` 行组合）
2. `processEvent(event) → []outputEvent`
3. 所有对外事件由 EventProcessor 统一发射，重新编号 seq（严格单调递增）
4. 收到 `planning.plan.ready` → 提取 `data.presentation`
5. 收到 `sql.result` → 累积 `round_index`、columns 等元信息
6. 检测到 `synthesis.done` → 先注入 `chart.recommendation`（如有 presentation + sqlResult），再发 `synthesis.done`
7. Fallback：如果 `planning.plan.ready` 没有 presentation（旧版引擎），从 sql.result 用规则推断基础 ChartSpec

**`chart.recommendation` 事件格式**：

```json
{
  "event": "chart.recommendation",
  "data": {
    "chart_type": "bar",
    "x": { "field": "SISTKC", "label": "股票代码", "type": "category" },
    "y": [{ "field": "SICLSE", "label": "收盘价(HKD)" }],
    "display_mode": "both",
    "round_index": 0
  }
}
```

`round_index` 使用上游 `sql.result` 中已有的稳定键，不使用数组下标。

#### 1.4 前端改动（HK_POC）

**`web/src/types.ts`**：

```typescript
export interface ChartSpec {
  chart_type: 'bar' | 'line' | 'pie' | 'auto' | 'none'
  x?: { field: string; label: string; type: 'category' | 'time' }
  y?: { field: string; label: string }[]
  display_mode?: 'chart' | 'table' | 'both'
  round_index?: number
}

export interface SQLResult {
  columns: string[]
  rows: any[][]
  sql?: string
  total_count?: number
  round_index?: number  // 新增：稳定关联键
}

export interface Message {
  // ... 现有字段
  chartSpec?: ChartSpec  // 新增
}
```

**`web/src/hooks/useExploreSSE.ts`**：
- `sql.result` 处理中保存 `round_index`
- 新增 `chart.recommendation` case，解析为 `msg.chartSpec`

**`web/src/components/MessageBubble.tsx`**：
- 有 `chartSpec` → 按 `round_index` 找对应 sqlResult，按 spec 渲染
- `chartSpec.chart_type === 'none'` → 跳过图表，不走 canRenderChart
- 无 `chartSpec` → 走现有 `canRenderChart()` fallback（向后兼容）

**`web/src/components/Chart.tsx`**：
- 重构为配置驱动：接收 `ChartSpec` + `SQLResult` 渲染
- 支持 line（已有）、bar（新增）、pie（新增）
- 支持分类轴（stock code、industry name 作 x 轴），不再强制要求日期列
- 无 ChartSpec 时保留现有 `canRenderChart()` 自动检测逻辑作为 fallback

### 二、多轮对话修复

#### 2.1 Go 后端

**`backend/explore.go`** — `ExploreOptions` 新增 `Memory` 字段：

```go
type MemoryConfig struct {
    EnableResultContext bool `json:"enable_result_context,omitempty"`
    EnableSummary       bool `json:"enable_summary,omitempty"`
}

type ExploreOptions struct {
    PlanningMode string       `json:"planning_mode,omitempty"`
    Verbose      string       `json:"verbose,omitempty"`
    LLM          *LLMConfig   `json:"llm,omitempty"`
    Memory       *MemoryConfig `json:"memory,omitempty"`  // 新增
}
```

**`backend/handler.go`** — 构造 ExploreRequest 时设置：

```go
Memory: &MemoryConfig{
    EnableResultContext: true,
    EnableSummary:       true,
},
```

#### 2.2 moi-core orchestrator

**`explore/engine/orchestrator.go`** — `buildBaseParams()`（~L4575）注入 planner 产出的 `is_follow_up` 和 history 中的 `result_context` 到 retriever params map：

```go
if plan.UnifiedPlan.IsFollowUp {
    params["is_follow_up"] = true
}
if history.ResultContext != nil {
    params["result_context"] = history.ResultContext
}
```

需调整 `buildBaseParams` 签名或取值来源，使其能访问 plan 输出。

这将打通 `sql.go` 中已有的 `isFollowUp()` → `generateFollowUpSQLAtTemperature()` 链路。

## 不做（POC 范围外）

- K 线图 / 双轴组合图 / 事件标注 / 分面小图
- visual_only 零检索路径（POC 用 follow-up 重查代替）
- 归一化 / 数据重采样
- 前端高级图表交互（缩放、导出等超出 ECharts 默认能力的）
- 多粒度展示（年度+季度同时展示）

## 实现约束

以下约束经 Codex (GPT-5.4) 多轮 review 确认：

1. **EventProcessor 必须接管所有对外事件的发射**，不能混用透传和改写，否则 seq 会错乱
2. **`round_index` 在所有相关事件里保持同一语义**，不能有的表示 planner round、有的表示 result array index
3. **`chart.recommendation` 只引用 `round_index`**，不隐含依赖到达顺序或 seq
4. **moi-core 中 `presentation` 必须同时改 SQL-only 分支**，HK_POC 是 tables-only 场景，走 SQL-only Step1 路径，不走通用 Step1JSONSchema

## 改动清单

### moi-core（dev-poc-fix 分支，13 处）

| # | 文件 | 改动 |
|---|------|------|
| 1 | `explore/planner/types.go` | IntentOutputSpec 新增 `Presentation *PresentationSpec` |
| 2 | `explore/planner/schema.go` | Step1JSONSchema `output_spec.properties` 新增 presentation；`ParseStep1Response` 同步支持 |
| 3 | `explore/planner/planner.go` ~L252 | SQL-only Step1 解析结构体新增 presentation |
| 4 | `explore/planner/planner.go` ~L1102 | buildStep1SQLPrompt 新增 presentation 说明 |
| 5 | `explore/planner/planner.go` ~L1262 | SQL-only prompt schema 定义新增 presentation |
| 6 | `explore/planner/planner.go` buildStep1GenericPrompt | 通用分支同步新增 presentation 说明 |
| 7 | `explore/planner/intent_frame.go` | cloneIntentFrame + normalizeIntentFrame 同步 presentation |
| 8 | `explore/engine/orchestrator.go` ~L359 | planning.plan.ready payload 带 presentation |
| 9 | `explore/engine/orchestrator.go` ~L4575 | buildBaseParams 注入 is_follow_up + result_context |
| 10 | `explore/engine/orchestrator.go` 或 `engine.go` | 构造 synthesizer results 时附加 presentation 为 metadata |
| 11 | `explore/synthesizer/prompt.go` | buildUserContentWithSlots 新增 extractPresentationPromptHints |
| 12 | `explore/engine/orchestrator.go` ~L9289 + `engine.go` ~L1374 | plan-analysis 映射保留 presentation |
| 13 | `explore/trace/analysis.go` + `explore/config/response.go` | trace/分析结构扩展 presentation 字段 |

### HK_POC 后端（3 处）

| # | 文件 | 改动 |
|---|------|------|
| 1 | `backend/explore.go` | ExploreOptions 新增 Memory 字段 + MemoryConfig 类型 |
| 2 | `backend/handler.go` | SSE 处理改为 EventProcessor（按事件解析 + 状态累积 + chart.recommendation 注入 + 下游 seq 自管） |
| 3 | `backend/handler.go` | 构造请求设 EnableResultContext=true, EnableSummary=true |

### HK_POC 前端（4 处）

| # | 文件 | 改动 |
|---|------|------|
| 1 | `web/src/types.ts` | Message 新增 chartSpec，SQLResult 新增 round_index，新增 ChartSpec 类型 |
| 2 | `web/src/hooks/useExploreSSE.ts` | sql.result 保存 round_index，新增 chart.recommendation case |
| 3 | `web/src/components/MessageBubble.tsx` | chartSpec 优先渲染，none 跳过，缺失走 fallback |
| 4 | `web/src/components/Chart.tsx` | 配置驱动重构，支持 line/bar/pie + 分类轴 |

## 场景覆盖验证

| 场景 | 处理方式 | 覆盖 |
|------|---------|------|
| "收盘价，展示为柱状图" | Planner 提取 chart=bar，Presentation Context 提示 Synthesizer 不提图表能力，正常 SQL + chart.recommendation | ✓ |
| "恒生指数走势" | Planner 提取 chart=line（隐含），正常 SQL + chart.recommendation | ✓ |
| "各行业市值占比" | Planner 提取 chart=pie，SQL 含 GROUP BY + chart.recommendation | ✓ |
| "画个柱状图"（对上轮数据） | follow-up 重查 + chart.recommendation(bar) | ✓ |
| "改成饼图" | follow-up 重查 + chart.recommendation(pie) | ✓ |
| "不要图表，只要表格" | Planner 提取 chart=none，前端跳过图表 | ✓ |
| "按行业汇总画饼图" | follow-up 新 SQL（GROUP BY）+ chart.recommendation(pie) | ✓ |
| "加上50日均线" | follow-up 新 SQL（新增计算列）+ chart.recommendation(line) | ✓ |
| "哪只股票市值最大" | chart=auto → 前端 canRenderChart fallback 判定（单值结果不画图） | ✓ |
| Synthesizer 不说"我不能画图" | Presentation Context 提示引导 LLM；必要时追加让 Synthesizer 用 rewrite question | ✓ |
| "这些股票在2025年9月属于什么行业" | EnableResultContext=true + is_follow_up 注入，Planner 解析上下文 | ✓ |
| "那超过3%的呢" | follow-up SQL 重写，修改条件 | ✓ |

## 审阅记录

本方案经过 6 轮 Codex (GPT-5.4) 独立 review，最终确认"设计方案可行，可以进入实现"。关键修正包括：
- presentation 必须通过 `planning.plan.ready` SSE 事件显式暴露，不靠 trace
- Go 后端 SSE 处理必须从按行扫描改为按事件解析（EventProcessor）
- 结果关联使用 `round_index` 稳定键，不用数组下标
- SQL-only Step1 分支必须同步改动（HK_POC 走此路径）
- 下游 seq 由 EventProcessor 自管，不复用上游 seq
