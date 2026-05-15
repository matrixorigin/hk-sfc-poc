package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
)

// SendMessageRequest 是 POST /api/conversations/{id}/messages 的请求体。
type SendMessageRequest struct {
	Question string   `json:"question"`
	Tables   []string `json:"tables,omitempty"`
}

// MessagesHandler 负责处理某会话下的发送消息（SSE）流程。
// 它不自己处理 HTTP 路由（由 ConversationsHandler 拆完 path 后调用 HandleSend）。
type MessagesHandler struct {
	client       *ExploreClient
	clarify      *Clarifier
	db           *ConversationsDB
	cfg          *Config
	metrics      *MetricRegistry
	userTableSvc *UserTableService
}

// NewMessagesHandler 构造 MessagesHandler。metrics 可为 nil（未配置 metrics.yaml）。
func NewMessagesHandler(client *ExploreClient, clarify *Clarifier, db *ConversationsDB, cfg *Config, metrics *MetricRegistry, userTableSvc *UserTableService) *MessagesHandler {
	return &MessagesHandler{client: client, clarify: clarify, db: db, cfg: cfg, metrics: metrics, userTableSvc: userTableSvc}
}

// HandleSend 处理 POST /api/conversations/{id}/messages。
// 流程：
//  1. 解析 body
//  2. 取/建 conversation + catalog session
//  3. Clarifier 先跑（此时 DB 里不含当前 user message）
//  4. 反问分支：写两条 message 行(都 done)，推反问 SSE 返回
//  5. 合并分支：写 user done + assistant pending，推 message.created，转发上游 SSE+聚合
//  6. synthesis.done 后落库，推 message.persisted
//  7. ctx cancel → 保持 pending
func (h *MessagesHandler) HandleSend(w http.ResponseWriter, r *http.Request, conversationID string) {
	var req SendMessageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, fmt.Sprintf("invalid request: %v", err), http.StatusBadRequest)
		return
	}
	if req.Question == "" {
		http.Error(w, "question is required", http.StatusBadRequest)
		return
	}

	// 1. 取 conversation
	userID := UserIDFromContext(r.Context())
	conv, err := h.db.GetConversation(conversationID, userID)
	if err != nil {
		http.Error(w, fmt.Sprintf("get conversation: %v", err), http.StatusInternalServerError)
		return
	}
	if conv == nil {
		http.Error(w, "conversation not found", http.StatusNotFound)
		return
	}

	// 2. 若无 Catalog session，创建并写回
	catalogSessionID := conv.CatalogSessionID
	if catalogSessionID == "" {
		shortID := conversationID
		if len(shortID) > 8 {
			shortID = shortID[:8]
		}
		created, err := h.client.CreateSession(r.Context(), h.cfg.Catalog.WorkspaceID, "poc-"+shortID)
		if err != nil {
			log.Printf("session: create failed for %s: %v", conversationID, err)
			catalogSessionID = conversationID // fallback
		} else {
			catalogSessionID = created
			if err := h.db.UpdateCatalogSessionID(conversationID, created); err != nil {
				log.Printf("session: update catalog_session_id failed: %v", err)
			}
			log.Printf("session: mapped %s → %s", conversationID, created)
		}
	}

	// 3. Clarifier 先跑（此时 DB 里还没有当前 user message）
	processedQuestion := req.Question
	var clarifyReply string
	if h.clarify != nil {
		finalQ, reply, err := h.clarify.Process(r.Context(), conversationID, userID, processedQuestion)
		if err != nil {
			http.Error(w, fmt.Sprintf("clarify error: %v", err), http.StatusInternalServerError)
			return
		}
		if reply != "" {
			clarifyReply = reply
		} else {
			processedQuestion = finalQ
		}
	}

	// 4. 生成消息 id 并写两行
	userMsgID := NewMessageID()
	assistantMsgID := NewMessageID()

	if clarifyReply != "" {
		// 反问分支：两条 message 都写 done
		if err := h.db.InsertMessage(&StoredMessage{
			ID:             userMsgID,
			ConversationID: conversationID,
			Role:           "user",
			Content:        req.Question, // 反问用原问题，不用 merged
			Status:         "done",
		}); err != nil {
			http.Error(w, fmt.Sprintf("insert user message: %v", err), http.StatusInternalServerError)
			return
		}
		if err := h.db.InsertMessage(&StoredMessage{
			ID:             assistantMsgID,
			ConversationID: conversationID,
			Role:           "assistant",
			Content:        clarifyReply,
			Status:         "done",
		}); err != nil {
			http.Error(w, fmt.Sprintf("insert assistant message: %v", err), http.StatusInternalServerError)
			return
		}
		_ = h.db.UpdateTitleIfEmpty(conversationID, firstN(req.Question, 50))
		_ = h.db.UpdatePendingClarify(conversationID, req.Question)
		_ = h.db.TouchUpdatedAt(conversationID)

		writeClarifySSE(w, clarifyReply, userMsgID, assistantMsgID)
		return
	}

	// 合并分支
	// Content 存用户实际输入(req.Question)，而非 clarifier merge 后的整句；
	// processedQuestion 仅用于发给上游 Catalog。
	if err := h.db.InsertMessage(&StoredMessage{
		ID:             userMsgID,
		ConversationID: conversationID,
		Role:           "user",
		Content:        req.Question,
		Status:         "done",
	}); err != nil {
		http.Error(w, fmt.Sprintf("insert user message: %v", err), http.StatusInternalServerError)
		return
	}
	if err := h.db.InsertMessage(&StoredMessage{
		ID:             assistantMsgID,
		ConversationID: conversationID,
		Role:           "assistant",
		Content:        "",
		Status:         "pending",
	}); err != nil {
		http.Error(w, fmt.Sprintf("insert assistant message: %v", err), http.StatusInternalServerError)
		return
	}
	_ = h.db.UpdateTitleIfEmpty(conversationID, firstN(processedQuestion, 50))
	_ = h.db.UpdatePendingClarify(conversationID, "")
	_ = h.db.TouchUpdatedAt(conversationID)

	// 5. 设置 SSE 头
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher, canFlush := w.(http.Flusher)

	// 首个事件：message.created
	writeSSE(w, flusher, canFlush, "message.created", map[string]any{
		"event": "message.created",
		"data": map[string]string{
			"user_message_id":      userMsgID,
			"assistant_message_id": assistantMsgID,
		},
	})

	// 6. 构造上游 ExploreRequest
	exploreReq := &ExploreRequest{
		Query: QueryDomain{Question: processedQuestion},
		Session: SessionDomain{
			SessionID:   catalogSessionID,
			WorkspaceID: h.cfg.Catalog.WorkspaceID,
			UserID:      "poc-user",
		},
		DataSources: DataSourceDomain{
			Tables: &TableSource{
				DBName: h.cfg.Explore.DBName,
				TableList: func() []string {
					base := h.cfg.Explore.Tables
					if len(req.Tables) > 0 {
						base = req.Tables
					}
					if h.userTableSvc != nil {
						if userNames, err := h.userTableSvc.GetUserTableNames(r.Context(), userID); err == nil && len(userNames) > 0 {
							base = append(base, userNames...)
						}
					}
					return base
				}(),
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
			Memory: &MemoryConfig{
				EnableResultContext: true,
				EnableSummary:       true,
			},
		},
		Trace: TraceOptions{Enabled: true},
	}
	if h.cfg.Explore.LLMModel != "" {
		exploreReq.Options.LLM = &LLMConfig{Model: h.cfg.Explore.LLMModel}
	}

	stream, err := h.client.QueryStream(r.Context(), exploreReq)
	if err != nil {
		// 上游挂了，标记 failed
		_ = h.db.UpdateMessageStatus(assistantMsgID, "failed")
		writeSSE(w, flusher, canFlush, "run.error", map[string]any{
			"event": "run.error",
			"data":  map[string]any{"message": err.Error(), "recoverable": false},
		})
		return
	}
	defer stream.Close()

	// 记录该问题供 Clarifier 判断追问上下文（通过 DB 的 recent 已实现，此处无操作）

	// 7. 转发 SSE + 聚合
	ep := NewEventProcessor(h.metrics)
	scanner := bufio.NewScanner(stream)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	var eventBuf strings.Builder
	for scanner.Scan() {
		line := scanner.Text()
		eventBuf.WriteString(line)
		eventBuf.WriteString("\n")

		if strings.TrimSpace(line) == "" {
			for _, parsed := range ParseSSEBlock(eventBuf.String()) {
				for _, out := range ep.ProcessEvent(parsed) {
					_, _ = io.WriteString(w, FormatSSEEvent(out))
					if canFlush {
						flusher.Flush()
					}
				}
			}
			eventBuf.Reset()
		}
	}
	if eventBuf.Len() > 0 {
		for _, parsed := range ParseSSEBlock(eventBuf.String()) {
			for _, out := range ep.ProcessEvent(parsed) {
				_, _ = io.WriteString(w, FormatSSEEvent(out))
				if canFlush {
					flusher.Flush()
				}
			}
		}
	}

	// 8. 上游流正常结束 → 从聚合器取最终态落库
	if r.Context().Err() != nil {
		// 上下文已取消（客户端断开），保持 pending 不落库
		log.Printf("messages: ctx cancelled for assistant %s, keeping pending", assistantMsgID)
		return
	}

	final := ep.Aggregator().Finalize()
	final.ID = assistantMsgID
	final.ConversationID = conversationID
	final.Role = "assistant"
	// Status 已由 Finalize 根据事件推导
	if err := h.db.PersistAssistantMessage(final); err != nil {
		log.Printf("messages: persist assistant %s failed: %v", assistantMsgID, err)
	} else {
		writeSSE(w, flusher, canFlush, "message.persisted", map[string]any{
			"event": "message.persisted",
			"data": map[string]string{
				"assistant_message_id": assistantMsgID,
				"status":               final.Status,
			},
		})
	}
	_ = h.db.TouchUpdatedAt(conversationID)
}

