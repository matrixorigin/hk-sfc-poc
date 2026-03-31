# 图表支持 + 多轮对话修复 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户能通过对话请求图表（bar/line/pie），修复多轮对话上下文丢失问题。

**Architecture:** moi-core Planner 提取可视化意图（presentation_spec）→ 通过 planning.plan.ready SSE 事件暴露 → Go 后端 EventProcessor 收集并注入 chart.recommendation → 前端按 ChartSpec 渲染。多轮对话通过补上 Memory 配置 + 注入 is_follow_up 到 SQL retriever 修复。

**Tech Stack:** Go (moi-core + HK_POC backend), TypeScript/React (HK_POC frontend), ECharts

**Spec:** `docs/superpowers/specs/2026-03-28-chart-and-multiturn-design.md`

**两个代码仓库：**
- moi-core POC 分支：`/tmp/moi-core-dev-poc-fix/moi-core`
- HK_POC：`/Users/zhangqq/Documents/pythonProject/HK_POC`

---

## Phase 1: moi-core Planner 扩展

### Task 1: PresentationSpec 类型定义

**Files:**
- Modify: `/tmp/moi-core-dev-poc-fix/moi-core/explore/planner/types.go:102-105`

- [ ] **Step 1: 在 IntentOutputSpec 中新增 Presentation 字段**

```go
// IntentOutputSpec defines deterministic output requirements.
type IntentOutputSpec struct {
	TopK             int               `json:"top_k,omitempty"`
	CitationRequired bool              `json:"citation_required,omitempty"`
	Presentation     *PresentationSpec `json:"presentation,omitempty"`
}

// PresentationSpec describes the client-side visualization intent extracted by the planner.
type PresentationSpec struct {
	ChartType   string   `json:"chart_type"`             // "bar"|"line"|"pie"|"auto"|"none"
	XField      string   `json:"x_field,omitempty"`      // x-axis field name hint
	YFields     []string `json:"y_fields,omitempty"`     // y-axis field name hints
	SeriesField string   `json:"series_field,omitempty"` // grouping field (optional)
	DisplayMode string   `json:"display_mode,omitempty"` // "chart"|"table"|"both" (default "both")
}
```

- [ ] **Step 2: 验证编译**

Run: `cd /tmp/moi-core-dev-poc-fix/moi-core && go build ./explore/planner/...`
Expected: 编译成功

- [ ] **Step 3: Commit**

```bash
cd /tmp/moi-core-dev-poc-fix/moi-core
git add explore/planner/types.go
git commit -m "feat(planner): add PresentationSpec to IntentOutputSpec"
```

---

### Task 2: intent_frame.go — clone 和 normalize 同步 Presentation

**Files:**
- Modify: `/tmp/moi-core-dev-poc-fix/moi-core/explore/planner/intent_frame.go`

- [ ] **Step 1: 修改 cloneIntentFrame 拷贝 Presentation**

在 `cloneIntentFrame()` 中（~L298），在构造 `out` 时同步拷贝 Presentation：

```go
out := &IntentFrame{
	TaskType: frame.TaskType,
	OutputSpec: IntentOutputSpec{
		TopK:             frame.OutputSpec.TopK,
		CitationRequired: frame.OutputSpec.CitationRequired,
		Presentation:     clonePresentationSpec(frame.OutputSpec.Presentation),
	},
}
```

新增辅助函数：

```go
func clonePresentationSpec(p *PresentationSpec) *PresentationSpec {
	if p == nil {
		return nil
	}
	out := *p
	if len(p.YFields) > 0 {
		out.YFields = make([]string, len(p.YFields))
		copy(out.YFields, p.YFields)
	}
	return &out
}
```

- [ ] **Step 2: 修改 normalizeIntentFrame 保留 Presentation**

在 `normalizeIntentFrame()` 末尾处理 OutputSpec 的代码块（~L280-287）后追加：

```go
out.OutputSpec.Presentation = normalizePresentationSpec(frame.OutputSpec.Presentation)
```

新增辅助函数：

```go
func normalizePresentationSpec(p *PresentationSpec) *PresentationSpec {
	if p == nil {
		return nil
	}
	ct := strings.ToLower(strings.TrimSpace(p.ChartType))
	switch ct {
	case "bar", "line", "pie", "none":
		// valid explicit types
	default:
		ct = "auto"
	}
	dm := strings.ToLower(strings.TrimSpace(p.DisplayMode))
	switch dm {
	case "chart", "table", "both":
		// valid
	default:
		dm = "both"
	}
	return &PresentationSpec{
		ChartType:   ct,
		XField:      strings.TrimSpace(p.XField),
		YFields:     p.YFields,
		SeriesField: strings.TrimSpace(p.SeriesField),
		DisplayMode: dm,
	}
}
```

- [ ] **Step 3: 验证编译**

Run: `cd /tmp/moi-core-dev-poc-fix/moi-core && go build ./explore/planner/...`

- [ ] **Step 4: Commit**

