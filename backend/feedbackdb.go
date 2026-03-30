package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"time"

	_ "modernc.org/sqlite"
)

// FeedbackTask represents a single feedback analysis task.
type FeedbackTask struct {
	ID         string          `json:"id"`
	Status     string          `json:"status"`
	CreatedAt  string          `json:"created_at"`
	Question   string          `json:"question"`
	UserNote   string          `json:"user_note"`
	SQL        string          `json:"sql"`
	SQLResult  json.RawMessage `json:"sql_result"`
	SessionID  string          `json:"session_id"`
	Analysis   json.RawMessage `json:"analysis"`
	ErrorMsg   string          `json:"error_msg"`
	FinishedAt string          `json:"finished_at"`
}

// FeedbackDB wraps a SQLite database for feedback task storage.
type FeedbackDB struct {
	db *sql.DB
}

// NewFeedbackDB opens (or creates) the SQLite database at dataDir/feedback.db
// and ensures the feedback_tasks table exists.
func NewFeedbackDB(dataDir string) (*FeedbackDB, error) {
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		return nil, fmt.Errorf("create data dir: %w", err)
	}

	dbPath := dataDir + "/feedback.db"
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}

	// Enable WAL mode for better concurrent read performance.
	if _, err := db.Exec("PRAGMA journal_mode=WAL"); err != nil {
		db.Close()
		return nil, fmt.Errorf("set WAL mode: %w", err)
	}

	const createTable = `
CREATE TABLE IF NOT EXISTS feedback_tasks (
    id         TEXT PRIMARY KEY,
    status     TEXT NOT NULL,
    created_at TEXT NOT NULL,
    question   TEXT NOT NULL DEFAULT '',
    user_note  TEXT NOT NULL DEFAULT '',
    sql_text   TEXT,
    sql_result TEXT,
    session_id TEXT,
    analysis   TEXT,
    error_msg  TEXT,
    finished_at TEXT
);`
	if _, err := db.Exec(createTable); err != nil {
		db.Close()
		return nil, fmt.Errorf("create table: %w", err)
	}

	return &FeedbackDB{db: db}, nil
}

// Close releases the underlying database connection.
func (f *FeedbackDB) Close() error {
	return f.db.Close()
}

// Insert inserts a new FeedbackTask into the database.
func (f *FeedbackDB) Insert(task FeedbackTask) error {
	const q = `
INSERT INTO feedback_tasks
    (id, status, created_at, question, user_note, sql_text, sql_result, session_id, analysis, error_msg, finished_at)
VALUES
    (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

	_, err := f.db.Exec(q,
		task.ID,
		task.Status,
		task.CreatedAt,
		task.Question,
		task.UserNote,
		nullableString(string(task.SQL)),
		nullableJSON(task.SQLResult),
		nullableString(task.SessionID),
		nullableJSON(task.Analysis),
		nullableString(task.ErrorMsg),
		nullableString(task.FinishedAt),
	)
	if err != nil {
		return fmt.Errorf("insert feedback task: %w", err)
	}
	return nil
}

// UpdateStatus updates only the status field of the task.
func (f *FeedbackDB) UpdateStatus(id, status string) error {
	const q = `UPDATE feedback_tasks SET status = ? WHERE id = ?`
	_, err := f.db.Exec(q, status, id)
	if err != nil {
		return fmt.Errorf("update status: %w", err)
	}
	return nil
}

// UpdateResult marks the task as done, storing the analysis result and finished timestamp.
func (f *FeedbackDB) UpdateResult(id string, analysis json.RawMessage) error {
	const q = `UPDATE feedback_tasks SET status = 'done', analysis = ?, finished_at = ? WHERE id = ?`
	_, err := f.db.Exec(q, nullableJSON(analysis), time.Now().UTC().Format(time.RFC3339), id)
	if err != nil {
		return fmt.Errorf("update result: %w", err)
	}
	return nil
}

// UpdateError marks the task as failed with an error message and finished timestamp.
func (f *FeedbackDB) UpdateError(id, errMsg string) error {
	const q = `UPDATE feedback_tasks SET status = 'error', error_msg = ?, finished_at = ? WHERE id = ?`
	_, err := f.db.Exec(q, errMsg, time.Now().UTC().Format(time.RFC3339), id)
	if err != nil {
		return fmt.Errorf("update error: %w", err)
	}
	return nil
}

// Get retrieves a single FeedbackTask by its ID.
func (f *FeedbackDB) Get(id string) (*FeedbackTask, error) {
	const q = `
SELECT id, status, created_at, question, user_note, sql_text, sql_result, session_id, analysis, error_msg, finished_at
FROM feedback_tasks
WHERE id = ?`

	row := f.db.QueryRow(q, id)
	task, err := scanTask(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get feedback task: %w", err)
	}
	return task, nil
}

// List returns all feedback tasks ordered by created_at descending.
func (f *FeedbackDB) List() ([]FeedbackTask, error) {
	const q = `
SELECT id, status, created_at, question, user_note, sql_text, sql_result, session_id, analysis, error_msg, finished_at
FROM feedback_tasks
ORDER BY created_at DESC`

	rows, err := f.db.Query(q)
	if err != nil {
		return nil, fmt.Errorf("list feedback tasks: %w", err)
	}
	defer rows.Close()

	var tasks []FeedbackTask
	for rows.Next() {
		task, err := scanTask(rows)
		if err != nil {
			return nil, fmt.Errorf("scan feedback task: %w", err)
		}
		tasks = append(tasks, *task)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate feedback tasks: %w", err)
	}
	return tasks, nil
}

// scanner is satisfied by both *sql.Row and *sql.Rows.
type scanner interface {
	Scan(dest ...any) error
}

func scanTask(s scanner) (*FeedbackTask, error) {
	var (
		task      FeedbackTask
		sqlText   sql.NullString
		sqlResult sql.NullString
		sessionID sql.NullString
		analysis  sql.NullString
		errorMsg  sql.NullString
		finishedAt sql.NullString
	)

	err := s.Scan(
		&task.ID,
		&task.Status,
		&task.CreatedAt,
		&task.Question,
		&task.UserNote,
		&sqlText,
		&sqlResult,
		&sessionID,
		&analysis,
		&errorMsg,
		&finishedAt,
	)
	if err != nil {
		return nil, err
	}

	if sqlText.Valid {
		task.SQL = sqlText.String
	}
	if sqlResult.Valid {
		task.SQLResult = json.RawMessage(sqlResult.String)
	}
	if sessionID.Valid {
		task.SessionID = sessionID.String
	}
	if analysis.Valid {
		task.Analysis = json.RawMessage(analysis.String)
	}
	if errorMsg.Valid {
		task.ErrorMsg = errorMsg.String
	}
	if finishedAt.Valid {
		task.FinishedAt = finishedAt.String
	}

	return &task, nil
}

// nullableString converts an empty string to sql.NullString{Valid: false}.
func nullableString(s string) sql.NullString {
	if s == "" {
		return sql.NullString{}
	}
	return sql.NullString{String: s, Valid: true}
}

// nullableJSON converts a nil or empty json.RawMessage to sql.NullString{Valid: false}.
func nullableJSON(j json.RawMessage) sql.NullString {
	if len(j) == 0 {
		return sql.NullString{}
	}
	return sql.NullString{String: string(j), Valid: true}
}