// setCORSHeaders 沿用旧逻辑（供 ConversationsHandler 调用）。
func setCORSHeaders(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
}

// writeSSE 按 event + data 写一条 SSE 事件并 flush。
func writeSSE(w http.ResponseWriter, flusher http.Flusher, canFlush bool, event string, data map[string]any) {
	b, _ := json.Marshal(data)
	_, _ = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, string(b))
	if canFlush {
		flusher.Flush()
	}
}

// writeClarifySSE 推反问 SSE 流（包含 message.created 两条 id）。
func writeClarifySSE(w http.ResponseWriter, reply, userMsgID, assistantMsgID string) {
	setCORSHeaders(w)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	flusher, canFlush := w.(http.Flusher)
	runID := "clarify"

	writeSSE(w, flusher, canFlush, "message.created", map[string]any{
		"event": "message.created",
		"data": map[string]string{
			"user_message_id":      userMsgID,
			"assistant_message_id": assistantMsgID,
		},
	})

	writeSSE(w, flusher, canFlush, "run.started", map[string]any{
		"event":  "run.started",
		"run_id": runID,
		"data":   map[string]any{"run_id": runID},
	})

	writeSSE(w, flusher, canFlush, "synthesis.delta", map[string]any{
		"event":  "synthesis.delta",
		"run_id": runID,
		"data":   map[string]any{"block_type": "text", "delta": reply},
	})

	writeSSE(w, flusher, canFlush, "synthesis.done", map[string]any{
		"event":  "synthesis.done",
		"run_id": runID,
		"data":   map[string]any{},
	})

	writeSSE(w, flusher, canFlush, "run.completed", map[string]any{
		"event":  "run.completed",
		"run_id": runID,
		"data":   map[string]any{"status": "completed"},
	})

	writeSSE(w, flusher, canFlush, "message.persisted", map[string]any{
		"event": "message.persisted",
		"data": map[string]string{
			"assistant_message_id": assistantMsgID,
			"status":               "done",
		},
	})
}

// firstN 返回 str 的前 n 个 rune（按字符数截断，避免 UTF-8 中间截断）。
func firstN(str string, n int) string {
	runes := []rune(str)
	if len(runes) <= n {
		return str
	}
	return string(runes[:n])
}
