# Query Feedback & Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "feedback & analysis" feature so users can report inaccurate query results, trigger background LLM analysis, and view structured optimization suggestions in a dedicated Analysis Center page.

**Architecture:** New `/api/feedback` REST endpoints backed by SQLite. Background goroutine collects schema/knowledge/sample data context and calls Catalog LLM API with deep thinking enabled. Frontend adds a feedback button on message bubbles and a new Analysis Center panel.

**Tech Stack:** Go (backend), SQLite via `modernc.org/sqlite`, React + TypeScript (frontend), Catalog LLM API (qwen3-max with enable_thinking)

---

### Task 1: SQLite Database Layer

**Files:**
- Create: `backend/feedbackdb.go`

- [ ] **Step 1: Add sqlite dependency**

```bash
cd backend && go get modernc.org/sqlite
```

- [ ] **Step 2: Create feedbackdb.go**

```go
package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

type FeedbackTask struct {
	ID         string          `json:"id"`
	Status     string          `json:"status"`
	CreatedAt  string          `json:"created_at"`
	Question   string          `json:"question"`
	UserNote   string          `json:"user_note,omitempty"`
	SQL        string          `json:"sql"`
	SQLResult  json.RawMessage `json:"sql_result,omitempty"`
	SessionID  string          `json:"session_id,omitempty"`
	Analysis   json.RawMessage `json:"analysis,omitempty"`
	ErrorMsg   string          `json:"error_msg,omitempty"`
	FinishedAt string          `json:"finished_at,omitempty"`
}

type FeedbackDB struct {
	db *sql.DB
}

func NewFeedbackDB(dataDir string) (*FeedbackDB, error) {
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		return nil, fmt.Errorf("create data dir: %w", err)
	}
	dbPath := filepath.Join(dataDir, "feedback.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	_, err = db.Exec(`CREATE TABLE IF NOT EXISTS feedback_tasks (
		id          TEXT PRIMARY KEY,
		status      TEXT NOT NULL DEFAULT 'pending',
		created_at  TEXT NOT NULL,
		question    TEXT NOT NULL,
		user_note   TEXT,
		sql_text    TEXT NOT NULL,
		sql_result  TEXT,
		session_id  TEXT,
		analysis    TEXT,
		error_msg   TEXT,
		finished_at TEXT
	)`)
	if err != nil {
		return nil, fmt.Errorf("create table: %w", err)
	}
	return &FeedbackDB{db: db}, nil
}

func (f *FeedbackDB) Insert(task *FeedbackTask) error {
	_, err := f.db.Exec(
		`INSERT INTO feedback_tasks (id, status, created_at, question, user_note, sql_text, sql_result, session_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		task.ID, task.Status, task.CreatedAt, task.Question, task.UserNote,
		task.SQL, string(task.SQLResult), task.SessionID,
	)
	return err
}

func (f *FeedbackDB) UpdateStatus(id, status string) error {
	_, err := f.db.Exec(`UPDATE feedback_tasks SET status = ? WHERE id = ?`, status, id)
	return err
}

func (f *FeedbackDB) UpdateResult(id string, analysis json.RawMessage) error {
	now := time.Now().Format(time.RFC3339)
	_, err := f.db.Exec(
		`UPDATE feedback_tasks SET status = 'done', analysis = ?, finished_at = ? WHERE id = ?`,
		string(analysis), now, id,
	)
	return err
}

func (f *FeedbackDB) UpdateError(id, errMsg string) error {
	now := time.Now().Format(time.RFC3339)
	_, err := f.db.Exec(
		`UPDATE feedback_tasks SET status = 'error', error_msg = ?, finished_at = ? WHERE id = ?`,
		errMsg, now, id,
	)
	return err
}

func (f *FeedbackDB) Get(id string) (*FeedbackTask, error) {
	row := f.db.QueryRow(
		`SELECT id, status, created_at, question, user_note, sql_text, sql_result, session_id, analysis, error_msg, finished_at
		 FROM feedback_tasks WHERE id = ?`, id,
	)
	return scanTask(row)
}

