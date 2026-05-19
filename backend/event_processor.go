package main

import (
	"encoding/json"
	"fmt"
	"log"
	"strings"
)

// SSEEvent represents a parsed server-sent event.
type SSEEvent struct {
	EventType string
	Data      string
}

// SQLResultMeta stores metadata from sql.result events.
type SQLResultMeta struct {
	RoundIndex int
	Columns    []string
}

// EventProcessor processes upstream SSE events and injects chart.recommendation.
// 同时，EventProcessor 内嵌一个 MessageAggregate，在转发事件的同时把 assistant
// message 的最终态聚合起来，供 handler 在 synthesis.done 之后落库。
type EventProcessor struct {
	presentation json.RawMessage
	sqlResults   []SQLResultMeta
	chartSent    bool
	nextSeq      int
	aggregator   *MessageAggregate
	metrics      *MetricRegistry
	// 已注入过 metric.explanations 的 round_index 集合，避免同一轮多发
	metricRoundsSent map[int]bool
}

// NewEventProcessor creates a new EventProcessor.
// metrics 可为 nil（未配置 metrics.yaml 时），此时不注入 metric.explanations 事件。
func NewEventProcessor(metrics *MetricRegistry) *EventProcessor {
	return &EventProcessor{
		nextSeq:          1,
		aggregator:       NewMessageAggregate(),
		metrics:          metrics,
		metricRoundsSent: make(map[int]bool),
	}
}

// Aggregator 返回当前聚合器（handler 在 synthesis.done 后调 Finalize() 拿落库结构）。
func (ep *EventProcessor) Aggregator() *MessageAggregate {
	return ep.aggregator
}

// ProcessEvent takes an upstream event and returns downstream events.
// 同时将所有下游事件喂给 aggregator（chart.recommendation 要先注入，
// 这样 aggregator 才能捕获到 chart 事件）。
func (ep *EventProcessor) ProcessEvent(evt SSEEvent) []SSEEvent {
	switch evt.EventType {
	case "sql.result":
		ep.extractSQLResultMeta(evt.Data)
	case "synthesis.done":
		ep.extractChartFromSynthesis(evt.Data)
	}

	var out []SSEEvent
	if evt.EventType == "synthesis.done" && !ep.chartSent {
		if chartEvt := ep.buildChartRecommendation(); chartEvt != nil {
			out = append(out, ep.assignSeq(*chartEvt))
			ep.chartSent = true
		}
		out = append(out, ep.assignSeq(evt))
	} else {
		out = append(out, ep.assignSeq(evt))
	}

	// 在 sql.result 之后追加 metric.explanations 事件（命中预计算列时）
	if evt.EventType == "sql.result" {
		if metricEvt := ep.buildMetricExplanations(evt.Data); metricEvt != nil {
			out = append(out, ep.assignSeq(*metricEvt))
		}
	}

	// 把下游事件同步喂给 aggregator（chart.recommendation 已在上方注入）
	for _, o := range out {
		ep.aggregator.Apply(o)
	}

	return out
}

// extractChartFromSynthesis reads the grounded chart directive the synthesizer
// emits in the synthesis.done payload. The backend keeps it as opaque JSON so
// moi owns chart semantics and HK_POC only renders the agreed ChartSpec.
func (ep *EventProcessor) extractChartFromSynthesis(data string) {
	var wrapper struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal([]byte(data), &wrapper); err != nil {
		log.Printf("[chart-debug] extractChartFromSynthesis: wrapper unmarshal failed: %v", err)
		return
	}
	var synthesis struct {
		Chart json.RawMessage `json:"chart"`
	}
	if err := json.Unmarshal(wrapper.Data, &synthesis); err != nil {
		log.Printf("[chart-debug] extractChartFromSynthesis: inner unmarshal failed: %v", err)
		return
	}
	if len(synthesis.Chart) > 0 && string(synthesis.Chart) != "null" {
		ep.presentation = synthesis.Chart
		log.Printf("[chart-debug] extractChartFromSynthesis: chart=%s", string(synthesis.Chart))
	} else {
		log.Printf("[chart-debug] extractChartFromSynthesis: synthesis.chart is nil (no directive emitted)")
	}
}

