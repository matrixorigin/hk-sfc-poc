package main

import (
	"encoding/json"
	"log"
)

// MessageAggregate 从 SSE 事件流聚合 assistant message 的最终态。
// 每条 assistant message 对应一个 Aggregator 实例，流结束后调用 Finalize() 写库。
type MessageAggregate struct {
	content            string
	sqlStatements      []string
	sqlResults         []json.RawMessage
	sqlResultColSig    []string // 与 sqlResults 一一对应，用于列数替换规则去重
	chartSpec          json.RawMessage
	phaseHistory       []string
	errorMsg           string
	hasFailed          bool
	hasDone            bool
	metricExplanations []MetricDef
	metricSeen         map[string]bool
}

// NewMessageAggregate 创建一个新聚合器。
func NewMessageAggregate() *MessageAggregate {
	return &MessageAggregate{metricSeen: make(map[string]bool)}
}

// Apply 按事件类型分发到对应的 handler。
// SSEEvent.Data 是 JSON 字符串，通常形如 {"event":"...","data":{...}}。
func (a *MessageAggregate) Apply(evt SSEEvent) {
	switch evt.EventType {
	case "sql.result":
		a.handleSQLResult(evt.Data)
	case "chart.recommendation":
		a.handleChartRecommendation(evt.Data)
	case "presentation.result":
		a.handlePresentationResult(evt.Data)
	case "metric.explanations":
		a.handleMetricExplanations(evt.Data)
	case "synthesis.done":
		a.handleSynthesisDone(evt.Data)
	case "run.started":
		a.appendPhase("thinking")
	case "planning.plan.ready", "planning.rewrite.ready":
		a.appendPhase("planning")
	case "sql.generated", "retrieval.progress":
		a.appendPhase("querying")
	case "synthesis.delta":
		a.appendPhase("answering")
	case "run.error":
		a.handleRunError(evt.Data)
	case "run.completed":
		a.handleRunCompleted(evt.Data)
	}
}

// Finalize 按当前聚合状态构造 StoredMessage（只填 content/sql/chart/phase/error/status 六类字段）。
// 调用方负责填 id / conversation_id / role / seq / created_at 等。
func (a *MessageAggregate) Finalize() *StoredMessage {
	status := "pending"
	if a.hasFailed {
		status = "failed"
	} else if a.hasDone {
		status = "done"
	}
	return &StoredMessage{
		Content:            a.content,
		SQLStatements:      a.sqlStatements,
		SQLResults:         a.sqlResults,
		ChartSpec:          a.chartSpec,
		PhaseHistory:       a.phaseHistory,
		Error:              a.errorMsg,
		Status:             status,
		MetricExplanations: a.metricExplanations,
	}
}

// ---------- handlers ----------

func (a *MessageAggregate) handleSQLResult(data string) {
	var wrapper struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal([]byte(data), &wrapper); err != nil {
		return
	}
	if len(wrapper.Data) == 0 {
		return
	}
	var payload struct {
		SQL     string   `json:"sql"`
		Columns []string `json:"columns"`
	}
	if err := json.Unmarshal(wrapper.Data, &payload); err != nil {
		return
	}

	// 去重追加 sql 语句
	if payload.SQL != "" {
		dup := false
		for _, existing := range a.sqlStatements {
			if existing == payload.SQL {
				dup = true
				break
			}
		}
		if !dup {
			a.sqlStatements = append(a.sqlStatements, payload.SQL)
		}
	}

	// 列数替换规则：
	//   - 与已有项 (columns + rows) 完全重复 → skip
	//   - 若已有项列数更少但行数相同 → 替换
	//   - 若新项是已有项的子集（列数更少，行数相同） → skip
	// 简化实现：用列签名字符串判断
	colSig := sigFromColumns(payload.Columns)

	// 检查是否已有行数相同的项（需要解析 rows 长度，但我们手头只有 RawMessage；
	// 这里简化为：只按列签名去重）
	replaced := false
	for i, existing := range a.sqlResultColSig {
		if existing == colSig {
			// 列相同，用新的覆盖（保留最后一份）
			a.sqlResults[i] = wrapper.Data
			replaced = true
			break
		}
	}
	if !replaced {
		a.sqlResults = append(a.sqlResults, wrapper.Data)
		a.sqlResultColSig = append(a.sqlResultColSig, colSig)
	}
}

