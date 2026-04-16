package main

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"
)

// newUUID 返回一个 UUID v4 风格的字符串，32 hex chars + 4 dashes。
// 不引入第三方依赖。
func newUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand 几乎不会失败；fallback 用时间戳避免 panic
		ts := uint64(time.Now().UnixNano())
		for i := 0; i < 16; i++ {
			b[i] = byte(ts >> (i * 8))
		}
	}
	// 按 RFC 4122 v4 置位
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	s := hex.EncodeToString(b[:])
	return fmt.Sprintf("%s-%s-%s-%s-%s", s[0:8], s[8:12], s[12:16], s[16:20], s[20:32])
}

// Conversation 是会话的完整行。
type Conversation struct {
	ID               string `json:"id"`
	Title            string `json:"title"`
	CatalogSessionID string `json:"catalog_session_id,omitempty"`
	PendingClarify   string `json:"-"`
	CreatedAt        int64  `json:"created_at"`
	UpdatedAt        int64  `json:"updated_at"`
}

// ConversationMeta 是列表接口返回的轻量版。
type ConversationMeta struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	CreatedAt int64  `json:"created_at"`
	UpdatedAt int64  `json:"updated_at"`
}

// StoredMessage 是 messages 表的一行。
type StoredMessage struct {
	ID               string            `json:"id"`
	ConversationID   string            `json:"conversation_id"`
	Role             string            `json:"role"`
	Content          string            `json:"content"`
	SQLStatements    []string          `json:"sql_statements,omitempty"`
	SQLResults       []json.RawMessage `json:"sql_results,omitempty"`
	ChartSpec        json.RawMessage   `json:"chart_spec,omitempty"`
	PhaseHistory     []string          `json:"phase_history,omitempty"`
	Error            string            `json:"error,omitempty"`
	FeedbackQuestion string            `json:"feedback_question,omitempty"`
	Status           string            `json:"status"`
	Seq              int64             `json:"seq"`
	CreatedAt        int64             `json:"created_at"`
}

// ConversationsDB 封装 conversations + messages 两表的 CRUD。
type ConversationsDB struct {
	db *sql.DB
}

// NewConversationsDB 复用传入的 *sql.DB 并确保两张表存在。
func NewConversationsDB(db *sql.DB) (*ConversationsDB, error) {
	cdb := &ConversationsDB{db: db}
	if err := cdb.initSchema(); err != nil {
		return nil, err
	}
	return cdb, nil
}

func (c *ConversationsDB) initSchema() error {
	const conversationsDDL = `
CREATE TABLE IF NOT EXISTS conversations (
    id                 VARCHAR(64) PRIMARY KEY,
    title              VARCHAR(255) NOT NULL DEFAULT '',
    catalog_session_id VARCHAR(64),
    pending_clarify    TEXT,
    created_at         BIGINT NOT NULL,
    updated_at         BIGINT NOT NULL
)`
	if _, err := c.db.Exec(conversationsDDL); err != nil {
		return fmt.Errorf("create conversations table: %w", err)
	}

	const messagesDDL = `
CREATE TABLE IF NOT EXISTS messages (
    id                VARCHAR(64) PRIMARY KEY,
    conversation_id   VARCHAR(64) NOT NULL,
    role              VARCHAR(16) NOT NULL,
    content           TEXT,
    sql_statements    TEXT,
    sql_results       TEXT,
    chart_spec        TEXT,
    phase_history     TEXT,
    error             TEXT,
    feedback_question TEXT,
    status            VARCHAR(16) NOT NULL,
    seq               BIGINT NOT NULL,
    created_at        BIGINT NOT NULL
)`
	if _, err := c.db.Exec(messagesDDL); err != nil {
		return fmt.Errorf("create messages table: %w", err)
	}

	return nil
}

// ---------- Conversation CRUD ----------

