package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// FeedbackHandler 处理 /api/feedback 相关 HTTP 请求。
type FeedbackHandler struct {
	db       *FeedbackDB
	analyzer *FeedbackAnalyzer
}

// NewFeedbackHandler 创建 FeedbackHandler。
func NewFeedbackHandler(db *FeedbackDB, analyzer *FeedbackAnalyzer) *FeedbackHandler {
	return &FeedbackHandler{db: db, analyzer: analyzer}
}

// ServeHTTP 设置 CORS 头，处理 OPTIONS，并路由到对应处理方法。
func (h *FeedbackHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	// 判断是否带有 ID（路径形如 /api/feedback/{id}）
	path := r.URL.Path
	prefix := "/api/feedback/"
	if id, found := strings.CutPrefix(path, prefix); found && id != "" {
		h.get(w, id)
		return
	}

	switch r.Method {
	case http.MethodPost:
		h.create(w, r)
	case http.MethodGet:
		h.list(w, r)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// create 解析请求体，创建反馈任务并异步触发分析。
func (h *FeedbackHandler) create(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Question  string          `json:"question"`
		UserNote  string          `json:"user_note"`
		SQL       string          `json:"sql"`
		SQLResult json.RawMessage `json:"sql_result"`
		SessionID string          `json:"session_id"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
		return
	}

	if req.Question == "" || req.SQL == "" {
		http.Error(w, "question and sql are required", http.StatusBadRequest)
		return
	}

	task := &FeedbackTask{
		ID:        fmt.Sprintf("fb_%d", time.Now().UnixMilli()),
		Status:    "pending",
		CreatedAt: time.Now().UTC().Format(time.RFC3339),
		Question:  req.Question,
		UserNote:  req.UserNote,
		SQL:       req.SQL,
		SQLResult: req.SQLResult,
		SessionID: req.SessionID,
	}

	if err := h.db.Insert(*task); err != nil {
		http.Error(w, "failed to insert task", http.StatusInternalServerError)
		return
	}

	h.analyzer.RunAsync(task)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{
		"id":     task.ID,
		"status": task.Status,
	})
}

// list 返回所有反馈任务列表。
func (h *FeedbackHandler) list(w http.ResponseWriter, _ *http.Request) {
	tasks, err := h.db.List()
	if err != nil {
		http.Error(w, "failed to list tasks", http.StatusInternalServerError)
		return
	}

	if tasks == nil {
		tasks = []FeedbackTask{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"tasks": tasks,
	})
}

// get 根据 ID 返回单个反馈任务。
func (h *FeedbackHandler) get(w http.ResponseWriter, id string) {
	task, err := h.db.Get(id)
	if err != nil {
		http.Error(w, "failed to get task", http.StatusInternalServerError)
		return
	}
	if task == nil {
		http.Error(w, "task not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(task)
}
