package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

// ChatRequest 是前端发来的请求体。
type ChatRequest struct {
	Question  string `json:"question"`
	SessionID string `json:"session_id,omitempty"`
}

// ChatHandler 持有 Explore 客户端和配置。
type ChatHandler struct {
	client *ExploreClient
	cfg    *Config
}

// preProcess 对问题做预处理，当前直接透传。
func (h *ChatHandler) preProcess(question string) string {
	return question
}

// postProcess 对 SSE 行做后处理，当前直接透传。
func (h *ChatHandler) postProcess(line string) string {
	return line
}

func setCORSHeaders(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
}

func (h *ChatHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w)

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var chatReq ChatRequest
	if err := json.NewDecoder(r.Body).Decode(&chatReq); err != nil {
		http.Error(w, fmt.Sprintf("invalid request: %v", err), http.StatusBadRequest)
		return
	}
	if chatReq.Question == "" {
		http.Error(w, "question is required", http.StatusBadRequest)
		return
	}

	sessionID := chatReq.SessionID
	if sessionID == "" {
		sessionID = "default"
	}

	processedQuestion := h.preProcess(chatReq.Question)

	// 构造上游 ExploreRequest
	exploreReq := &ExploreRequest{
		Query: QueryDomain{Question: processedQuestion},
		Session: SessionDomain{
			SessionID:   sessionID,
			WorkspaceID: h.cfg.Catalog.WorkspaceID,
		},
		DataSources: DataSourceDomain{
			Tables: &TableSource{
				DBName:    h.cfg.Explore.DBName,
				TableList: h.cfg.Explore.Tables,
			},
		},
		Options: ExploreOptions{
			PlanningMode: h.cfg.Explore.PlanningMode,
			Verbose:      h.cfg.Explore.Verbose,
		},
		Trace: TraceOptions{Enabled: true},
	}

	if h.cfg.Explore.LLMModel != "" {
		exploreReq.Options.LLM = &LLMConfig{Model: h.cfg.Explore.LLMModel}
	}

	stream, err := h.client.QueryStream(r.Context(), exploreReq)
	if err != nil {
		http.Error(w, fmt.Sprintf("upstream error: %v", err), http.StatusBadGateway)
		return
	}
	defer stream.Close()

	// 设置 SSE 响应头
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	flusher, canFlush := w.(http.Flusher)

	scanner := bufio.NewScanner(stream)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := h.postProcess(scanner.Text())
		_, _ = io.WriteString(w, line+"\n")
		if canFlush {
			flusher.Flush()
		}
	}
}