func (a *MessageAggregate) handleMetricExplanations(data string) {
	// metric.explanations 是 backend EventProcessor 自己注入的，格式为
	// {"event":"metric.explanations","data":{"round_index":N,"items":[...]},"seq":N}
	var wrapper struct {
		Data struct {
			Items []MetricDef `json:"items"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(data), &wrapper); err != nil {
		log.Printf("[aggregate] metric.explanations: unmarshal failed: %v", err)
		return
	}
	for _, m := range wrapper.Data.Items {
		if a.metricSeen[m.Column] {
			continue
		}
		a.metricSeen[m.Column] = true
		a.metricExplanations = append(a.metricExplanations, m)
	}
}

func (a *MessageAggregate) handleChartRecommendation(data string) {
	// chart.recommendation 是 backend EventProcessor 自己注入的，格式为
	// {"event":"chart.recommendation","data":{...},"seq":N}
	// 把 data 内层取出即可。
	var wrapper struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal([]byte(data), &wrapper); err != nil {
		return
	}
	if len(wrapper.Data) > 0 {
		a.chartSpec = wrapper.Data
	}
}

func (a *MessageAggregate) handlePresentationResult(data string) {
	var wrapper struct {
		Data struct {
			Content   string          `json:"content"`
			ChartSpec json.RawMessage `json:"chart_spec"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(data), &wrapper); err != nil {
		log.Printf("[aggregate] presentation.result: unmarshal failed: %v", err)
		return
	}
	if wrapper.Data.Content != "" {
		a.content = wrapper.Data.Content
	}
	if len(wrapper.Data.ChartSpec) > 0 && string(wrapper.Data.ChartSpec) != "null" {
		a.chartSpec = wrapper.Data.ChartSpec
	}
}

// handleSynthesisDone 从 SynthesisResult.Blocks 里取 type=text 的 content 作为最终文本。
// SynthesisResult 定义见 moi-core/explore/synthesizer/types.go:19。
func (a *MessageAggregate) handleSynthesisDone(data string) {
	a.hasDone = true
	a.appendPhase("done")

	var wrapper struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal([]byte(data), &wrapper); err != nil {
		log.Printf("[aggregate] synthesis.done: outer unmarshal failed: %v", err)
		return
	}
	if len(wrapper.Data) == 0 {
		return
	}

	var result struct {
		Blocks []struct {
			Type    string `json:"type"`
			Content string `json:"content"`
		} `json:"blocks"`
	}
	if err := json.Unmarshal(wrapper.Data, &result); err != nil {
		log.Printf("[aggregate] synthesis.done: SynthesisResult unmarshal failed: %v", err)
		return
	}

	var textParts []string
	for _, b := range result.Blocks {
		if b.Type == "text" && b.Content != "" {
			textParts = append(textParts, b.Content)
		}
	}
	if len(textParts) > 0 {
		a.content = joinText(textParts)
	}
}

func (a *MessageAggregate) handleRunError(data string) {
	var wrapper struct {
		Data struct {
			Message     string `json:"message"`
			Error       string `json:"error"`
			Recoverable bool   `json:"recoverable"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(data), &wrapper); err != nil {
		return
	}
	msg := wrapper.Data.Message
	if msg == "" {
		msg = wrapper.Data.Error
	}
	if !wrapper.Data.Recoverable && msg != "" {
		a.errorMsg = msg
		a.hasFailed = true
	}
}

func (a *MessageAggregate) handleRunCompleted(data string) {
	var wrapper struct {
		Data struct {
			Status string `json:"status"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(data), &wrapper); err != nil {
		return
	}
	if wrapper.Data.Status == "failed" && a.content == "" {
		a.hasFailed = true
		if a.errorMsg == "" {
			a.errorMsg = "Query failed. Please try rephrasing your question."
		}
	}
}

func (a *MessageAggregate) appendPhase(phase string) {
	if len(a.phaseHistory) > 0 && a.phaseHistory[len(a.phaseHistory)-1] == phase {
		return
	}
	a.phaseHistory = append(a.phaseHistory, phase)
}

// ---------- helpers ----------

func sigFromColumns(cols []string) string {
	b, _ := json.Marshal(cols)
	return string(b)
}

func joinText(parts []string) string {
	total := 0
	for _, p := range parts {
		total += len(p) + 2
	}
	out := make([]byte, 0, total)
	for i, p := range parts {
		if i > 0 {
			out = append(out, '\n', '\n')
		}
		out = append(out, p...)
	}
	return string(out)
}
