package main

import (
	"encoding/json"
	"fmt"
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
type EventProcessor struct {
	presentation *PresentationSpec
	sqlResults   []SQLResultMeta
	chartSent    bool
	nextSeq      int
}

// NewEventProcessor creates a new EventProcessor.
func NewEventProcessor() *EventProcessor {
	return &EventProcessor{nextSeq: 1}
}

// ProcessEvent takes an upstream event and returns downstream events.
func (ep *EventProcessor) ProcessEvent(evt SSEEvent) []SSEEvent {
	switch evt.EventType {
	case "planning.plan.ready", "planning.rewrite.ready":
		ep.extractPresentation(evt.Data)
	case "sql.result":
		ep.extractSQLResultMeta(evt.Data)
	}

	if evt.EventType == "synthesis.done" && !ep.chartSent {
		var out []SSEEvent
		if chartEvt := ep.buildChartRecommendation(); chartEvt != nil {
			out = append(out, ep.assignSeq(*chartEvt))
			ep.chartSent = true
		}
		out = append(out, ep.assignSeq(evt))
		return out
	}

	return []SSEEvent{ep.assignSeq(evt)}
}

func (ep *EventProcessor) extractPresentation(data string) {
	var wrapper struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal([]byte(data), &wrapper); err != nil {
		return
	}
	var planData struct {
		Presentation *PresentationSpec `json:"presentation"`
	}
	if err := json.Unmarshal(wrapper.Data, &planData); err != nil {
		return
	}
	if planData.Presentation != nil {
		ep.presentation = planData.Presentation
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

	dataBytes, _ := json.Marshal(rec)
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