```bash
git add explore/planner/intent_frame.go
git commit -m "feat(planner): clone and normalize PresentationSpec in IntentFrame"
```

---

### Task 3: SQL-only Step1 解析和 prompt 新增 presentation

**Files:**
- Modify: `/tmp/moi-core-dev-poc-fix/moi-core/explore/planner/planner.go`

- [ ] **Step 1: SQL-only Step1 解析结构体新增 presentation 字段**

在 `planner.go` ~L254 的 `var raw struct` 中新增：

```go
var raw struct {
	IsFollowUp   bool               `json:"is_follow_up"`
	QuestionType string             `json:"question_type"`
	RewriteQuery string             `json:"rewrite_query"`
	Presentation *PresentationSpec  `json:"presentation,omitempty"`
}
```

在解析 raw 后赋值给 draft 的代码中（~L270 附近），添加：

```go
if raw.Presentation != nil {
	draft.IntentFrame = &IntentFrame{
		OutputSpec: IntentOutputSpec{
			Presentation: raw.Presentation,
		},
	}
}
```

- [ ] **Step 2: SQL-only system prompt 新增 presentation 说明**

修改 `step1SQLSystemPrompt` 常量（~L1262），在 JSON 输出说明中新增 presentation 字段：

将末尾的：
```
Respond ONLY with: {"is_follow_up": bool, "question_type": "...", "rewrite_query": "..."}
```

改为：
```
## presentation (object, optional)
If the user explicitly or implicitly requests a visualization, include this field.
- chart_type: "bar" for bar/column charts, "line" for trends/time series, "pie" for proportions/distribution, "none" if user says no chart, "auto" if uncertain
- x_field: hint for x-axis column name (e.g. "SISTKC" for stock code)
- y_fields: list of y-axis column names (e.g. ["SICLSE"] for closing price)
- display_mode: "chart", "table", or "both" (default "both")
Examples of implicit visualization: "趋势/走势" → line, "占比/分布" → pie, "对比" → bar
If no visualization is mentioned or implied, omit this field entirely.

Respond ONLY with: {"is_follow_up": bool, "question_type": "...", "rewrite_query": "...", "presentation": {...} or omitted}
```

- [ ] **Step 3: buildStep1SQLPrompt 无需改动**

`buildStep1SQLPrompt()` 只拼装 question + history，不涉及 schema。presentation 的提取通过 system prompt 指导 LLM 输出 JSON 实现。无需修改此函数。

- [ ] **Step 4: 通用分支 buildStep1GenericPrompt 一致性**

如果通用分支也需要 presentation，在 `schema.go` 的 `Step1JSONSchema` 中 `output_spec.properties` 里追加：

```json
"presentation": {
  "type": "object",
  "properties": {
    "chart_type": { "type": "string", "enum": ["bar", "line", "pie", "auto", "none"] },
    "x_field": { "type": "string" },
    "y_fields": { "type": "array", "items": { "type": "string" } },
    "series_field": { "type": "string" },
    "display_mode": { "type": "string", "enum": ["chart", "table", "both"] }
  }
}
```

同时修改 `"additionalProperties": false` 所在的 output_spec 对象，确保新字段被允许。

在 `buildStep1GenericPrompt()` 中（~L1135 附近），在 `## JSON Schema` 前添加与 SQL-only prompt 相同的 `## presentation` 说明段。

- [ ] **Step 5: 验证编译**

Run: `cd /tmp/moi-core-dev-poc-fix/moi-core && go build ./explore/planner/...`

- [ ] **Step 6: Commit**

```bash
git add explore/planner/planner.go explore/planner/schema.go
git commit -m "feat(planner): add presentation extraction to SQL-only and generic Step1"
```

---

### Task 4: planning.plan.ready SSE 事件带 presentation

**Files:**
- Modify: `/tmp/moi-core-dev-poc-fix/moi-core/explore/engine/orchestrator.go`

- [ ] **Step 1: 在 plan.ready payload 中添加 presentation**

在 `orchestrator.go` ~L359 的 `pipeline.Emit(stream.EventPlanReady, ...)` 中，添加 presentation 字段：

```go
if pipeline != nil {
	payload := map[string]any{
		"intent":               unifiedIntentString(plan),
		"activated_retrievers": unifiedActivatedRetrievers(plan),
		"fusion_strategy":      string(up.FusionStrategy),
		"question_type":        string(up.QuestionType),
		"adaptive_rag_top_k":   up.AdaptiveTopK,
		"unified_plan_mode":    string(up.Mode),
		"unified_plan_steps":   len(up.Nodes),
	}
	// Expose presentation spec for downstream chart rendering.
	if up.IntentFrame != nil && up.IntentFrame.OutputSpec.Presentation != nil {
		payload["presentation"] = up.IntentFrame.OutputSpec.Presentation
	}
	pipeline.Emit(stream.EventPlanReady, payload)
}
```

- [ ] **Step 2: 验证编译**

Run: `cd /tmp/moi-core-dev-poc-fix/moi-core && go build ./explore/engine/...`

