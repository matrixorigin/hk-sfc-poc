package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
)

// KnowledgeHandler 代理前端知识管理请求到 Catalog nl2sql-knowledge API。
type KnowledgeHandler struct {
	catalogURL      string
	apiKey          string
	workspaceID     string
	knowledgeBaseID int64
	httpClient      *http.Client
}

// NewKnowledgeHandler 创建 KnowledgeHandler 实例。
func NewKnowledgeHandler(cfg *Config) *KnowledgeHandler {
	return &KnowledgeHandler{
		catalogURL:      cfg.Catalog.URL,
		apiKey:          cfg.Catalog.APIKey,
		workspaceID:     cfg.Catalog.WorkspaceID,
		knowledgeBaseID: cfg.Explore.KnowledgeBaseID,
		httpClient:      &http.Client{},
	}
}

func (h *KnowledgeHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w)

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	switch r.Method {
	case http.MethodGet:
		h.listKnowledge(w, r)
	case http.MethodPost:
		h.createKnowledge(w, r)
	case http.MethodDelete:
		h.deleteKnowledge(w, r)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// listKnowledge 代理 GET /api/knowledge → POST /api/v1/workspaces/{ws}/nl2sql-knowledge/list
func (h *KnowledgeHandler) listKnowledge(w http.ResponseWriter, r *http.Request) {
	upstreamURL := fmt.Sprintf("%s/api/v1/workspaces/%s/nl2sql-knowledge/list", h.catalogURL, h.workspaceID)

	body := map[string]any{
		"knowledge_base_ids": []int64{h.knowledgeBaseID},
		"page_size":          200,
	}
	bodyBytes, err := json.Marshal(body)
	if err != nil {
		http.Error(w, fmt.Sprintf("marshal request: %v", err), http.StatusInternalServerError)
		return
	}

	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, upstreamURL, bytes.NewReader(bodyBytes))
	if err != nil {
		http.Error(w, fmt.Sprintf("create request: %v", err), http.StatusInternalServerError)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-Key", h.apiKey)

	h.proxyResponse(w, req)
}

// createKnowledge 代理 POST /api/knowledge → POST /api/v1/workspaces/{ws}/nl2sql-knowledge
func (h *KnowledgeHandler) createKnowledge(w http.ResponseWriter, r *http.Request) {
	upstreamURL := fmt.Sprintf("%s/api/v1/workspaces/%s/nl2sql-knowledge", h.catalogURL, h.workspaceID)

	// 读取前端请求体并注入 knowledge_base_id
	var reqBody map[string]any
	if err := json.NewDecoder(r.Body).Decode(&reqBody); err != nil {
		http.Error(w, fmt.Sprintf("invalid request body: %v", err), http.StatusBadRequest)
		return
	}
	reqBody["knowledge_base_id"] = h.knowledgeBaseID

	bodyBytes, err := json.Marshal(reqBody)
	if err != nil {
		http.Error(w, fmt.Sprintf("marshal request: %v", err), http.StatusInternalServerError)
		return
	}

	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, upstreamURL, bytes.NewReader(bodyBytes))
	if err != nil {
		http.Error(w, fmt.Sprintf("create request: %v", err), http.StatusInternalServerError)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-Key", h.apiKey)

	h.proxyResponse(w, req)
}

// deleteKnowledge 代理 DELETE /api/knowledge/{id} → DELETE /api/v1/workspaces/{ws}/nl2sql-knowledge/{id}
func (h *KnowledgeHandler) deleteKnowledge(w http.ResponseWriter, r *http.Request) {
	// 从路径中提取知识条目 ID: /api/knowledge/{id}
	path := strings.TrimPrefix(r.URL.Path, "/api/knowledge/")
	knowledgeID := strings.TrimRight(path, "/")
	if knowledgeID == "" {
		http.Error(w, "knowledge id is required", http.StatusBadRequest)
		return
	}

	upstreamURL := fmt.Sprintf("%s/api/v1/workspaces/%s/nl2sql-knowledge/%s", h.catalogURL, h.workspaceID, knowledgeID)

	req, err := http.NewRequestWithContext(r.Context(), http.MethodDelete, upstreamURL, nil)
	if err != nil {
		http.Error(w, fmt.Sprintf("create request: %v", err), http.StatusInternalServerError)
		return
	}
	req.Header.Set("X-API-Key", h.apiKey)

	h.proxyResponse(w, req)
}

// proxyResponse 执行上游请求并将响应状态码和 body 透传回客户端。
func (h *KnowledgeHandler) proxyResponse(w http.ResponseWriter, req *http.Request) {
	resp, err := h.httpClient.Do(req)
	if err != nil {
		log.Printf("knowledge: upstream request failed: %v", err)
		http.Error(w, fmt.Sprintf("upstream error: %v", err), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	w.Header().Set("Content-Type", resp.Header.Get("Content-Type"))
	w.WriteHeader(resp.StatusCode)
	if _, err := io.Copy(w, resp.Body); err != nil {
		log.Printf("knowledge: copy response body failed: %v", err)
	}
}