func (f *FeedbackDB) List() ([]*FeedbackTask, error) {
	rows, err := f.db.Query(
		`SELECT id, status, created_at, question, user_note, sql_text, sql_result, session_id, analysis, error_msg, finished_at
		 FROM feedback_tasks ORDER BY created_at DESC`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var tasks []*FeedbackTask
	for rows.Next() {
		t, err := scanTaskRows(rows)
		if err != nil {
			return nil, err
		}
		tasks = append(tasks, t)
	}
	return tasks, nil
}

type scanner interface {
	Scan(dest ...any) error
}

func scanTask(s scanner) (*FeedbackTask, error) {
	var t FeedbackTask
	var userNote, sqlResult, sessionID, analysis, errorMsg, finishedAt sql.NullString
	err := s.Scan(&t.ID, &t.Status, &t.CreatedAt, &t.Question, &userNote,
		&t.SQL, &sqlResult, &sessionID, &analysis, &errorMsg, &finishedAt)
	if err != nil {
		return nil, err
	}
	t.UserNote = userNote.String
	t.SessionID = sessionID.String
	t.ErrorMsg = errorMsg.String
	t.FinishedAt = finishedAt.String
	if sqlResult.Valid {
		t.SQLResult = json.RawMessage(sqlResult.String)
	}
	if analysis.Valid {
		t.Analysis = json.RawMessage(analysis.String)
	}
	return &t, nil
}

func scanTaskRows(rows *sql.Rows) (*FeedbackTask, error) {
	var t FeedbackTask
	var userNote, sqlResult, sessionID, analysis, errorMsg, finishedAt sql.NullString
	err := rows.Scan(&t.ID, &t.Status, &t.CreatedAt, &t.Question, &userNote,
		&t.SQL, &sqlResult, &sessionID, &analysis, &errorMsg, &finishedAt)
	if err != nil {
		return nil, err
	}
	t.UserNote = userNote.String
	t.SessionID = sessionID.String
	t.ErrorMsg = errorMsg.String
	t.FinishedAt = finishedAt.String
	if sqlResult.Valid {
		t.SQLResult = json.RawMessage(sqlResult.String)
	}
	if analysis.Valid {
		t.Analysis = json.RawMessage(analysis.String)
	}
	return &t, nil
}
```

- [ ] **Step 3: Verify it compiles**

```bash
cd backend && go build ./...
```
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add backend/feedbackdb.go backend/go.mod backend/go.sum
git commit -m "feat(feedback): add SQLite database layer for feedback tasks"
```

---

### Task 2: Feedback Analyzer (Context Collection + LLM Call)

**Files:**
- Create: `backend/feedback.go`

- [ ] **Step 1: Create feedback.go with Analyzer**

```go
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"regexp"
	"strings"
)

const feedbackSystemPrompt = `你是一个专业的 NL2SQL 分析专家。用户提交了一个自然语言查询，系统生成了 SQL 并返回了结果，但用户认为结果不准确。

请分析以下信息，找出 SQL 可能存在的问题，并给出优化建议。

分析要求：
1. 对比用户问题的语义和生成 SQL 的逻辑，找出不匹配之处
2. 检查 SQL 是否正确使用了预计算列（如 trade_date, avg_vol_30d, industry_name, consecutive_above_ma3 等）
3. 检查是否遗漏了必要的过滤条件（如衍生品排除 SISTKC < '10000'、新闻去重等）
4. 检查是否违反了知识库中的业务规则
5. 检查 SQL 方言是否兼容 MatrixOne（如 RIGHT() 不支持、CHANGE 是保留字等）
6. 如果能修正，给出修正后的 SQL

请用中文回答。返回 JSON 格式（不要包含其他内容）：
{
  "problems": [{"severity": "high|medium|low", "description": "问题描述"}],
  "suggestions": [{"type": "knowledge|schema|fewshot", "description": "建议摘要", "detail": "具体操作建议"}],
  "corrected_sql": "修正后的 SQL，如果无法修正则为空字符串"
}`

var tableNameRe = regexp.MustCompile(`(?i)(?:FROM|JOIN)\s+(\w+)`)

type FeedbackAnalyzer struct {
	catalogURL  string
	apiKey      string
	workspaceID string
	model       string
	db          *FeedbackDB
	clarifier   *Clarifier // reuse callLLM
}

func NewFeedbackAnalyzer(cfg *Config, db *FeedbackDB, clarifier *Clarifier) *FeedbackAnalyzer {
	return &FeedbackAnalyzer{
		catalogURL:  cfg.Catalog.URL,
		apiKey:      cfg.Catalog.APIKey,
		workspaceID: cfg.Catalog.WorkspaceID,
		model:       cfg.Explore.LLMModel,
		db:          db,
		clarifier:   clarifier,
	}
}

func (a *FeedbackAnalyzer) RunAsync(task *FeedbackTask) {
	go func() {
		if err := a.db.UpdateStatus(task.ID, "analyzing"); err != nil {
			log.Printf("feedback: update status error: %v", err)
			return
		}
		ctx := context.Background()
		result, err := a.analyze(ctx, task)
		if err != nil {
			log.Printf("feedback: analysis error for %s: %v", task.ID, err)
			a.db.UpdateError(task.ID, err.Error())
			return
		}
		if err := a.db.UpdateResult(task.ID, result); err != nil {
			log.Printf("feedback: save result error: %v", err)
		}
		log.Printf("feedback: analysis done for %s", task.ID)
	}()
}

func (a *FeedbackAnalyzer) analyze(ctx context.Context, task *FeedbackTask) (json.RawMessage, error) {
	// Extract table names from SQL
	tables := extractTableNames(task.SQL)

	// Collect context
	var sections []string
	sections = append(sections, fmt.Sprintf("## 用户问题\n%s", task.Question))
	if task.UserNote != "" {
		sections = append(sections, fmt.Sprintf("## 用户反馈\n%s", task.UserNote))
	}
	sections = append(sections, fmt.Sprintf("## 生成的 SQL\n```sql\n%s\n```", task.SQL))

	if len(task.SQLResult) > 0 {
		sections = append(sections, fmt.Sprintf("## SQL 执行结果\n```json\n%s\n```", truncateResult(task.SQLResult, 20)))
	}

	// Schema
	schema := a.fetchSchema(ctx, tables)
	if schema != "" {
		sections = append(sections, fmt.Sprintf("## 涉及表的 Schema（含列注释）\n%s", schema))
	}

	// Sample data
	samples := a.fetchSampleData(ctx, tables)
	if samples != "" {
		sections = append(sections, fmt.Sprintf("## 示例数据（每表前5行）\n%s", samples))
	}

	// Knowledge rules
	rules := a.fetchKnowledgeRules(ctx)
	if rules != "" {
		sections = append(sections, fmt.Sprintf("## 知识库规则\n%s", rules))
	}

	userContent := strings.Join(sections, "\n\n")

	// Call LLM with thinking enabled
	content, err := a.callLLMWithThinking(ctx, feedbackSystemPrompt, userContent)
	if err != nil {
		return nil, fmt.Errorf("LLM call: %w", err)
	}

	// Extract JSON from response
	jsonStr := extractJSON(content)
	if jsonStr == "" {
		return nil, fmt.Errorf("no JSON in LLM response: %s", content[:min(len(content), 200)])
	}

	// Validate JSON
	var check map[string]any
	if err := json.Unmarshal([]byte(jsonStr), &check); err != nil {
		return nil, fmt.Errorf("invalid JSON: %w", err)
	}

	return json.RawMessage(jsonStr), nil
}

func (a *FeedbackAnalyzer) callLLMWithThinking(ctx context.Context, systemPrompt, userContent string) (string, error) {
	reqBody := map[string]any{
		"model": a.model,
		"messages": []map[string]string{
			{"role": "system", "content": systemPrompt},
			{"role": "user", "content": userContent},
		},
		"temperature":     0,
		"enable_thinking": true,
	}
	// Reuse clarifier's HTTP call pattern
	return a.clarifier.callLLMRaw(ctx, reqBody)
}

func (a *FeedbackAnalyzer) fetchSchema(ctx context.Context, tables []string) string {
	if len(tables) == 0 {
		return ""
	}
	endpoint := fmt.Sprintf("%s/api/v1/workspaces/%s", a.catalogURL, a.workspaceID)
	// Get account name for DB query
	// Use Catalog workspace API to get account, then query information_schema
	// For simplicity, build schema description from Catalog's table metadata
	var sb strings.Builder
	for _, table := range tables {
		sb.WriteString(fmt.Sprintf("### %s\n", table))
		cols := a.fetchColumnsFromCatalog(ctx, table)
		if cols != "" {
			sb.WriteString(cols)
		}
		sb.WriteString("\n")
	}
	_ = endpoint
	return sb.String()
}

func (a *FeedbackAnalyzer) fetchColumnsFromCatalog(ctx context.Context, table string) string {
	// Call Catalog API to get table schema with comments
	url := fmt.Sprintf("%s/api/v1/workspaces/%s/sql-databases/hk_sfc/tables/%s/schema",
		a.catalogURL, a.workspaceID, table)
	resp, err := httpGetWithKey(ctx, url, a.apiKey)
	if err != nil {
		log.Printf("feedback: fetch schema for %s: %v", table, err)
		return ""
	}
	// Parse and format schema
	var schema struct {
		Data struct {
			Columns []struct {
				Name    string `json:"column_name"`
				Type    string `json:"column_type"`
				Comment string `json:"column_comment"`
			} `json:"columns"`
		} `json:"data"`
	}
	if err := json.Unmarshal(resp, &schema); err != nil {
		// Fallback: return raw
		return string(resp)
	}
	var sb strings.Builder
	for _, col := range schema.Data.Columns {
		comment := col.Comment
		if comment == "" {
			comment = "-"
		}
		sb.WriteString(fmt.Sprintf("- %s %s -- %s\n", col.Name, col.Type, comment))
	}
	return sb.String()
}

func (a *FeedbackAnalyzer) fetchSampleData(ctx context.Context, tables []string) string {
	// Use Catalog explore to run sample queries
	// For POC simplicity, skip if not easily available
	// Could call Catalog SQL execution API
	return "" // TODO: implement if Catalog has direct SQL exec API
}

func (a *FeedbackAnalyzer) fetchKnowledgeRules(ctx context.Context) string {
	url := fmt.Sprintf("%s/api/v1/workspaces/%s/nl2sql-knowledge/list",
		a.catalogURL, a.workspaceID)

	body := []byte(`{"page_size":100}`)
	resp, err := httpPostWithKey(ctx, url, a.apiKey, body)
	if err != nil {
		log.Printf("feedback: fetch knowledge rules: %v", err)
		return ""
	}

	var result struct {
		Data struct {
			Items []struct {
				Type  string   `json:"knowledge_type"`
				Key   string   `json:"knowledge_key"`
				Value []string `json:"knowledge_value"`
			} `json:"items"`
		} `json:"data"`
	}
	if err := json.Unmarshal(resp, &result); err != nil {
		return ""
	}

	var sb strings.Builder
	for _, item := range result.Data.Items {
		sb.WriteString(fmt.Sprintf("- [%s] %s: %s\n", item.Type, item.Key, strings.Join(item.Value, "; ")))
	}
	return sb.String()
}

func extractTableNames(sql string) []string {
	matches := tableNameRe.FindAllStringSubmatch(sql, -1)
	seen := make(map[string]bool)
	var tables []string
	for _, m := range matches {
		name := strings.ToLower(m[1])
		if !seen[name] {
			seen[name] = true
			tables = append(tables, name)
		}
	}
	return tables
}

func truncateResult(raw json.RawMessage, maxRows int) string {
	var data struct {
		Columns    []string        `json:"columns"`
		Rows       [][]interface{} `json:"rows"`
		TotalCount int             `json:"total_count"`
	}
	if err := json.Unmarshal(raw, &data); err != nil {
		return string(raw)
	}
	if len(data.Rows) > maxRows {
		data.Rows = data.Rows[:maxRows]
	}
	out, _ := json.MarshalIndent(data, "", "  ")
	return string(out)
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
```

- [ ] **Step 2: Add helper HTTP functions and extend Clarifier**

Add to `backend/clarify.go` — a new method `callLLMRaw` that accepts a pre-built request body (to support `enable_thinking`):

Append to `backend/clarify.go`:
```go
// callLLMRaw calls Catalog LLM API with a pre-built request body.
func (c *Clarifier) callLLMRaw(ctx context.Context, reqBody map[string]any) (string, error) {
	bodyBytes, err := json.Marshal(reqBody)
	if err != nil {
		return "", fmt.Errorf("marshal: %w", err)
	}

	endpoint := fmt.Sprintf("%s/api/v1/workspaces/%s/llm/chat/completions", c.catalogURL, c.workspaceID)
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(bodyBytes))
	if err != nil {
		return "", fmt.Errorf("create request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("X-API-Key", c.apiKey)

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return "", fmt.Errorf("do request: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("LLM returned %d: %s", resp.StatusCode, string(respBody))
	}

	var llmResp struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(respBody, &llmResp); err != nil {
		return "", fmt.Errorf("parse response: %w", err)
	}

	if len(llmResp.Choices) == 0 {
		return "", fmt.Errorf("empty choices")
	}

	return llmResp.Choices[0].Message.Content, nil
}
```

Add HTTP helper functions to `backend/feedback.go`:
```go
func httpGetWithKey(ctx context.Context, url, apiKey string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-API-Key", apiKey)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	return io.ReadAll(resp.Body)
}

func httpPostWithKey(ctx context.Context, url, apiKey string, body []byte) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-Key", apiKey)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	return io.ReadAll(resp.Body)
}
```

Add missing imports to `feedback.go`:
```go
import (
	"bytes"
	"io"
	"net/http"
)
```

- [ ] **Step 3: Verify it compiles**

```bash
cd backend && go build ./...
```

- [ ] **Step 4: Commit**

```bash
git add backend/feedback.go backend/clarify.go
git commit -m "feat(feedback): add analyzer with context collection and LLM call"
```

---

### Task 3: Feedback HTTP Handler + Route Registration

**Files:**
- Create: `backend/feedback_handler.go`
- Modify: `backend/main.go`

- [ ] **Step 1: Create feedback_handler.go**

```go
package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"
)

type FeedbackHandler struct {
	db       *FeedbackDB
	analyzer *FeedbackAnalyzer
}

func NewFeedbackHandler(db *FeedbackDB, analyzer *FeedbackAnalyzer) *FeedbackHandler {
	return &FeedbackHandler{db: db, analyzer: analyzer}
}

func (h *FeedbackHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}

	// Route: POST /api/feedback → create
	// Route: GET /api/feedback → list
	// Route: GET /api/feedback/{id} → get
	path := strings.TrimPrefix(r.URL.Path, "/api/feedback")
	path = strings.TrimPrefix(path, "/")

	switch {
	case r.Method == http.MethodPost && path == "":
		h.create(w, r)
	case r.Method == http.MethodGet && path == "":
		h.list(w, r)
	case r.Method == http.MethodGet && path != "":
		h.get(w, r, path)
	default:
		http.Error(w, "not found", http.StatusNotFound)
	}
}

func (h *FeedbackHandler) create(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Question  string          `json:"question"`
		UserNote  string          `json:"user_note"`
		SQL       string          `json:"sql"`
		SQLResult json.RawMessage `json:"sql_result"`
		SessionID string          `json:"session_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	if req.Question == "" || req.SQL == "" {
		http.Error(w, "question and sql are required", http.StatusBadRequest)
		return
	}

	task := &FeedbackTask{
		ID:        fmt.Sprintf("fb_%d", time.Now().UnixMilli()),
		Status:    "pending",
		CreatedAt: time.Now().Format(time.RFC3339),
		Question:  req.Question,
		UserNote:  req.UserNote,
		SQL:       req.SQL,
		SQLResult: req.SQLResult,
		SessionID: req.SessionID,
	}

	if err := h.db.Insert(task); err != nil {
		log.Printf("feedback: insert error: %v", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	h.analyzer.RunAsync(task)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"id":     task.ID,
		"status": task.Status,
	})
}