- [ ] **Step 3: Commit**

```bash
git add explore/engine/orchestrator.go
git commit -m "feat(orchestrator): expose presentation in planning.plan.ready SSE event"
```

---

### Task 5: buildBaseParams 注入 is_follow_up + result_context

**Files:**
- Modify: `/tmp/moi-core-dev-poc-fix/moi-core/explore/engine/orchestrator.go`

- [ ] **Step 1: 找到 orchestrate 中调用 buildBaseParams 的位置**

在 orchestrate 函数中，找到 `baseParams := buildBaseParams(req)` 的调用点，在其之后追加：

```go
baseParams := buildBaseParams(req)
// Inject follow-up context for SQL retriever.
if plan != nil && plan.UnifiedPlan != nil && plan.UnifiedPlan.IsFollowUp {
	baseParams["is_follow_up"] = true
}
if history != nil && history.ResultContext != nil {
	baseParams["result_context"] = history.ResultContext
}
```

注意：需要确认 `history` 变量在此作用域可用。如果 buildBaseParams 在 orchestrate 内部被调用，history 应该已经加载。

- [ ] **Step 2: 验证编译**

Run: `cd /tmp/moi-core-dev-poc-fix/moi-core && go build ./explore/engine/...`

- [ ] **Step 3: Commit**

```bash
git add explore/engine/orchestrator.go
git commit -m "feat(orchestrator): inject is_follow_up and result_context into retriever params"
```

---

### Task 6: Synthesizer Presentation Context 提示注入

**Files:**
- Modify: `/tmp/moi-core-dev-poc-fix/moi-core/explore/synthesizer/prompt.go`
- Modify: `/tmp/moi-core-dev-poc-fix/moi-core/explore/engine/orchestrator.go` 或 `engine.go`

- [ ] **Step 1: 在 orchestrator/engine 中将 presentation 附加到 retrieval results metadata**

在 synthesizer 被调用之前，将 presentation spec 附加到 results 中。找到构造 `synthReq` 或调用 `Synthesize()` 的地方，在 results 的第一个元素的 Metadata 中注入：

```go
// Attach presentation spec as metadata for synthesizer prompt hints.
if plan.UnifiedPlan != nil && plan.UnifiedPlan.IntentFrame != nil {
	if ps := plan.UnifiedPlan.IntentFrame.OutputSpec.Presentation; ps != nil {
		if len(results) > 0 {
			if results[0].Metadata == nil {
				results[0].Metadata = make(map[string]any)
			}
			results[0].Metadata["presentation_spec"] = ps
		}
	}
}
```

- [ ] **Step 2: 在 prompt.go 的 buildUserContentWithSlots 中提取 presentation hints**

在 `buildUserContentWithSlots()` 函数中，在 `strategyHints := extractStrategyPromptHints(results)` 之后，添加：

```go
// Presentation context: tell synthesizer that a chart will be rendered by the client.
if presHint := extractPresentationPromptHint(results); presHint != "" {
	b.WriteString(presHint)
	b.WriteString("\n\n")
}
```

新增辅助函数：

```go
// extractPresentationPromptHint generates a prompt hint when a chart will be rendered.
func extractPresentationPromptHint(results []retriever.ScoredResult) string {
	for _, r := range results {
		if r.Metadata == nil {
			continue
		}
		ps, ok := r.Metadata["presentation_spec"]
		if !ok {
			continue
		}
		spec, ok := ps.(*planner.PresentationSpec)
		if !ok {
			continue
		}
		switch spec.ChartType {
		case "bar", "line", "pie":
			return fmt.Sprintf("=== Presentation Context ===\nA %s chart will be rendered by the client alongside this response.\nFocus on data analysis. Do not mention chart generation capabilities or limitations.\n", spec.ChartType)
		}
		break
	}
	return ""
}
```

注意：需要导入 planner 包。如果循环依赖，可以用 `map[string]any` 代替 `*planner.PresentationSpec`，在 extractPresentationPromptHint 中做 type assertion。

- [ ] **Step 3: 验证编译**

Run: `cd /tmp/moi-core-dev-poc-fix/moi-core && go build ./explore/...`

- [ ] **Step 4: Commit**

```bash
git add explore/synthesizer/prompt.go explore/engine/orchestrator.go
git commit -m "feat(synthesizer): inject presentation context hint to prevent 'cannot generate chart' responses"
```

---

### Task 7: Trace/Analysis 结构保留 presentation

**Files:**
- Modify: `/tmp/moi-core-dev-poc-fix/moi-core/explore/trace/analysis.go`
- Modify: `/tmp/moi-core-dev-poc-fix/moi-core/explore/config/response.go`
- Modify: `/tmp/moi-core-dev-poc-fix/moi-core/explore/engine/orchestrator.go` (trace summary 构造)
- Modify: `/tmp/moi-core-dev-poc-fix/moi-core/explore/engine/engine.go` (plan analysis 映射)

- [ ] **Step 1: trace/analysis.go 扩展 IntentOutputSpecSummary**

