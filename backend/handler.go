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

// ChatHandler 持有 Explore 客户端、Clarifier 和配置。
type ChatHandler struct {
	client   *ExploreClient
	clarify  *Clarifier
	cfg      *Config
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

	// 反问检查：参数不完整时直接返回反问，不调 Explore
	if h.clarify != nil {
		finalQ, reply, err := h.clarify.Process(r.Context(), sessionID, processedQuestion)
		if err != nil {
			http.Error(w, fmt.Sprintf("clarify error: %v", err), http.StatusInternalServerError)
			return
		}
		if reply != "" {
			writeClarifySSE(w, reply)
			return
		}
		processedQuestion = finalQ
	}

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
			KnowledgeBases: func() []KnowledgeBaseRef {
				if h.cfg.Explore.KnowledgeBaseID > 0 {
					return []KnowledgeBaseRef{{KnowledgeBaseID: h.cfg.Explore.KnowledgeBaseID}}
				}
				return nil
			}(),
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

	// 记录该问题到对话历史，供后续 Clarifier 判断追问上下文
	if h.clarify != nil {
		h.clarify.RecordExplored(sessionID, processedQuestion)
	}

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

// writeClarifySSE 发送反问响应，模拟 Explore SSE 格式使前端无需改动。
func writeClarifySSE(w http.ResponseWriter, reply string) {
	setCORSHeaders(w)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	flusher, canFlush := w.(http.Flusher)
	write := func(event, data string) {
		_, _ = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, data)
		if canFlush {
			flusher.Flush()
		}
	}

	runID := "clarify"

	write("run.started", fmt.Sprintf(`{"data":{"run_id":"%s"},"event":"run.started","run_id":"%s","schema_version":"run.v1","seq":1}`, runID, runID))

	// 用 synthesis.delta 发送反问内容（前端按 delta 拼接显示）
	deltaData, _ := json.Marshal(map[string]any{
		"data":           map[string]any{"block_type": "text", "delta": reply},
		"event":          "synthesis.delta",
		"run_id":         runID,
		"schema_version": "run.v1",
		"seq":            2,
	})
	write("synthesis.delta", string(deltaData))

	write("synthesis.done", fmt.Sprintf(`{"data":{},"event":"synthesis.done","run_id":"%s","schema_version":"run.v1","seq":3}`, runID))
	write("run.completed", fmt.Sprintf(`{"data":{"status":"completed"},"event":"run.completed","run_id":"%s","schema_version":"run.v1","seq":4}`, runID))
}
