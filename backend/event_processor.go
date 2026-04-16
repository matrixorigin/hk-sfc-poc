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

// ChartRecommendation is the chart.recommendation event payload.
type ChartRecommendation struct {
	ChartType   string          `json:"chart_type"`
	X           *ChartAxisSpec  `json:"x,omitempty"`
	Y           []ChartAxisSpec `json:"y,omitempty"`
	DisplayMode string          `json:"display_mode,omitempty"`
	RoundIndex  int             `json:"round_index"`
}

// ChartAxisSpec describes a chart axis.
type ChartAxisSpec struct {
	Field string `json:"field"`
	Label string `json:"label"`
	Type  string `json:"type,omitempty"`
}

// PresentationSpec mirrors the moi-core PresentationSpec.
type PresentationSpec struct {
	ChartType   string   `json:"chart_type"`
	XField      string   `json:"x_field,omitempty"`
	YFields     []string `json:"y_fields,omitempty"`
	SeriesField string   `json:"series_field,omitempty"`
	DisplayMode string   `json:"display_mode,omitempty"`
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
	presentation *PresentationSpec
	sqlResults   []SQLResultMeta
	chartSent    bool
	nextSeq      int
	aggregator   *MessageAggregate
}

// NewEventProcessor creates a new EventProcessor.
func NewEventProcessor() *EventProcessor {
	return &EventProcessor{nextSeq: 1, aggregator: NewMessageAggregate()}
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

	// 把下游事件同步喂给 aggregator（chart.recommendation 已在上方注入）
	for _, o := range out {
		ep.aggregator.Apply(o)
	}

	return out
}

// extractChartFromSynthesis reads the grounded chart directive the synthesizer
// emits in the synthesis.done payload. The synthesizer is the only source of
// truth for chart recommendations: it sees the real SQL columns and picks
// y_fields from them, so column-name mismatches cannot happen here.
func (ep *EventProcessor) extractChartFromSynthesis(data string) {
	var wrapper struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal([]byte(data), &wrapper); err != nil {
		log.Printf("[chart-debug] extractChartFromSynthesis: wrapper unmarshal failed: %v", err)
		return
	}
	var synthesis struct {
		Chart *PresentationSpec `json:"chart"`
	}
	if err := json.Unmarshal(wrapper.Data, &synthesis); err != nil {
		log.Printf("[chart-debug] extractChartFromSynthesis: inner unmarshal failed: %v", err)
		return
	}
	if synthesis.Chart != nil {
		ep.presentation = synthesis.Chart
		log.Printf("[chart-debug] extractChartFromSynthesis: chart_type=%s x=%s y=%v display=%s",
			synthesis.Chart.ChartType, synthesis.Chart.XField,
			synthesis.Chart.YFields, synthesis.Chart.DisplayMode)
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

	spec := ep.presentation
	if spec == nil {
		spec = &PresentationSpec{ChartType: "auto", DisplayMode: "both"}
	}
	if spec.ChartType == "none" {
		// Explicitly no chart — still send to tell frontend to suppress auto-chart
		rec := ChartRecommendation{
			ChartType:  "none",
			RoundIndex: ep.sqlResults[len(ep.sqlResults)-1].RoundIndex,
		}
		dataBytes, _ := json.Marshal(rec)
		return &SSEEvent{EventType: "chart.recommendation", Data: string(dataBytes)}
	}

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

	envelope := map[string]any{
		"event": "chart.recommendation",
		"data":  rec,
	}
	dataBytes, _ := json.Marshal(envelope)
	log.Printf("[chart-debug] buildChartRecommendation: sending to frontend: %s", string(dataBytes))
	return &SSEEvent{EventType: "chart.recommendation", Data: string(dataBytes)}
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