```go
type IntentOutputSpecSummary struct {
	TopK             int                    `json:"top_k,omitempty"`
	CitationRequired bool                   `json:"citation_required,omitempty"`
	Presentation     map[string]any         `json:"presentation,omitempty"`
}
```

- [ ] **Step 2: config/response.go 扩展 IntentOutputSpecAnalysis**

找到 `IntentOutputSpecAnalysis`（如果存在），或在 `IntentFrameAnalysis` 中直接添加 `Presentation` 字段：

```go
type IntentFrameAnalysis struct {
	TaskType        string                    `json:"task_type,omitempty"`
	AxisCount       int                       `json:"axis_count,omitempty"`
	ConstraintCount int                       `json:"constraint_count,omitempty"`
	Axes            []IntentAxisAnalysis      `json:"axes,omitempty"`
	HardConstraints []string                  `json:"hard_constraints,omitempty"`
	OutputSpec      *IntentOutputSpecAnalysis `json:"output_spec,omitempty"`
	Presentation    map[string]any            `json:"presentation,omitempty"`
}
```

- [ ] **Step 3: orchestrator 和 engine 中映射时保留 presentation**

在构造 `PlanSummary` 和 `PlanAnalysis` 时，如果 IntentFrame 有 Presentation，转换为 map[string]any 保存。

- [ ] **Step 4: 验证编译**

Run: `cd /tmp/moi-core-dev-poc-fix/moi-core && go build ./...`

- [ ] **Step 5: Commit**

```bash
git add explore/trace/analysis.go explore/config/response.go explore/engine/orchestrator.go explore/engine/engine.go
git commit -m "feat(trace): preserve presentation spec in trace summary and plan analysis"
```

---

## Phase 2: HK_POC 后端改动

### Task 8: ExploreOptions 补 Memory 配置

**Files:**
- Modify: `/Users/zhangqq/Documents/pythonProject/HK_POC/backend/explore.go`
- Modify: `/Users/zhangqq/Documents/pythonProject/HK_POC/backend/handler.go`

- [ ] **Step 1: explore.go 新增 MemoryConfig 类型和字段**

在 `ExploreOptions` 结构体后添加：

```go
type MemoryConfig struct {
	EnableResultContext bool `json:"enable_result_context,omitempty"`
	EnableSummary       bool `json:"enable_summary,omitempty"`
}
```

修改 ExploreOptions：

```go
type ExploreOptions struct {
	PlanningMode string        `json:"planning_mode,omitempty"`
	Verbose      string        `json:"verbose,omitempty"`
	LLM          *LLMConfig    `json:"llm,omitempty"`
	Memory       *MemoryConfig `json:"memory,omitempty"`
}
```

- [ ] **Step 2: handler.go 构造请求时设置 Memory**

在 `handler.go` ~L119 构造 ExploreRequest 的 Options 中添加：

```go
Options: ExploreOptions{
	PlanningMode: h.cfg.Explore.PlanningMode,
	Verbose:      h.cfg.Explore.Verbose,
	Memory: &MemoryConfig{
		EnableResultContext: true,
		EnableSummary:       true,
	},
},
```

- [ ] **Step 3: 验证编译**

Run: `cd /Users/zhangqq/Documents/pythonProject/HK_POC/backend && go build ./...`

- [ ] **Step 4: Commit**

```bash
cd /Users/zhangqq/Documents/pythonProject/HK_POC
git add backend/explore.go backend/handler.go
git commit -m "feat(backend): add Memory config to enable multi-turn result context"
```

---

### Task 9: EventProcessor — SSE 事件处理重构

**Files:**
- Create: `/Users/zhangqq/Documents/pythonProject/HK_POC/backend/event_processor.go`
- Modify: `/Users/zhangqq/Documents/pythonProject/HK_POC/backend/handler.go`

- [ ] **Step 1: 创建 event_processor.go**