// CreateConversation 插入空会话并返回 id。
func (c *ConversationsDB) CreateConversation() (string, error) {
	id := newUUID()
	now := time.Now().UnixMilli()
	_, err := c.db.Exec(
		`INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
		id, "", now, now,
	)
	if err != nil {
		return "", fmt.Errorf("insert conversation: %w", err)
	}
	return id, nil
}

// ListConversations 返回所有会话元信息，按 updated_at DESC。
func (c *ConversationsDB) ListConversations() ([]ConversationMeta, error) {
	rows, err := c.db.Query(
		`SELECT id, title, created_at, updated_at FROM conversations ORDER BY updated_at DESC`,
	)
	if err != nil {
		return nil, fmt.Errorf("query conversations: %w", err)
	}
	defer rows.Close()

	var out []ConversationMeta
	for rows.Next() {
		var m ConversationMeta
		if err := rows.Scan(&m.ID, &m.Title, &m.CreatedAt, &m.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	if out == nil {
		out = []ConversationMeta{}
	}
	return out, rows.Err()
}

// GetConversation 返回单个会话，不存在时返回 (nil, nil)。
func (c *ConversationsDB) GetConversation(id string) (*Conversation, error) {
	var (
		conv    Conversation
		catalog sql.NullString
		pending sql.NullString
	)
	err := c.db.QueryRow(
		`SELECT id, title, catalog_session_id, pending_clarify, created_at, updated_at
		 FROM conversations WHERE id = ?`, id,
	).Scan(&conv.ID, &conv.Title, &catalog, &pending, &conv.CreatedAt, &conv.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("scan conversation: %w", err)
	}
	conv.CatalogSessionID = catalog.String
	conv.PendingClarify = pending.String
	return &conv, nil
}

// UpdateTitle 强制更新标题。
func (c *ConversationsDB) UpdateTitle(id, title string) error {
	_, err := c.db.Exec(
		`UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?`,
		title, time.Now().UnixMilli(), id,
	)
	return err
}

// UpdateTitleIfEmpty 仅在 title 为空时设置（用户首问后同步调用）。
func (c *ConversationsDB) UpdateTitleIfEmpty(id, title string) error {
	_, err := c.db.Exec(
		`UPDATE conversations SET title = ?, updated_at = ? WHERE id = ? AND (title IS NULL OR title = '')`,
		title, time.Now().UnixMilli(), id,
	)
	return err
}

// UpdateCatalogSessionID 写入 Catalog 会话映射。
func (c *ConversationsDB) UpdateCatalogSessionID(id, catalogID string) error {
	_, err := c.db.Exec(
		`UPDATE conversations SET catalog_session_id = ?, updated_at = ? WHERE id = ?`,
		catalogID, time.Now().UnixMilli(), id,
	)
	return err
}

// UpdatePendingClarify 写入待合并的反问原问题；传空串即清除。
func (c *ConversationsDB) UpdatePendingClarify(id, pending string) error {
	var val sql.NullString
	if pending != "" {
		val = sql.NullString{String: pending, Valid: true}
	}
	_, err := c.db.Exec(
		`UPDATE conversations SET pending_clarify = ?, updated_at = ? WHERE id = ?`,
		val, time.Now().UnixMilli(), id,
	)
	return err
}

// TouchUpdatedAt 仅更新 updated_at，用于在不改 title/session 时把会话顶到列表顶。
func (c *ConversationsDB) TouchUpdatedAt(id string) error {
	_, err := c.db.Exec(
		`UPDATE conversations SET updated_at = ? WHERE id = ?`,
		time.Now().UnixMilli(), id,
	)
	return err
}

// DeleteConversation 级联删除会话及其消息。
func (c *ConversationsDB) DeleteConversation(id string) error {
	if _, err := c.db.Exec(`DELETE FROM messages WHERE conversation_id = ?`, id); err != nil {
		return fmt.Errorf("delete messages: %w", err)
	}
	if _, err := c.db.Exec(`DELETE FROM conversations WHERE id = ?`, id); err != nil {
		return fmt.Errorf("delete conversation: %w", err)
	}
	return nil
}

// ---------- Message CRUD ----------

// NewMessageID 生成一个消息 id。
func NewMessageID() string {
	return newUUID()
}

// InsertMessage 写入一行 message。调用方负责填 id/role/status 等必填字段；
// seq 和 created_at 会被自动填充（seq = UnixNano 保序无冲突）。
func (c *ConversationsDB) InsertMessage(msg *StoredMessage) error {
	if msg.ID == "" {
		msg.ID = NewMessageID()
	}
	if msg.Seq == 0 {
		msg.Seq = time.Now().UnixNano()
	}
	if msg.CreatedAt == 0 {
		msg.CreatedAt = time.Now().UnixMilli()
	}

	sqlStmts := marshalOrEmpty(msg.SQLStatements)
	sqlResults := marshalOrEmpty(msg.SQLResults)
	phaseHist := marshalOrEmpty(msg.PhaseHistory)
	chartSpec := rawOrEmpty(msg.ChartSpec)

	_, err := c.db.Exec(
		`INSERT INTO messages
		 (id, conversation_id, role, content, sql_statements, sql_results, chart_spec, phase_history, error, feedback_question, status, seq, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		msg.ID, msg.ConversationID, msg.Role, msg.Content,
		sqlStmts, sqlResults, chartSpec, phaseHist,
		msg.Error, msg.FeedbackQuestion, msg.Status, msg.Seq, msg.CreatedAt,
	)
	if err != nil {
		return fmt.Errorf("insert message: %w", err)
	}
	return nil
}

// UpdateMessageStatus 只更新 status 列。
func (c *ConversationsDB) UpdateMessageStatus(id, status string) error {
	_, err := c.db.Exec(`UPDATE messages SET status = ? WHERE id = ?`, status, id)
	return err
}

// PersistAssistantMessage 把聚合后的完整字段一次性写回并把 status 设为 done。
func (c *ConversationsDB) PersistAssistantMessage(msg *StoredMessage) error {
	sqlStmts := marshalOrEmpty(msg.SQLStatements)
	sqlResults := marshalOrEmpty(msg.SQLResults)
	phaseHist := marshalOrEmpty(msg.PhaseHistory)
	chartSpec := rawOrEmpty(msg.ChartSpec)

	_, err := c.db.Exec(
		`UPDATE messages
		 SET content = ?, sql_statements = ?, sql_results = ?, chart_spec = ?,
		     phase_history = ?, error = ?, status = ?
		 WHERE id = ?`,
		msg.Content, sqlStmts, sqlResults, chartSpec, phaseHist, msg.Error, msg.Status, msg.ID,
	)
	if err != nil {
		return fmt.Errorf("persist assistant message: %w", err)
	}
	return nil
}

// ListMessages 返回某会话的全部消息，按 seq ASC。
func (c *ConversationsDB) ListMessages(conversationID string) ([]StoredMessage, error) {
	rows, err := c.db.Query(
		`SELECT id, conversation_id, role, content, sql_statements, sql_results, chart_spec,
		        phase_history, error, feedback_question, status, seq, created_at
		 FROM messages WHERE conversation_id = ? ORDER BY seq ASC`,
		conversationID,
	)
	if err != nil {
		return nil, fmt.Errorf("query messages: %w", err)
	}
	defer rows.Close()

	var out []StoredMessage
	for rows.Next() {
		var (
			m                StoredMessage
			content          sql.NullString
			sqlStmts         sql.NullString
			sqlResults       sql.NullString
			chartSpec        sql.NullString
			phaseHist        sql.NullString
			errMsg           sql.NullString
			feedbackQuestion sql.NullString
		)
		if err := rows.Scan(
			&m.ID, &m.ConversationID, &m.Role, &content,
			&sqlStmts, &sqlResults, &chartSpec, &phaseHist,
			&errMsg, &feedbackQuestion, &m.Status, &m.Seq, &m.CreatedAt,
		); err != nil {
			return nil, err
		}
		m.Content = content.String
		m.Error = errMsg.String
		m.FeedbackQuestion = feedbackQuestion.String
		if sqlStmts.Valid && sqlStmts.String != "" {
			_ = json.Unmarshal([]byte(sqlStmts.String), &m.SQLStatements)
		}
		if sqlResults.Valid && sqlResults.String != "" {
			_ = json.Unmarshal([]byte(sqlResults.String), &m.SQLResults)
		}
		if chartSpec.Valid && chartSpec.String != "" {
			m.ChartSpec = json.RawMessage(chartSpec.String)
		}
		if phaseHist.Valid && phaseHist.String != "" {
			_ = json.Unmarshal([]byte(phaseHist.String), &m.PhaseHistory)
		}
		out = append(out, m)
	}
	if out == nil {
		out = []StoredMessage{}
	}
	return out, rows.Err()
}

// RecentUserQuestions 返回某会话最近 n 条 role=user 的 content（按 seq ASC）。
// 注意：Clarifier 在 handler 流程里先于 InsertMessage 调用，因此天然不包含当前问题。
func (c *ConversationsDB) RecentUserQuestions(conversationID string, n int) ([]string, error) {
	rows, err := c.db.Query(
		`SELECT content FROM messages
		 WHERE conversation_id = ? AND role = 'user'
		 ORDER BY seq DESC LIMIT ?`,
		conversationID, n,
	)
	if err != nil {
		return nil, fmt.Errorf("query recent user questions: %w", err)
	}
	defer rows.Close()

	var reversed []string
	for rows.Next() {
		var content sql.NullString
		if err := rows.Scan(&content); err != nil {
			return nil, err
		}
		reversed = append(reversed, content.String)
	}
	// 反转为 ASC 顺序
	out := make([]string, len(reversed))
	for i, q := range reversed {
		out[len(reversed)-1-i] = q
	}
	return out, rows.Err()
}

// ---------- helpers ----------

func marshalOrEmpty(v any) sql.NullString {
	switch vv := v.(type) {
	case []string:
		if len(vv) == 0 {
			return sql.NullString{}
		}
	case []json.RawMessage:
		if len(vv) == 0 {
			return sql.NullString{}
		}
	}
	b, err := json.Marshal(v)
	if err != nil || string(b) == "null" {
		return sql.NullString{}
	}
	return sql.NullString{String: string(b), Valid: true}
}

func rawOrEmpty(raw json.RawMessage) sql.NullString {
	if len(raw) == 0 {
		return sql.NullString{}
	}
	return sql.NullString{String: string(raw), Valid: true}
}
