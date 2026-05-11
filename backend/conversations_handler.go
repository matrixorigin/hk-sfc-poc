package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// ConversationsHandler 处理 /api/conversations* 相关的 REST + 消息 SSE 请求。
// 由于 Go net/http.ServeMux 不支持路径变量，统一用 strings 手动拆段。
type ConversationsHandler struct {
	db       *ConversationsDB
	messages *MessagesHandler // POST /api/conversations/{id}/messages 转给它
}

// NewConversationsHandler 构造路由处理器。
func NewConversationsHandler(db *ConversationsDB, messages *MessagesHandler) *ConversationsHandler {
	return &ConversationsHandler{db: db, messages: messages}
}

// ServeHTTP 路由分发：
//
//	GET    /api/conversations                                       → list
//	POST   /api/conversations                                       → create
//	PATCH  /api/conversations/{id}                                  → updateTitle
//	DELETE /api/conversations/{id}                                  → delete
//	GET    /api/conversations/{id}/messages                         → listMessages
//	POST   /api/conversations/{id}/messages                         → sendMessage (SSE)
//	PATCH  /api/conversations/{id}/messages/{mid}/chart-spec        → updateChartSpec
func (h *ConversationsHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	// 拆路径：/api/conversations{rest}
	rest := strings.TrimPrefix(r.URL.Path, "/api/conversations")
	rest = strings.Trim(rest, "/")

	// rest 可能是：
	//   "" → 集合资源 /api/conversations
	//   "{id}" → 单个会话
	//   "{id}/messages" → 消息子资源
	//   "{id}/messages/{mid}/chart-spec" → 单条消息的图表配置
	var convID, sub string
	if rest != "" {
		parts := strings.SplitN(rest, "/", 2)
		convID = parts[0]
		if len(parts) > 1 {
			sub = parts[1]
		}
	}

	switch {
	case convID == "":
		// /api/conversations
		switch r.Method {
		case http.MethodGet:
			h.list(w)
		case http.MethodPost:
			h.create(w)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}

	case sub == "":
		// /api/conversations/{id}
		switch r.Method {
		case http.MethodPatch:
			h.updateTitle(w, r, convID)
		case http.MethodDelete:
			h.delete(w, convID)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}

	case sub == "messages":
		// /api/conversations/{id}/messages
		switch r.Method {
		case http.MethodGet:
			h.listMessages(w, convID)
		case http.MethodPost:
			h.messages.HandleSend(w, r, convID)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}

	case strings.HasPrefix(sub, "messages/"):
		// /api/conversations/{id}/messages/{mid}/...
		subParts := strings.SplitN(strings.TrimPrefix(sub, "messages/"), "/", 2)
		if len(subParts) < 2 {
			http.NotFound(w, r)
			return
		}
		msgID, action := subParts[0], subParts[1]
		switch {
		case action == "chart-spec" && r.Method == http.MethodPatch:
			h.updateChartSpec(w, r, convID, msgID)
		default:
			http.NotFound(w, r)
		}

	default:
		http.NotFound(w, r)
	}
}

func (h *ConversationsHandler) list(w http.ResponseWriter) {
	items, err := h.db.ListConversations()
	if err != nil {
		http.Error(w, fmt.Sprintf("list: %v", err), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"conversations": items})
}

func (h *ConversationsHandler) create(w http.ResponseWriter) {
	id, err := h.db.CreateConversation()
	if err != nil {
		http.Error(w, fmt.Sprintf("create: %v", err), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": id})
}

func (h *ConversationsHandler) updateTitle(w http.ResponseWriter, r *http.Request, id string) {
	var req struct {
		Title string `json:"title"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	if err := h.db.UpdateTitle(id, req.Title); err != nil {
		http.Error(w, fmt.Sprintf("update: %v", err), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *ConversationsHandler) delete(w http.ResponseWriter, id string) {
	if err := h.db.DeleteConversation(id); err != nil {
		http.Error(w, fmt.Sprintf("delete: %v", err), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *ConversationsHandler) listMessages(w http.ResponseWriter, id string) {
	// 先确认会话存在
	conv, err := h.db.GetConversation(id)
	if err != nil {
		http.Error(w, fmt.Sprintf("get: %v", err), http.StatusInternalServerError)
		return
	}
	if conv == nil {
		http.Error(w, "conversation not found", http.StatusNotFound)
		return
	}
	msgs, err := h.db.ListMessages(id)
	if err != nil {
		http.Error(w, fmt.Sprintf("list messages: %v", err), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"messages": msgs})
}

// updateChartSpec 把用户在前端选的图表配置整体写入 messages.chart_spec。
// Body 即完整 ChartSpec JSON；后端不解 schema，作为不透明 blob 存储。
func (h *ConversationsHandler) updateChartSpec(w http.ResponseWriter, r *http.Request, convID, msgID string) {
	body, err := readBodyLimited(r, 16*1024)
	if err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	// 必须是合法 JSON object；空 body 视为清空
	var spec json.RawMessage
	if len(body) > 0 {
		if !json.Valid(body) {
			http.Error(w, "chart_spec must be valid JSON", http.StatusBadRequest)
			return
		}
		spec = body
	}

	n, err := h.db.UpdateMessageChartSpec(convID, msgID, spec)
	if err != nil {
		http.Error(w, fmt.Sprintf("update: %v", err), http.StatusInternalServerError)
		return
	}
	if n == 0 {
		http.Error(w, "message not found", http.StatusNotFound)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func readBodyLimited(r *http.Request, maxBytes int64) ([]byte, error) {
	defer r.Body.Close()
	return io.ReadAll(io.LimitReader(r.Body, maxBytes))
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