```go
package main

import (
	"encoding/json"
	"fmt"
	"strings"
)

// SSEEvent represents a parsed SSE event block.
type SSEEvent struct {
	EventType string
	Data      string
}

// ChartRecommendation is the chart.recommendation event payload.
type ChartRecommendation struct {
	ChartType   string         `json:"chart_type"`
	X           *ChartAxisSpec `json:"x,omitempty"`
	Y           []ChartAxisSpec `json:"y,omitempty"`
	DisplayMode string         `json:"display_mode,omitempty"`
	RoundIndex  int            `json:"round_index"`
}

// ChartAxisSpec describes a chart axis field.
type ChartAxisSpec struct {
	Field string `json:"field"`
	Label string `json:"label"`
	Type  string `json:"type,omitempty"` // "category" or "time"
}

// PresentationSpec mirrors the moi-core PresentationSpec for JSON parsing.
type PresentationSpec struct {
	ChartType   string   `json:"chart_type"`
	XField      string   `json:"x_field,omitempty"`
	YFields     []string `json:"y_fields,omitempty"`
	SeriesField string   `json:"series_field,omitempty"`
	DisplayMode string   `json:"display_mode,omitempty"`
}

// SQLResultMeta stores metadata from a sql.result event.
type SQLResultMeta struct {
	RoundIndex int      `json:"round_index"`
	Columns    []string `json:"columns"`
}

// EventProcessor processes upstream SSE events, injects chart.recommendation,
// and manages downstream seq numbering.
type EventProcessor struct {
	presentation *PresentationSpec
	sqlResults   []SQLResultMeta
	chartSent    bool
	nextSeq      int
}

// NewEventProcessor creates an EventProcessor.
func NewEventProcessor() *EventProcessor {
	return &EventProcessor{nextSeq: 1}
}

// ProcessEvent takes an upstream SSE event and returns 0..N downstream events.
func (ep *EventProcessor) ProcessEvent(evt SSEEvent) []SSEEvent {
	// Extract state from specific event types.
	switch evt.EventType {
	case "planning.plan.ready", "planning.rewrite.ready":
		ep.extractPresentation(evt.Data)
	case "sql.result":
		ep.extractSQLResultMeta(evt.Data)
	}

	// Before synthesis.done, inject chart.recommendation if we have enough info.
	if evt.EventType == "synthesis.done" && !ep.chartSent {
		var out []SSEEvent
		if chartEvt := ep.buildChartRecommendation(); chartEvt != nil {
			out = append(out, ep.rewriteSeq(*chartEvt))
			ep.chartSent = true
		}
		out = append(out, ep.rewriteSeq(evt))
		return out
	}

	return []SSEEvent{ep.rewriteSeq(evt)}
}

func (ep *EventProcessor) extractPresentation(data string) {
	var payload struct {
		Data struct {
			Presentation *PresentationSpec `json:"presentation"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(data), &payload); err != nil {
		return
	}
	if payload.Data.Presentation != nil {
		ep.presentation = payload.Data.Presentation
	}
}