func (h *FeedbackHandler) list(w http.ResponseWriter, r *http.Request) {
	tasks, err := h.db.List()
	if err != nil {
		log.Printf("feedback: list error: %v", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if tasks == nil {
		tasks = []*FeedbackTask{}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"tasks": tasks})
}

func (h *FeedbackHandler) get(w http.ResponseWriter, r *http.Request, id string) {
	task, err := h.db.Get(id)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(task)
}
```

- [ ] **Step 2: Register routes in main.go**

In `backend/main.go`, add after `knowledgeHandler` registration:

```go
	// Feedback analysis
	feedbackDB, err := NewFeedbackDB("data")
	if err != nil {
		log.Fatalf("init feedback db: %v", err)
	}
	analyzer := NewFeedbackAnalyzer(cfg, feedbackDB, clarifier)
	feedbackHandler := NewFeedbackHandler(feedbackDB, analyzer)
	mux.Handle("/api/feedback/", feedbackHandler)
	mux.Handle("/api/feedback", feedbackHandler)
```

- [ ] **Step 3: Verify it compiles and runs**

```bash
cd backend && go build -o hk-poc-backend && echo "build ok"
```

- [ ] **Step 4: Commit**

```bash
git add backend/feedback_handler.go backend/main.go
git commit -m "feat(feedback): add HTTP handler and register routes"
```

---

### Task 4: Frontend — FeedbackButton Component

**Files:**
- Create: `web/src/components/FeedbackButton.tsx`

- [ ] **Step 1: Create FeedbackButton.tsx**

```tsx
import { useState } from 'react'
import { useT } from '../i18n'
import type { SQLResult } from '../types'

interface FeedbackButtonProps {
  question: string
  sql: string
  sqlResult: SQLResult | null
  sessionId: string
}

export function FeedbackButton({ question, sql, sqlResult, sessionId }: FeedbackButtonProps) {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async () => {
    setSubmitting(true)
    try {
      await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question,
          user_note: note || undefined,
          sql,
          sql_result: sqlResult ? {
            columns: sqlResult.columns,
            rows: sqlResult.rows,
            total_count: sqlResult.total_count,
          } : undefined,
          session_id: sessionId,
        }),
      })
      setSubmitted(true)
    } catch (e) {
      console.error('feedback submit error:', e)
    } finally {
      setSubmitting(false)
    }
  }

  if (submitted) {
    return (
      <div className="feedback-submitted">
        {t('feedbackSubmitted')}
      </div>
    )
  }

  if (!open) {
    return (
      <button className="feedback-btn" onClick={() => setOpen(true)}>
        {t('feedbackBtn')}
      </button>
    )
  }

  return (
    <div className="feedback-form">
      <textarea
        className="feedback-textarea"
        placeholder={t('feedbackPlaceholder')}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
      />
      <div className="feedback-actions">
        <button className="feedback-cancel" onClick={() => setOpen(false)}>
          {t('knowledgeCancel')}
        </button>
        <button
          className="feedback-submit"
          onClick={handleSubmit}
          disabled={submitting}
        >
          {submitting ? '...' : t('feedbackSubmitBtn')}
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Add i18n keys**

Add to `web/src/i18n/zh.json`:
```json
  "feedbackBtn": "结果不准确？",
  "feedbackPlaceholder": "请描述哪里不对（可选）",
  "feedbackSubmitBtn": "提交反馈",
  "feedbackSubmitted": "已提交分析任务，可在分析中心查看",
  "analysisCenter": "分析中心",
  "analysisEmpty": "暂无分析任务",
  "analysisStatus_pending": "等待中",
  "analysisStatus_analyzing": "分析中",
  "analysisStatus_done": "已完成",
  "analysisStatus_error": "失败",
  "analysisProblem": "发现的问题",
  "analysisSuggestion": "优化建议",
  "analysisCorrectedSQL": "修正 SQL",
  "analysisUserNote": "用户备注",
  "analysisOriginalSQL": "生成的 SQL"
```

Add to `web/src/i18n/en.json`:
```json
  "feedbackBtn": "Inaccurate result?",
  "feedbackPlaceholder": "Describe what's wrong (optional)",
  "feedbackSubmitBtn": "Submit Feedback",
  "feedbackSubmitted": "Analysis task submitted. View in Analysis Center.",
  "analysisCenter": "Analysis Center",
  "analysisEmpty": "No analysis tasks yet",
  "analysisStatus_pending": "Pending",
  "analysisStatus_analyzing": "Analyzing",
  "analysisStatus_done": "Done",
  "analysisStatus_error": "Error",
  "analysisProblem": "Problems Found",
  "analysisSuggestion": "Suggestions",
  "analysisCorrectedSQL": "Corrected SQL",
  "analysisUserNote": "User Note",
  "analysisOriginalSQL": "Generated SQL"
```

- [ ] **Step 3: Add FeedbackButton to MessageBubble.tsx**

In `web/src/components/MessageBubble.tsx`, add import:
```tsx
import { FeedbackButton } from './FeedbackButton'
```

After the SQL toggle section (line ~116, before the closing `</div>` of `message-bubble`), add:
```tsx
          {/* Feedback button — after SQL section */}
          {!isUser && isDone && message.sqlResults.length > 0 && (
            <FeedbackButton
              question={message.feedbackQuestion || ''}
              sql={message.sqlStatements[message.sqlStatements.length - 1] || ''}
              sqlResult={message.sqlResults[message.sqlResults.length - 1] || null}
              sessionId=""
            />
          )}
```

Note: `feedbackQuestion` needs to be the user's original question. We'll pass it through the Message type. Add to `types.ts`:
```typescript
  feedbackQuestion?: string  // original user question for feedback
```

And in `ChatPanel.tsx`, when creating the assistant message, set `feedbackQuestion` from the user's question.

- [ ] **Step 4: Verify frontend compiles**

```bash
cd web && npm run build
```

- [ ] **Step 5: Commit**

```bash
git add web/src/components/FeedbackButton.tsx web/src/components/MessageBubble.tsx web/src/types.ts web/src/i18n/zh.json web/src/i18n/en.json
git commit -m "feat(feedback): add FeedbackButton component on message bubbles"
```

---

### Task 5: Frontend — AnalysisPanel Page

**Files:**
- Create: `web/src/components/AnalysisPanel.tsx`
- Create: `web/src/components/AnalysisPanel.css`
- Modify: `web/src/App.tsx`

- [ ] **Step 1: Create AnalysisPanel.tsx**

```tsx
import { useState, useEffect, useRef } from 'react'
import { useT } from '../i18n'
import './AnalysisPanel.css'

interface Problem {
  severity: string
  description: string
}

interface Suggestion {
  type: string
  description: string
  detail: string
}

interface Analysis {
  problems: Problem[]
  suggestions: Suggestion[]
  corrected_sql: string
}

interface Task {
  id: string
  status: string
  created_at: string
  question: string
  user_note: string
  sql: string
  sql_result: any
  analysis: Analysis | null
  error_msg: string
}

interface AnalysisPanelProps {
  open: boolean
  onClose: () => void
}

const severityColors: Record<string, string> = {
  high: '#e53e3e',
  medium: '#dd6b20',
  low: '#3182ce',
}

const typeLabels: Record<string, string> = {
  knowledge: 'Knowledge Rule',
  schema: 'Schema Change',
  fewshot: 'Fewshot Example',
}

export function AnalysisPanel({ open, onClose }: AnalysisPanelProps) {
  const { t } = useT()
  const [tasks, setTasks] = useState<Task[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const intervalRef = useRef<number | null>(null)

  const fetchTasks = async () => {
    try {
      const resp = await fetch('/api/feedback')
      const data = await resp.json()
      setTasks(data.tasks || [])
    } catch (e) {
      console.error('fetch feedback tasks:', e)
    }
  }

  useEffect(() => {
    if (!open) {
      if (intervalRef.current) clearInterval(intervalRef.current)
      return
    }
    fetchTasks()
    const hasActive = tasks.some((t) => t.status === 'pending' || t.status === 'analyzing')
    if (hasActive) {
      intervalRef.current = window.setInterval(fetchTasks, 5000)
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [open, tasks.some((t) => t.status === 'pending' || t.status === 'analyzing')])

  if (!open) return null

  const selected = tasks.find((t) => t.id === selectedId)

  return (
    <div className="analysis-overlay" onClick={onClose}>
      <div className="analysis-panel" onClick={(e) => e.stopPropagation()}>
        <div className="analysis-header">
          <h2>{t('analysisCenter')}</h2>
          <button className="analysis-close" onClick={onClose}>x</button>
        </div>

        <div className="analysis-body">
          {/* Task list */}
          <div className="analysis-list">
            {tasks.length === 0 && (
              <div className="analysis-empty">{t('analysisEmpty')}</div>
            )}
            {tasks.map((task) => (
              <div
                key={task.id}
                className={`analysis-item ${selectedId === task.id ? 'active' : ''}`}
                onClick={() => setSelectedId(task.id)}
              >
                <span className={`analysis-status ${task.status}`}>
                  {t(`analysisStatus_${task.status}` as any)}
                </span>
                <span className="analysis-question">
                  {task.question.slice(0, 40)}
                  {task.question.length > 40 ? '...' : ''}
                </span>
                <span className="analysis-time">
                  {new Date(task.created_at).toLocaleTimeString()}
                </span>
              </div>
            ))}
          </div>

          {/* Detail view */}
          <div className="analysis-detail">
            {!selected ? (
              <div className="analysis-empty">Select a task to view details</div>
            ) : (
              <div className="analysis-detail-content">
                <h3>{selected.question}</h3>
                {selected.user_note && (
                  <div className="analysis-section">
                    <h4>{t('analysisUserNote')}</h4>
                    <p>{selected.user_note}</p>
                  </div>
                )}
                <div className="analysis-section">
                  <h4>{t('analysisOriginalSQL')}</h4>
                  <pre className="analysis-sql">{selected.sql}</pre>
                </div>

                {selected.status === 'analyzing' && (
                  <div className="analysis-loading">
                    <div className="phase-spinner" />
                    <span>{t('analysisStatus_analyzing')}</span>
                  </div>
                )}

                {selected.status === 'error' && (
                  <div className="analysis-error">{selected.error_msg}</div>
                )}

                {selected.analysis && (
                  <>
                    {selected.analysis.problems?.length > 0 && (
                      <div className="analysis-section">
                        <h4>{t('analysisProblem')}</h4>
                        {selected.analysis.problems.map((p, i) => (
                          <div key={i} className="analysis-problem">
                            <span
                              className="severity-badge"
                              style={{ backgroundColor: severityColors[p.severity] || '#718096' }}
                            >
                              {p.severity}
                            </span>
                            <span>{p.description}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {selected.analysis.suggestions?.length > 0 && (
                      <div className="analysis-section">
                        <h4>{t('analysisSuggestion')}</h4>
                        {selected.analysis.suggestions.map((s, i) => (
                          <div key={i} className="analysis-suggestion">
                            <span className="suggestion-type">
                              {typeLabels[s.type] || s.type}
                            </span>
                            <strong>{s.description}</strong>
                            <p>{s.detail}</p>
                          </div>
                        ))}
                      </div>
                    )}

                    {selected.analysis.corrected_sql && (
                      <div className="analysis-section">
                        <h4>{t('analysisCorrectedSQL')}</h4>
                        <div className="analysis-sql-wrapper">
                          <pre className="analysis-sql">{selected.analysis.corrected_sql}</pre>
                          <button
                            className="sql-copy-btn"
                            onClick={() => navigator.clipboard.writeText(selected.analysis!.corrected_sql)}
                          >
                            Copy
                          </button>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Create AnalysisPanel.css**

```css
.analysis-overlay {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.5);
  z-index: 1000;
  display: flex; justify-content: center; align-items: center;
}
.analysis-panel {
  background: #fff; border-radius: 12px;
  width: 90vw; max-width: 1100px; height: 80vh;
  display: flex; flex-direction: column;
  box-shadow: 0 20px 60px rgba(0,0,0,0.3);
}
.analysis-header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 16px 24px; border-bottom: 1px solid #e2e8f0;
}
.analysis-header h2 { margin: 0; font-size: 18px; }
.analysis-close {
  background: none; border: none; font-size: 20px; cursor: pointer; color: #718096;
}
.analysis-body {
  display: flex; flex: 1; overflow: hidden;
}
.analysis-list {
  width: 320px; border-right: 1px solid #e2e8f0;
  overflow-y: auto; padding: 8px;
}
.analysis-item {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 12px; border-radius: 8px; cursor: pointer;
  font-size: 13px;
}
.analysis-item:hover { background: #f7fafc; }
.analysis-item.active { background: #ebf8ff; }
.analysis-status {
  font-size: 11px; padding: 2px 8px; border-radius: 10px;
  white-space: nowrap; font-weight: 600;
}
.analysis-status.pending { background: #fefcbf; color: #975a16; }
.analysis-status.analyzing { background: #bee3f8; color: #2a4365; }
.analysis-status.done { background: #c6f6d5; color: #276749; }
.analysis-status.error { background: #fed7d7; color: #9b2c2c; }
.analysis-question { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.analysis-time { color: #a0aec0; font-size: 12px; white-space: nowrap; }
.analysis-detail {
  flex: 1; overflow-y: auto; padding: 20px 24px;
}
.analysis-detail-content h3 { margin: 0 0 16px; font-size: 16px; }
.analysis-section { margin-bottom: 20px; }
.analysis-section h4 { margin: 0 0 8px; font-size: 14px; color: #4a5568; }
.analysis-sql {
  background: #1a202c; color: #e2e8f0; padding: 12px;
  border-radius: 8px; font-size: 13px; overflow-x: auto;
  white-space: pre-wrap; word-break: break-all;
}
.analysis-sql-wrapper { position: relative; }
.analysis-sql-wrapper .sql-copy-btn {
  position: absolute; top: 8px; right: 8px;
}
.analysis-problem {
  display: flex; align-items: flex-start; gap: 8px;
  margin-bottom: 8px; font-size: 14px;
}
.severity-badge {
  font-size: 11px; padding: 2px 8px; border-radius: 10px;
  color: #fff; font-weight: 600; white-space: nowrap;
}
.analysis-suggestion {
  margin-bottom: 12px; padding: 12px; background: #f7fafc;
  border-radius: 8px; border-left: 3px solid #4299e1;
}
.suggestion-type {
  font-size: 11px; background: #ebf8ff; color: #2b6cb0;
  padding: 2px 6px; border-radius: 4px; margin-right: 8px;
}
.analysis-suggestion p { margin: 4px 0 0; font-size: 13px; color: #4a5568; }
.analysis-loading {
  display: flex; align-items: center; gap: 8px;
  padding: 20px; color: #4a5568;
}
.analysis-error {
  padding: 12px; background: #fff5f5; color: #c53030;
  border-radius: 8px; font-size: 13px;
}
.analysis-empty {
  padding: 40px; text-align: center; color: #a0aec0;
}
.feedback-btn {
  background: none; border: 1px solid #e2e8f0; border-radius: 6px;
  padding: 4px 12px; font-size: 12px; color: #718096;
  cursor: pointer; margin-top: 8px;
}
.feedback-btn:hover { background: #f7fafc; border-color: #cbd5e0; }
.feedback-form {
  margin-top: 8px; padding: 12px; background: #f7fafc;
  border-radius: 8px; border: 1px solid #e2e8f0;
}
.feedback-textarea {
  width: 100%; border: 1px solid #e2e8f0; border-radius: 6px;
  padding: 8px; font-size: 13px; resize: none; font-family: inherit;
}
.feedback-actions {
  display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px;
}
.feedback-cancel {
  background: none; border: 1px solid #e2e8f0; border-radius: 6px;
  padding: 4px 12px; font-size: 12px; cursor: pointer;
}
.feedback-submit {
  background: #4299e1; color: #fff; border: none; border-radius: 6px;
  padding: 4px 16px; font-size: 12px; cursor: pointer;
}
.feedback-submit:disabled { opacity: 0.6; }
.feedback-submitted {
  margin-top: 8px; font-size: 12px; color: #38a169;
}
```

- [ ] **Step 3: Add Analysis Center button to App.tsx**

In `web/src/App.tsx`, add import:
```tsx
import { AnalysisPanel } from './components/AnalysisPanel'
```

Add state:
```tsx
const [analysisOpen, setAnalysisOpen] = useState(false)
```

Add button next to Knowledge button in header:
```tsx
            <button
              className="lang-switch"
              onClick={() => setAnalysisOpen(true)}
            >
              {t('analysisCenter')}
            </button>
```

Add panel at bottom (next to KnowledgePanel):
```tsx
      <AnalysisPanel open={analysisOpen} onClose={() => setAnalysisOpen(false)} />
```

- [ ] **Step 4: Verify frontend builds**

```bash
cd web && npm run build
```

- [ ] **Step 5: Commit**

```bash
git add web/src/components/AnalysisPanel.tsx web/src/components/AnalysisPanel.css web/src/App.tsx
git commit -m "feat(feedback): add Analysis Center panel with task list and detail view"
```

---

### Task 6: Integration — Wire Up feedbackQuestion in ChatPanel

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/components/ChatPanel.tsx`

- [ ] **Step 1: Add feedbackQuestion to Message type**

In `web/src/types.ts`, add to Message interface:
```typescript
  feedbackQuestion?: string
```

- [ ] **Step 2: Pass user question to assistant message in ChatPanel.tsx**

In `ChatPanel.tsx`, find where the assistant message is created (the `onUpdate` or initial message creation). When creating the assistant message object, set:
```typescript
feedbackQuestion: userQuestion  // the text the user typed
```

This ensures FeedbackButton receives the original question.

- [ ] **Step 3: Pass sessionId to FeedbackButton**

In `MessageBubble.tsx`, the sessionId needs to come from the conversation. Add it as a prop:
```typescript
interface MessageBubbleProps {
  message: Message
  sessionId?: string
}
```

And pass it through in ChatPanel where MessageBubble is rendered.

- [ ] **Step 4: Full build and verify**

```bash
cd web && npm run build && cd ../backend && go build -o hk-poc-backend
```

- [ ] **Step 5: Commit**

```bash
git add web/src/types.ts web/src/components/ChatPanel.tsx web/src/components/MessageBubble.tsx
git commit -m "feat(feedback): wire up question and session context for feedback"
```

---

### Task 7: Docker Build & Manual Test

**Files:**
- Modify: `Dockerfile` (if needed — check if `data/` dir exists in container)

- [ ] **Step 1: Ensure data dir in Dockerfile**

Add to Dockerfile before the final CMD:
```dockerfile
RUN mkdir -p /app/data
```

- [ ] **Step 2: Build and deploy**

```bash
docker compose build app && docker compose up -d --force-recreate app
```

- [ ] **Step 3: Manual test — submit feedback**

```bash
curl -s -X POST http://localhost:3000/api/feedback \
  -H "Content-Type: application/json" \
  -d '{
    "question": "2025年恒生指数单日最大跌幅",
    "sql": "SELECT trade_date, hsi_pct_change FROM ms_v_stk_hsi_daily ORDER BY hsi_pct_change ASC LIMIT 1",
    "sql_result": {"columns":["trade_date","hsi_pct_change"],"rows":[["2025-04-07","-13.2200"]],"total_count":1}
  }' | python3 -m json.tool
```

Expected: `{"id": "fb_...", "status": "pending"}`

- [ ] **Step 4: Check analysis result after ~30 seconds**

```bash
curl -s http://localhost:3000/api/feedback | python3 -m json.tool
```

Expected: task with `status: "done"` and populated `analysis` field

- [ ] **Step 5: Test frontend**

Open http://localhost:3000, submit a query, see "结果不准确？" button below SQL, click and submit feedback, then open Analysis Center to see the task.

- [ ] **Step 6: Commit all remaining changes**

```bash
git add -A
git commit -m "feat(feedback): complete feedback analysis feature with Docker support"
```