func (ep *EventProcessor) extractSQLResultMeta(data string) {
	var wrapper struct {
		Data struct {
			Columns    []string `json:"columns"`
			RoundIndex int      `json:"round_index"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(data), &wrapper); err != nil {
		return
	}
	ep.sqlResults = append(ep.sqlResults, SQLResultMeta{
		RoundIndex: wrapper.Data.RoundIndex,
		Columns:    wrapper.Data.Columns,
	})
}

func (ep *EventProcessor) buildChartRecommendation() *SSEEvent {
	if len(ep.sqlResults) == 0 {
		return nil
	}

	var rec map[string]any
	if len(ep.presentation) > 0 {
		_ = json.Unmarshal(ep.presentation, &rec)
	}
	if rec == nil {
		rec = map[string]any{
			"chart_type":   "auto",
			"display_mode": "both",
		}
	}
	rec["round_index"] = ep.sqlResults[len(ep.sqlResults)-1].RoundIndex

	envelope := map[string]any{
		"event": "chart.recommendation",
		"data":  rec,
	}
	dataBytes, _ := json.Marshal(envelope)
	log.Printf("[chart-debug] buildChartRecommendation: sending to frontend: %s", string(dataBytes))
	return &SSEEvent{EventType: "chart.recommendation", Data: string(dataBytes)}
}

// buildMetricExplanations 扫描 sql.result 事件的 SQL 文本 + columns，
// 命中已注册的预计算列时返回一个 metric.explanations 事件，否则返回 nil。
// 同一 round_index 只发一次。
func (ep *EventProcessor) buildMetricExplanations(data string) *SSEEvent {
	if ep.metrics == nil {
		return nil
	}
	var wrapper struct {
		Data struct {
			SQL        string   `json:"sql"`
			Columns    []string `json:"columns"`
			RoundIndex int      `json:"round_index"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(data), &wrapper); err != nil {
		return nil
	}
	if ep.metricRoundsSent[wrapper.Data.RoundIndex] {
		return nil
	}

	hits := ep.metrics.MatchSQLAndColumns(wrapper.Data.SQL, wrapper.Data.Columns)
	if len(hits) == 0 {
		return nil
	}
	ep.metricRoundsSent[wrapper.Data.RoundIndex] = true

	payload := map[string]any{
		"event": "metric.explanations",
		"data": map[string]any{
			"round_index": wrapper.Data.RoundIndex,
			"items":       hits,
		},
	}
	dataBytes, err := json.Marshal(payload)
	if err != nil {
		log.Printf("[metric] marshal failed: %v", err)
		return nil
	}
	log.Printf("[metric] injecting %d explanation(s) for round %d", len(hits), wrapper.Data.RoundIndex)
	return &SSEEvent{EventType: "metric.explanations", Data: string(dataBytes)}
}

func (ep *EventProcessor) assignSeq(evt SSEEvent) SSEEvent {
	seq := ep.nextSeq
	ep.nextSeq++

	var parsed map[string]any
	if err := json.Unmarshal([]byte(evt.Data), &parsed); err != nil {
		return evt
	}
	parsed["seq"] = seq
	rewritten, _ := json.Marshal(parsed)
	evt.Data = string(rewritten)
	return evt
}

// FormatSSEEvent formats an event to wire format.
func FormatSSEEvent(evt SSEEvent) string {
	return fmt.Sprintf("event: %s\ndata: %s\n\n", evt.EventType, evt.Data)
}

// ParseSSEBlock parses a block of SSE text into events.
// Handles "event: <type>\ndata: <json>\n\n" format.
func ParseSSEBlock(block string) []SSEEvent {
	var events []SSEEvent
	lines := strings.Split(block, "\n")
	var evtType string
	var dataParts []string

	flush := func() {
		if evtType != "" && len(dataParts) > 0 {
			events = append(events, SSEEvent{
				EventType: evtType,
				Data:      strings.Join(dataParts, "\n"),
			})
		}
		evtType = ""
		dataParts = nil
	}

	for _, line := range lines {
		line = strings.TrimRight(line, "\r")
		switch {
		case strings.HasPrefix(line, "event:"):
			if evtType != "" {
				flush()
			}
			evtType = strings.TrimSpace(line[6:])
		case strings.HasPrefix(line, "data:"):
			dataParts = append(dataParts, strings.TrimSpace(line[5:]))
		case line == "":
			flush()
		}
	}
	flush()
	return events
}