func (ep *EventProcessor) extractSQLResultMeta(data string) {
	var payload struct {
		Data struct {
			Columns    []string `json:"columns"`
			RoundIndex int      `json:"round_index"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(data), &payload); err != nil {
		return
	}
	ep.sqlResults = append(ep.sqlResults, SQLResultMeta{
		RoundIndex: payload.Data.RoundIndex,
		Columns:    payload.Data.Columns,
	})
}

func (ep *EventProcessor) buildChartRecommendation() *SSEEvent {
	if len(ep.sqlResults) == 0 {
		return nil
	}

	spec := ep.resolveChartSpec()
	if spec == nil || spec.ChartType == "none" {
		return nil
	}
	// auto means "let frontend decide" — still send the event so frontend gets round_index
	rec := ChartRecommendation{
		ChartType:   spec.ChartType,
		DisplayMode: spec.DisplayMode,
		RoundIndex:  ep.sqlResults[len(ep.sqlResults)-1].RoundIndex,
	}
	if spec.XField != "" {
		rec.X = &ChartAxisSpec{Field: spec.XField, Label: spec.XField, Type: "category"}
	}
	for _, yf := range spec.YFields {
		rec.Y = append(rec.Y, ChartAxisSpec{Field: yf, Label: yf})
	}

	dataBytes, _ := json.Marshal(rec)
	return &SSEEvent{
		EventType: "chart.recommendation",
		Data:      string(dataBytes),
	}
}

func (ep *EventProcessor) resolveChartSpec() *PresentationSpec {
	if ep.presentation != nil {
		return ep.presentation
	}
	// Fallback: no presentation from planner, return auto to let frontend decide.
	return &PresentationSpec{ChartType: "auto", DisplayMode: "both"}
}

func (ep *EventProcessor) rewriteSeq(evt SSEEvent) SSEEvent {
	// Rewrite the seq field in the data JSON to maintain downstream monotonic ordering.
	seq := ep.nextSeq
	ep.nextSeq++

	var parsed map[string]any
	if err := json.Unmarshal([]byte(evt.Data), &parsed); err != nil {
		// If data isn't valid JSON, pass through with seq in event line.
		return evt
	}
	parsed["seq"] = seq
	rewritten, _ := json.Marshal(parsed)
	evt.Data = string(rewritten)
	return evt
}

// ParseSSEEvents parses a raw SSE text block into individual events.
// SSE format: "event: <type>\ndata: <json>\n\n"
func ParseSSEEvents(block string) []SSEEvent {
	var events []SSEEvent
	lines := strings.Split(block, "\n")

	var currentType string
	var currentData strings.Builder

	for _, line := range lines {
		line = strings.TrimRight(line, "\r")
		if strings.HasPrefix(line, "event:") {
			currentType = strings.TrimSpace(line[6:])
		} else if strings.HasPrefix(line, "data:") {
			if currentData.Len() > 0 {
				currentData.WriteString("\n")
			}
			currentData.WriteString(strings.TrimSpace(line[5:]))
		} else if line == "" && currentType != "" {
			events = append(events, SSEEvent{
				EventType: currentType,
				Data:      currentData.String(),
			})
			currentType = ""
			currentData.Reset()
		}
	}
	// Handle trailing event without final newline.
	if currentType != "" && currentData.Len() > 0 {
		events = append(events, SSEEvent{
			EventType: currentType,
			Data:      currentData.String(),
		})
	}

	return events
}

// FormatSSEEvent formats an SSEEvent back to wire format.
func FormatSSEEvent(evt SSEEvent) string {
	return fmt.Sprintf("event: %s\ndata: %s\n\n", evt.EventType, evt.Data)
}
```

- [ ] **Step 2: 修改 handler.go 使用 EventProcessor**

替换 handler.go 中的 SSE 扫描循环（~L142-158）：

删除旧的 `preProcess` 和 `postProcess` 方法。

替换 SSE 处理部分：

```go
// 设置 SSE 响应头
w.Header().Set("Content-Type", "text/event-stream")
w.Header().Set("Cache-Control", "no-cache")
w.Header().Set("X-Accel-Buffering", "no")
w.WriteHeader(http.StatusOK)

flusher, canFlush := w.(http.Flusher)

ep := NewEventProcessor()
scanner := bufio.NewScanner(stream)
scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

var eventBuf strings.Builder
for scanner.Scan() {
	line := scanner.Text()
	eventBuf.WriteString(line)
	eventBuf.WriteString("\n")

	// SSE events are separated by blank lines.
	if strings.TrimSpace(line) == "" {
		raw := eventBuf.String()
		eventBuf.Reset()

		for _, parsed := range ParseSSEEvents(raw) {
			for _, out := range ep.ProcessEvent(parsed) {
				_, _ = io.WriteString(w, FormatSSEEvent(out))
				if canFlush {
					flusher.Flush()
				}
			}
		}
	}
}
// Flush any remaining buffered event.
if eventBuf.Len() > 0 {
	for _, parsed := range ParseSSEEvents(eventBuf.String()) {
		for _, out := range ep.ProcessEvent(parsed) {
			_, _ = io.WriteString(w, FormatSSEEvent(out))
			if canFlush {
				flusher.Flush()
			}
		}
	}
}
```

- [ ] **Step 3: 删除旧的 preProcess 和 postProcess**

从 handler.go 中删除：
```go
func (h *ChatHandler) preProcess(question string) string { return question }
func (h *ChatHandler) postProcess(line string) string { return line }
```

同时删除对 `h.preProcess` 的调用（~L78），直接使用 `chatReq.Question`。

- [ ] **Step 4: 验证编译**

Run: `cd /Users/zhangqq/Documents/pythonProject/HK_POC/backend && go build ./...`

- [ ] **Step 5: Commit**

```bash
cd /Users/zhangqq/Documents/pythonProject/HK_POC
git add backend/event_processor.go backend/handler.go
git commit -m "feat(backend): add EventProcessor for SSE event parsing and chart.recommendation injection"
```

---

## Phase 3: HK_POC 前端改动

### Task 10: 类型定义扩展

**Files:**
- Modify: `/Users/zhangqq/Documents/pythonProject/HK_POC/web/src/types.ts`

- [ ] **Step 1: 新增 ChartSpec 类型，扩展 SQLResult 和 Message**

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
  round_index?: number
}

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  sqlResults: SQLResult[]
  sqlStatements: string[]
  isStreaming: boolean
  phase?: Phase
  error?: string
  chartSpec?: ChartSpec
}
```

- [ ] **Step 2: Commit**

```bash
cd /Users/zhangqq/Documents/pythonProject/HK_POC
git add web/src/types.ts
git commit -m "feat(web): add ChartSpec type, extend SQLResult and Message"
```

---

### Task 11: useExploreSSE — 处理 chart.recommendation 和 round_index

**Files:**
- Modify: `/Users/zhangqq/Documents/pythonProject/HK_POC/web/src/hooks/useExploreSSE.ts`

- [ ] **Step 1: sql.result 处理中保存 round_index**

在 `sql.result` case 中（~L151），构造 result 时添加 round_index：

```typescript
const result: SQLResult = {
  columns: event.data?.columns ?? [],
  rows: event.data?.rows ?? [],
  sql: event.data?.sql,
  total_count: event.data?.total_count,
  round_index: event.data?.round_index,
}
```

- [ ] **Step 2: 新增 chart.recommendation case**

在 `handleEvent` 的 switch 中，`synthesis.delta` case 之前添加：

```typescript
case 'chart.recommendation': {
  const spec = event.data
  if (spec) {
    onUpdate((msg) => ({
      ...msg,
      chartSpec: {
        chart_type: spec.chart_type ?? 'auto',
        x: spec.x,
        y: spec.y,
        display_mode: spec.display_mode ?? 'both',
        round_index: spec.round_index,
      },
    }))
  }
  break
}
```

- [ ] **Step 3: Commit**

```bash
git add web/src/hooks/useExploreSSE.ts
git commit -m "feat(web): handle chart.recommendation SSE event and save round_index"
```

---

### Task 12: MessageBubble — chartSpec 驱动图表渲染

**Files:**
- Modify: `/Users/zhangqq/Documents/pythonProject/HK_POC/web/src/components/MessageBubble.tsx`

- [ ] **Step 1: 修改图表渲染逻辑**

替换现有图表渲染代码块（~L68-79）：

```tsx
{/* Chart: chartSpec-driven or fallback */}
{!isUser && isDone && (() => {
  const { chartSpec } = message
  // chart_type=none: explicitly skip chart
  if (chartSpec?.chart_type === 'none') return null

  // Find the sqlResult to chart
  let chartResult: SQLResult | undefined
  if (chartSpec?.round_index !== undefined) {
    chartResult = message.sqlResults.find((r) => r.round_index === chartSpec.round_index)
  }
  if (!chartResult && message.sqlResults.length > 0) {
    // Fallback: pick result with most columns
    chartResult = message.sqlResults.reduce((best, r) =>
      r.columns.length > best.columns.length ? r : best
    )
  }

  if (!chartResult) return null

  return <Chart result={chartResult} spec={chartSpec} />
})()}
```

- [ ] **Step 2: 确保 Chart import 更新**

确认 import 包含 `SQLResult` 类型（如果 Chart 组件签名变了）。

- [ ] **Step 3: Commit**

```bash
git add web/src/components/MessageBubble.tsx
git commit -m "feat(web): use chartSpec to drive chart rendering with round_index binding"
```

---

### Task 13: Chart.tsx — 配置驱动重构，支持 bar/pie + 分类轴

**Files:**
- Modify: `/Users/zhangqq/Documents/pythonProject/HK_POC/web/src/components/Chart.tsx`

- [ ] **Step 1: 修改 Chart 组件签名，接收可选 ChartSpec**

```tsx
import type { SQLResult, ChartSpec } from '../types'

interface ChartProps {
  result: SQLResult
  spec?: ChartSpec
}
```

- [ ] **Step 2: 新增分类轴检测函数**

```tsx
function findCategoryColumnIndex(result: SQLResult): number {
  for (let ci = 0; ci < result.columns.length; ci++) {
    if (isIdentifierColumn(result.columns[ci], result.rows.map((r) => r[ci]))) {
      return ci
    }
  }
  // Fallback: first string column
  for (let ci = 0; ci < result.columns.length; ci++) {
    const hasStrings = result.rows.some((row) => typeof row[ci] === 'string' && !isNumeric(row[ci]))
    if (hasStrings) return ci
  }
  return 0
}
```

- [ ] **Step 3: 新增 canRenderBarChart 和 canRenderPieChart 检测**

```tsx
function canRenderBarChart(result: SQLResult): boolean {
  if (result.columns.length < 2 || result.rows.length < 1) return false
  const catCol = findCategoryColumnIndex(result)
  return result.columns.some((col, ci) =>
    ci !== catCol && result.rows.some((row) => isNumeric(row[ci]))
  )
}

function canRenderPieChart(result: SQLResult): boolean {
  if (result.columns.length < 2 || result.rows.length < 2) return false
  if (result.rows.length > 20) return false // too many slices
  return canRenderBarChart(result) // same structural requirement
}
```

- [ ] **Step 4: 重构主 Chart 组件支持 spec 驱动**

```tsx
export function Chart({ result, spec }: ChartProps) {
  // Determine chart type: spec-driven or fallback
  const chartType = resolveChartType(result, spec)
  if (!chartType) return null

  switch (chartType) {
    case 'line':
      return <LineChart result={result} spec={spec} />
    case 'bar':
      return <BarChart result={result} spec={spec} />
    case 'pie':
      return <PieChart result={result} spec={spec} />
    default:
      return null
  }
}

function resolveChartType(result: SQLResult, spec?: ChartSpec): string | null {
  if (spec?.chart_type === 'none') return null
  if (spec?.chart_type && spec.chart_type !== 'auto') return spec.chart_type

  // Fallback heuristics (existing canRenderChart logic)
  if (canRenderChart(result)) return 'line'
  if (canRenderBarChart(result)) return 'bar'
  return null
}
```

- [ ] **Step 5: 提取现有折线图逻辑为 LineChart 子组件**

将现有 `Chart` 组件的渲染逻辑重命名为 `LineChart`（保持原有实现不变）。

- [ ] **Step 6: 实现 BarChart 子组件**

```tsx
function BarChart({ result, spec }: ChartProps) {
  const { columns, rows } = result
  const xCol = spec?.x?.field
    ? columns.indexOf(spec.x.field)
    : findCategoryColumnIndex(result)
  if (xCol < 0) return null

  const xData = rows.map((row) => String(row[xCol] ?? ''))

  const yColIndices = spec?.y?.length
    ? spec.y.map((y) => columns.indexOf(y.field)).filter((i) => i >= 0)
    : columns.map((_, ci) => ci).filter((ci) =>
        ci !== xCol && !isIdentifierColumn(columns[ci], rows.map((r) => r[ci])) &&
        rows.some((row) => isNumeric(row[ci]))
      )

  const series = yColIndices.map((ci, idx) => ({
    name: spec?.y?.[idx]?.label || formatColumnName(columns[ci]),
    type: 'bar' as const,
    data: rows.map((row) => (isNumeric(row[ci]) ? Number(row[ci]) : null)),
    itemStyle: { color: COLORS[idx % COLORS.length] },
  }))

  const option: any = {
    color: COLORS,
    tooltip: { trigger: 'axis', backgroundColor: 'rgba(255,255,255,0.96)', borderColor: '#e5e7eb' },
    legend: { data: series.map((s) => s.name), top: 4, textStyle: { fontSize: 12, color: '#6b7280' } },
    grid: { left: 60, right: 20, top: 36, bottom: 36, containLabel: false },
    xAxis: {
      type: 'category',
      data: xData,
      axisLabel: { fontSize: 11, color: '#9ca3af', rotate: xData.length > 8 ? 45 : 0 },
    },
    yAxis: {
      type: 'value',
      splitLine: { lineStyle: { color: '#f3f4f6', type: 'dashed' } },
      axisLabel: { fontSize: 11, color: '#9ca3af' },
    },
    series,
  }

  return (
    <div className="chart-wrapper" style={{ marginTop: 12, padding: '12px 12px 4px', background: '#fff', borderRadius: 8, border: '1px solid #f0f0f0' }}>
      <ReactECharts option={option} style={{ height: 300 }} />
    </div>
  )
}
```

- [ ] **Step 7: 实现 PieChart 子组件**

```tsx
function PieChart({ result, spec }: ChartProps) {
  const { columns, rows } = result
  const nameCol = spec?.x?.field
    ? columns.indexOf(spec.x.field)
    : findCategoryColumnIndex(result)

  const valueCol = spec?.y?.[0]?.field
    ? columns.indexOf(spec.y[0].field)
    : columns.findIndex((col, ci) =>
        ci !== nameCol && rows.some((row) => isNumeric(row[ci]))
      )

  if (nameCol < 0 || valueCol < 0) return null

  const data = rows
    .filter((row) => isNumeric(row[valueCol]))
    .map((row) => ({
      name: String(row[nameCol] ?? ''),
      value: Number(row[valueCol]),
    }))

  const option: any = {
    color: COLORS,
    tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
    legend: { orient: 'vertical', right: 10, top: 'center', textStyle: { fontSize: 12 } },
    series: [{
      type: 'pie',
      radius: ['40%', '70%'],
      avoidLabelOverlap: true,
      itemStyle: { borderRadius: 4, borderColor: '#fff', borderWidth: 2 },
      label: { show: false },
      emphasis: { label: { show: true, fontSize: 14, fontWeight: 'bold' } },
      data,
    }],
  }

  return (
    <div className="chart-wrapper" style={{ marginTop: 12, padding: '12px 12px 4px', background: '#fff', borderRadius: 8, border: '1px solid #f0f0f0' }}>
      <ReactECharts option={option} style={{ height: 300 }} />
    </div>
  )
}
```

- [ ] **Step 8: 验证前端编译**

Run: `cd /Users/zhangqq/Documents/pythonProject/HK_POC/web && npm run build`

- [ ] **Step 9: Commit**

```bash
cd /Users/zhangqq/Documents/pythonProject/HK_POC
git add web/src/components/Chart.tsx
git commit -m "feat(web): refactor Chart to support bar/pie/line with ChartSpec and category axis"
```

---

## Phase 4: 端到端验证

### Task 14: 构建和部署验证

- [ ] **Step 1: 构建 moi-core POC Docker 镜像**

```bash
cd /tmp/moi-core-dev-poc-fix/moi-core
make build-image-catalog
```

- [ ] **Step 2: 部署 HK_POC**

```bash
cd /Users/zhangqq/Documents/pythonProject/HK_POC
docker compose build app && docker compose up -d --force-recreate app
```

- [ ] **Step 3: 端到端测试场景**

在前端 UI 中依次测试：

| 测试 | 输入 | 期望 |
|------|------|------|
| 图表-柱状图 | "2026年2月5日，各股票的收盘价，展示为柱状图" | 柱状图渲染，Synthesizer 不说"我不能画图" |
| 图表-走势 | "过去3个月恒生指数走势" | 折线图渲染 |
| 图表-fallback | "市值最大的5只股票" | 自动检测，可能柱状图或无图表 |
| 多轮-追问 | 先问"收盘价前5名"，再问"这些股票属于什么行业" | 第二轮正确解析"这些股票" |
| 多轮-条件修改 | 先问"跌幅超过2%的交易日"，再问"那超过3%的呢" | 正确修改条件 |

- [ ] **Step 4: 如果 Synthesizer 仍然说"我不能画图"**

追加改动：让 Synthesizer 使用 `rewrite_queries[0]` 替代原始 question。具体改动位置在 `engine.go` 中调用 Synthesize 时传入的 question 参数。
