package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/go-sql-driver/mysql"
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

// FeedbackDB wraps a MySQL/MatrixOne database connection for feedback task storage.
type FeedbackDB struct {
	db *sql.DB
}

// NewFeedbackDB connects to MatrixOne and ensures the feedback_tasks table exists.
// Accepts a *mysql.Config to avoid DSN parsing issues with "account:user" format.
func NewFeedbackDB(cfg *mysql.Config) (*FeedbackDB, error) {
	connector, err := mysql.NewConnector(cfg)
	if err != nil {
		return nil, fmt.Errorf("create connector: %w", err)
	}
	db := sql.OpenDB(connector)
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("ping mysql: %w", err)
	}

	const createTable = `
CREATE TABLE IF NOT EXISTS feedback_tasks (
    id         VARCHAR(64) PRIMARY KEY,
    status     VARCHAR(20) NOT NULL,
    created_at VARCHAR(30) NOT NULL,
    question   TEXT NOT NULL,
    user_note  TEXT,
    sql_text   TEXT,
    sql_result TEXT,
    session_id VARCHAR(100),
    analysis   TEXT,
    error_msg  TEXT,
    finished_at VARCHAR(30)
)`
	if _, err := db.Exec(createTable); err != nil {
		db.Close()
		return nil, fmt.Errorf("create table: %w", err)
	}

	return &FeedbackDB{db: db}, nil
}

func (f *FeedbackDB) Close() error {
	return f.db.Close()
}

func (f *FeedbackDB) Insert(task FeedbackTask) error {
	const q = `
INSERT INTO feedback_tasks
    (id, status, created_at, question, user_note, sql_text, sql_result, session_id)
VALUES
    (?, ?, ?, ?, ?, ?, ?, ?)`

	_, err := f.db.Exec(q,
		task.ID, task.Status, task.CreatedAt,
		task.Question, task.UserNote, task.SQL,
		nullableJSON(task.SQLResult), task.SessionID,
	)
	return err
}

func (f *FeedbackDB) UpdateStatus(id, status string) error {
	_, err := f.db.Exec(`UPDATE feedback_tasks SET status = ? WHERE id = ?`, status, id)
	return err
}

func (f *FeedbackDB) UpdateResult(id string, analysis json.RawMessage) error {
	now := time.Now().UTC().Format(time.RFC3339)
	_, err := f.db.Exec(
		`UPDATE feedback_tasks SET status = 'done', analysis = ?, finished_at = ? WHERE id = ?`,
		nullableJSON(analysis), now, id,
	)
	return err
}

func (f *FeedbackDB) UpdateError(id, errMsg string) error {
	now := time.Now().UTC().Format(time.RFC3339)
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
	task, err := scanTask(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return task, err
}

func (f *FeedbackDB) List() ([]FeedbackTask, error) {
	rows, err := f.db.Query(
		`SELECT id, status, created_at, question, user_note, sql_text, sql_result, session_id, analysis, error_msg, finished_at
		 FROM feedback_tasks ORDER BY created_at DESC`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var tasks []FeedbackTask
	for rows.Next() {
		task, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		tasks = append(tasks, *task)
	}
	return tasks, rows.Err()
}

type scanner interface {
	Scan(dest ...any) error
}

func scanTask(s scanner) (*FeedbackTask, error) {
	var (
		task       FeedbackTask
		sqlText    sql.NullString
		sqlResult  sql.NullString
		sessionID  sql.NullString
		analysis   sql.NullString
		errorMsg   sql.NullString
		finishedAt sql.NullString
		userNote   sql.NullString
	)

	err := s.Scan(
		&task.ID, &task.Status, &task.CreatedAt, &task.Question, &userNote,
		&sqlText, &sqlResult, &sessionID, &analysis, &errorMsg, &finishedAt,
	)
	if err != nil {
		return nil, err
	}

	task.UserNote = userNote.String
	task.SQL = sqlText.String
	task.SessionID = sessionID.String
	task.ErrorMsg = errorMsg.String
	task.FinishedAt = finishedAt.String
	if sqlResult.Valid {
		task.SQLResult = json.RawMessage(sqlResult.String)
	}
	if analysis.Valid {
		task.Analysis = json.RawMessage(analysis.String)
	}

	return &task, nil
}

func nullableJSON(j json.RawMessage) sql.NullString {
	if len(j) == 0 {
		return sql.NullString{}
	}
	return sql.NullString{String: string(j), Valid: true}
}
