# Excel 上传建表 + 表管理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to upload Excel files, create tables in MatrixOne, manage metadata (table/column comments), and automatically integrate with nl2sql queries.

**Architecture:** Two-step upload flow (preview → create) in Go backend using `excelize` library. Backend directly operates on MatrixOne via existing `*sql.DB` connection. Metadata tracked in a `poc_user_tables` registry table. Frontend adds a slide-over panel (following KnowledgePanel pattern) with upload dialog and metadata editor. Explore engine discovers new tables automatically via `information_schema`.

**Tech Stack:** Go 1.25 + excelize/v2, React + TypeScript, MatrixOne (MySQL protocol), Vite

---

## File Map

### Backend (Go) — `backend/`

| File | Action | Responsibility |
|------|--------|----------------|
| `user_tables.go` | Create | Core logic: Excel parsing, type inference, CREATE TABLE, LOAD DATA, metadata CRUD, temp file cleanup |
| `user_tables_handler.go` | Create | HTTP handler: route dispatch, multipart parsing, JSON request/response, validation |
| `main.go` | Modify | Register `/api/user-tables` routes, change `/api/tables` from hardcoded to dynamic |
| `go.mod` | Modify | Add `github.com/xuri/excelize/v2` dependency |

### Frontend (React) — `web/src/`

| File | Action | Responsibility |
|------|--------|----------------|
| `api/userTables.ts` | Create | API client for all `/api/user-tables/*` endpoints |
| `components/UserTablePanel.tsx` | Create | Slide-over panel: table list + upload trigger + delete + expand metadata editor |
| `components/UserTablePanel.css` | Create | Styles for panel (based on KnowledgePanel.css pattern) |
| `components/ExcelUploadDialog.tsx` | Create | Modal dialog: file drop zone → preview table → confirm create |
| `components/ColumnMetaEditor.tsx` | Create | Inline editor: table comment + per-column comment editing |
| `App.tsx` | Modify | Add "数据表管理" button in header, render UserTablePanel |
| `TableSelector.tsx` | Modify | Add `source` field support, visual distinction for user tables |
| `i18n/zh.json` | Modify | Add Chinese translations for all new keys |
| `i18n/en.json` | Modify | Add English translations for all new keys |

---

## Task 1: Add excelize dependency

**Files:**
- Modify: `backend/go.mod`

- [ ] **Step 1: Add excelize dependency**

```bash
cd /Users/zhangqq/Documents/pythonProject/HK_POC/backend
go get github.com/xuri/excelize/v2
```

- [ ] **Step 2: Verify go.mod updated**

```bash
cd /Users/zhangqq/Documents/pythonProject/HK_POC/backend
grep excelize go.mod
```

Expected: line containing `github.com/xuri/excelize/v2`

- [ ] **Step 3: Commit**

```bash
git add backend/go.mod backend/go.sum
git commit -m "chore: add excelize/v2 dependency for Excel upload"
```

---

## Task 2: Backend core logic — `user_tables.go`

**Files:**
- Create: `backend/user_tables.go`

This file contains all the core logic: Excel parsing, type inference, DDL generation, data import, metadata CRUD, and temp file cleanup. It does NOT handle HTTP concerns — those are in the handler.

- [ ] **Step 1: Create `user_tables.go` with types and constructor**

```go
package main

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/xuri/excelize/v2"
)

var validTableName = regexp.MustCompile(`^[a-z0-9_]{1,64}$`)

var systemTables = map[string]bool{
	"ms_t_stk_hsi":       true,
	"ms_v_stk_hsi_daily": true,
	"ms_t_stk_sis":       true,
	"ms_v_stock_capital":  true,
	"ds_t_int_hsicl_dtl":  true,
	"sehknews":            true,
	"profit_loss":         true,
	"ccass_holdings":      true,
	"poc_user_tables":     true,
	"feedback_tasks":      true,
	"conversations":       true,
	"messages":            true,
}

type ColumnInfo struct {
	Name         string   `json:"name"`
	InferredType string   `json:"inferred_type,omitempty"`
	Type         string   `json:"type,omitempty"`
	Comment      string   `json:"comment,omitempty"`
	Samples      []string `json:"samples,omitempty"`
}

type PreviewResult struct {
	FileKey     string       `json:"file_key"`
	SheetName   string       `json:"sheet_name"`
	Columns     []ColumnInfo `json:"columns"`
	PreviewRows [][]string   `json:"preview_rows"`
	TotalRows   int          `json:"total_rows"`
}

type UserTableMeta struct {
	TableName    string `json:"table_name"`
	TableComment string `json:"table_comment"`
	RowCount     int64  `json:"row_count"`
	CreatedAt    string `json:"created_at"`
	Source       string `json:"source"`
}

type UserTableService struct {
	db       *sql.DB
	dbName   string
	tmpDir   string
	mu       sync.Mutex
	tmpFiles map[string]tmpEntry
}

type tmpEntry struct {
	path      string
	createdAt time.Time
}

func NewUserTableService(db *sql.DB, dbName string) (*UserTableService, error) {
	tmpDir := filepath.Join(os.TempDir(), "hk-poc-uploads")
	if err := os.MkdirAll(tmpDir, 0o755); err != nil {
		return nil, fmt.Errorf("create tmp dir: %w", err)
	}

	const ddl = `CREATE TABLE IF NOT EXISTS poc_user_tables (
		table_name    VARCHAR(128) PRIMARY KEY,
		table_comment VARCHAR(512) DEFAULT '',
		row_count     BIGINT DEFAULT 0,
		created_at    DATETIME DEFAULT NOW()
	)`
	if _, err := db.Exec(ddl); err != nil {
		return nil, fmt.Errorf("create poc_user_tables: %w", err)
	}

	svc := &UserTableService{
		db:       db,
		dbName:   dbName,
		tmpDir:   tmpDir,
		tmpFiles: make(map[string]tmpEntry),
	}
	go svc.cleanupLoop()
	return svc, nil
}
```

- [ ] **Step 2: Add type inference logic**

```go
const maxScanRows = 1000

var (
	datePattern     = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
	datetimePattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(:\d{2})?$`)
	intPattern      = regexp.MustCompile(`^-?\d+$`)
	decimalPattern  = regexp.MustCompile(`^-?\d+\.\d+$`)
)

func inferType(values []string) string {
	if len(values) == 0 {
		return "VARCHAR(255)"
	}

	allEmpty := true
	isInt := true
	isDecimal := true
	isDate := true
	isDatetime := true
	maxLen := 0

	for _, v := range values {
		v = strings.TrimSpace(v)
		if v == "" {
			continue
		}
		allEmpty = false

		runeLen := utf8.RuneCountInString(v)
		if runeLen > maxLen {
			maxLen = runeLen
		}

		if isInt && !intPattern.MatchString(v) {
			isInt = false
		}
		if isDecimal && !decimalPattern.MatchString(v) && !intPattern.MatchString(v) {
			isDecimal = false
		}
		if isDatetime && !datetimePattern.MatchString(v) {
			isDatetime = false
		}
		if isDate && !datePattern.MatchString(v) && !datetimePattern.MatchString(v) {
			isDate = false
		}
	}

	if allEmpty {
		return "VARCHAR(255)"
	}

	switch {
	case isInt:
		return "BIGINT"
	case isDecimal:
		return "DECIMAL(18,6)"
	case isDatetime && !isDate:
		return "DATETIME"
	case isDate:
		return "DATE"
	default:
		sz := maxLen * 2
		if sz < 255 {
			sz = 255
		}
		return fmt.Sprintf("VARCHAR(%d)", sz)
	}
}
```

- [ ] **Step 3: Add Excel preview logic**

```go
func (s *UserTableService) PreviewExcel(filePath string) (*PreviewResult, error) {
	f, err := excelize.OpenFile(filePath)
	if err != nil {
		return nil, fmt.Errorf("open excel: %w", err)
	}
	defer f.Close()

	sheetName := f.GetSheetName(0)
	if sheetName == "" {
		return nil, fmt.Errorf("no sheets found")
	}

	rows, err := f.GetRows(sheetName)
	if err != nil {
		return nil, fmt.Errorf("get rows: %w", err)
	}
	if len(rows) < 2 {
		return nil, fmt.Errorf("Excel must have a header row and at least one data row")
	}

	header := rows[0]
	dataRows := rows[1:]

	colCount := len(header)
	colValues := make([][]string, colCount)
	for i := range colValues {
		colValues[i] = make([]string, 0, maxScanRows)
	}

	scanLimit := maxScanRows
	if len(dataRows) < scanLimit {
		scanLimit = len(dataRows)
	}
	for i := 0; i < scanLimit; i++ {
		for j := 0; j < colCount; j++ {
			val := ""
			if j < len(dataRows[i]) {
				val = dataRows[i][j]
			}
			colValues[j] = append(colValues[j], val)
		}
	}

	columns := make([]ColumnInfo, colCount)
	for i, name := range header {
		samples := colValues[i]
		samplePreview := samples
		if len(samplePreview) > 5 {
			samplePreview = samplePreview[:5]
		}
		columns[i] = ColumnInfo{
			Name:         strings.TrimSpace(name),
			InferredType: inferType(samples),
			Samples:      samplePreview,
		}
	}

	previewLimit := 20
	if len(dataRows) < previewLimit {
		previewLimit = len(dataRows)
	}
	previewRows := make([][]string, previewLimit)
	for i := 0; i < previewLimit; i++ {
		row := make([]string, colCount)
		for j := 0; j < colCount; j++ {
			if j < len(dataRows[i]) {
				row[j] = dataRows[i][j]
			}
		}
		previewRows[i] = row
	}

	return &PreviewResult{
		SheetName:   sheetName,
		Columns:     columns,
		PreviewRows: previewRows,
		TotalRows:   len(dataRows),
	}, nil
}

func (s *UserTableService) SaveTempFile(fileKey, path string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tmpFiles[fileKey] = tmpEntry{path: path, createdAt: time.Now()}
}

func (s *UserTableService) GetTempFile(fileKey string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.tmpFiles[fileKey]
	if !ok {
		return "", false
	}
	return entry.path, true
}

func (s *UserTableService) removeTempFile(fileKey string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if entry, ok := s.tmpFiles[fileKey]; ok {
		_ = os.Remove(entry.path)
		delete(s.tmpFiles, fileKey)
	}
}
```

- [ ] **Step 4: Add CreateTable + import logic**

```go
type CreateTableRequest struct {
	FileKey      string       `json:"file_key"`
	TableName    string       `json:"table_name"`
	TableComment string       `json:"table_comment"`
	Columns      []ColumnInfo `json:"columns"`
}

func (s *UserTableService) ValidateTableName(name string) error {
	if !validTableName.MatchString(name) {
		return fmt.Errorf("table name must match [a-z0-9_]{1,64}")
	}
	if systemTables[name] {
		return fmt.Errorf("table name '%s' conflicts with system table", name)
	}
	return nil
}

func (s *UserTableService) CreateTable(ctx context.Context, req *CreateTableRequest) (int64, error) {
	tmpPath, ok := s.GetTempFile(req.FileKey)
	if !ok {
		return 0, fmt.Errorf("upload expired or not found (file_key: %s)", req.FileKey)
	}
	defer s.removeTempFile(req.FileKey)

	if err := s.ValidateTableName(req.TableName); err != nil {
		return 0, err
	}

	var colDefs []string
	for _, col := range req.Columns {
		colType := col.Type
		if colType == "" {
			colType = col.InferredType
		}
		def := fmt.Sprintf("`%s` %s", col.Name, colType)
		if col.Comment != "" {
			def += fmt.Sprintf(" COMMENT '%s'", escapeSQL(col.Comment))
		}
		colDefs = append(colDefs, def)
	}

	ddl := fmt.Sprintf("CREATE TABLE `%s` (\n  %s\n)", req.TableName, strings.Join(colDefs, ",\n  "))
	if req.TableComment != "" {
		ddl += fmt.Sprintf(" COMMENT='%s'", escapeSQL(req.TableComment))
	}

	if _, err := s.db.ExecContext(ctx, ddl); err != nil {
		return 0, fmt.Errorf("create table: %w", err)
	}

	rowCount, err := s.importData(ctx, req.TableName, req.Columns, tmpPath)
	if err != nil {
		_, _ = s.db.ExecContext(ctx, fmt.Sprintf("DROP TABLE IF EXISTS `%s`", req.TableName))
		return 0, fmt.Errorf("import data: %w", err)
	}

	const insertMeta = `INSERT INTO poc_user_tables (table_name, table_comment, row_count) VALUES (?, ?, ?)`
	if _, err := s.db.ExecContext(ctx, insertMeta, req.TableName, req.TableComment, rowCount); err != nil {
		log.Printf("user_tables: insert meta for %s failed: %v", req.TableName, err)
	}

	return rowCount, nil
}

func (s *UserTableService) importData(ctx context.Context, tableName string, columns []ColumnInfo, excelPath string) (int64, error) {
	f, err := excelize.OpenFile(excelPath)
	if err != nil {
		return 0, fmt.Errorf("open excel for import: %w", err)
	}
	defer f.Close()

	sheetName := f.GetSheetName(0)
	rows, err := f.GetRows(sheetName)
	if err != nil {
		return 0, fmt.Errorf("get rows: %w", err)
	}
	if len(rows) < 2 {
		return 0, nil
	}

	dataRows := rows[1:]
	colCount := len(columns)
	placeholders := make([]string, colCount)
	for i := range placeholders {
		placeholders[i] = "?"
	}
	colNames := make([]string, colCount)
	for i, col := range columns {
		colNames[i] = fmt.Sprintf("`%s`", col.Name)
	}

	insertPrefix := fmt.Sprintf("INSERT INTO `%s` (%s) VALUES ", tableName, strings.Join(colNames, ", "))
	phRow := "(" + strings.Join(placeholders, ", ") + ")"

	batchSize := 500
	var total int64

	for start := 0; start < len(dataRows); start += batchSize {
		end := start + batchSize
		if end > len(dataRows) {
			end = len(dataRows)
		}
		batch := dataRows[start:end]

		phParts := make([]string, len(batch))
		args := make([]any, 0, len(batch)*colCount)
		for i, row := range batch {
			phParts[i] = phRow
			for j := 0; j < colCount; j++ {
				val := ""
				if j < len(row) {
					val = row[j]
				}
				if val == "" {
					args = append(args, nil)
				} else {
					args = append(args, val)
				}
			}
		}

		query := insertPrefix + strings.Join(phParts, ", ")
		if _, err := s.db.ExecContext(ctx, query, args...); err != nil {
			return total, fmt.Errorf("batch insert at row %d: %w", start, err)
		}
		total += int64(len(batch))
	}

	return total, nil
}

func escapeSQL(s string) string {
	s = strings.ReplaceAll(s, "'", "''")
	s = strings.ReplaceAll(s, "\\", "\\\\")
	return s
}
```

- [ ] **Step 5: Add list, delete, metadata update, data preview, and cleanup**

```go
func (s *UserTableService) ListUserTables(ctx context.Context) ([]UserTableMeta, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT table_name, table_comment, row_count, created_at FROM poc_user_tables ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var tables []UserTableMeta
	for rows.Next() {
		var t UserTableMeta
		if err := rows.Scan(&t.TableName, &t.TableComment, &t.RowCount, &t.CreatedAt); err != nil {
			return nil, err
		}
		t.Source = "user"
		tables = append(tables, t)
	}
	return tables, rows.Err()
}

func (s *UserTableService) DeleteTable(ctx context.Context, name string) error {
	var exists bool
	err := s.db.QueryRowContext(ctx, `SELECT 1 FROM poc_user_tables WHERE table_name = ?`, name).Scan(&exists)
	if err == sql.ErrNoRows {
		return fmt.Errorf("table '%s' is not a user table", name)
	}
	if err != nil {
		return err
	}

	if _, err := s.db.ExecContext(ctx, fmt.Sprintf("DROP TABLE IF EXISTS `%s`", name)); err != nil {
		return fmt.Errorf("drop table: %w", err)
	}
	_, err = s.db.ExecContext(ctx, `DELETE FROM poc_user_tables WHERE table_name = ?`, name)
	return err
}

type UpdateMetadataRequest struct {
	TableComment string       `json:"table_comment"`
	Columns      []ColumnInfo `json:"columns"`
}

func (s *UserTableService) UpdateMetadata(ctx context.Context, tableName string, req *UpdateMetadataRequest) error {
	var exists bool
	err := s.db.QueryRowContext(ctx, `SELECT 1 FROM poc_user_tables WHERE table_name = ?`, tableName).Scan(&exists)
	if err == sql.ErrNoRows {
		return fmt.Errorf("table '%s' is not a user table", tableName)
	}
	if err != nil {
		return err
	}

	if req.TableComment != "" {
		alterTable := fmt.Sprintf("ALTER TABLE `%s` COMMENT='%s'", tableName, escapeSQL(req.TableComment))
		if _, err := s.db.ExecContext(ctx, alterTable); err != nil {
			return fmt.Errorf("alter table comment: %w", err)
		}
		if _, err := s.db.ExecContext(ctx,
			`UPDATE poc_user_tables SET table_comment = ? WHERE table_name = ?`,
			req.TableComment, tableName); err != nil {
			log.Printf("user_tables: update meta comment for %s: %v", tableName, err)
		}
	}

	for _, col := range req.Columns {
		if col.Comment == "" {
			continue
		}
		alterCol := fmt.Sprintf("ALTER TABLE `%s` MODIFY COLUMN `%s` %s COMMENT '%s'",
			tableName, col.Name, s.getColumnType(ctx, tableName, col.Name), escapeSQL(col.Comment))
		if _, err := s.db.ExecContext(ctx, alterCol); err != nil {
			return fmt.Errorf("alter column %s comment: %w", col.Name, err)
		}
	}
	return nil
}

func (s *UserTableService) getColumnType(ctx context.Context, table, column string) string {
	var colType string
	err := s.db.QueryRowContext(ctx,
		`SELECT COLUMN_TYPE FROM information_schema.columns WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
		s.dbName, table, column).Scan(&colType)
	if err != nil {
		return "TEXT"
	}
	return colType
}

type DataPreviewResult struct {
	Columns []string   `json:"columns"`
	Rows    [][]string `json:"rows"`
	Total   int64      `json:"total"`
}

func (s *UserTableService) PreviewData(ctx context.Context, tableName string) (*DataPreviewResult, error) {
	var exists bool
	err := s.db.QueryRowContext(ctx, `SELECT 1 FROM poc_user_tables WHERE table_name = ?`, tableName).Scan(&exists)
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("table '%s' is not a user table", tableName)
	}
	if err != nil {
		return nil, err
	}

	colRows, err := s.db.QueryContext(ctx,
		`SELECT COLUMN_NAME FROM information_schema.columns WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
		s.dbName, tableName)
	if err != nil {
		return nil, err
	}
	defer colRows.Close()

	var colNames []string
	for colRows.Next() {
		var name string
		if err := colRows.Scan(&name); err != nil {
			return nil, err
		}
		colNames = append(colNames, name)
	}

	query := fmt.Sprintf("SELECT * FROM `%s` LIMIT 100", tableName)
	dataRows, err := s.db.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer dataRows.Close()

	var rows [][]string
	for dataRows.Next() {
		vals := make([]sql.NullString, len(colNames))
		ptrs := make([]any, len(colNames))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := dataRows.Scan(ptrs...); err != nil {
			return nil, err
		}
		row := make([]string, len(colNames))
		for i, v := range vals {
			if v.Valid {
				row[i] = v.String
			}
		}
		rows = append(rows, row)
	}

	var total int64
	_ = s.db.QueryRowContext(ctx, fmt.Sprintf("SELECT COUNT(*) FROM `%s`", tableName)).Scan(&total)

	return &DataPreviewResult{Columns: colNames, Rows: rows, Total: total}, nil
}

func (s *UserTableService) GetUserTableNames(ctx context.Context) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT table_name FROM poc_user_tables`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var names []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return nil, err
		}
		names = append(names, n)
	}
	return names, rows.Err()
}

func (s *UserTableService) GetTableColumnsWithMeta(ctx context.Context, tableName string) ([]ColumnInfo, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT COLUMN_NAME, COLUMN_TYPE, COLUMN_COMMENT
		 FROM information_schema.columns
		 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
		 ORDER BY ORDINAL_POSITION`, s.dbName, tableName)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var cols []ColumnInfo
	for rows.Next() {
		var c ColumnInfo
		if err := rows.Scan(&c.Name, &c.Type, &c.Comment); err != nil {
			return nil, err
		}
		cols = append(cols, c)
	}
	return cols, rows.Err()
}

func (s *UserTableService) cleanupLoop() {
	ticker := time.NewTicker(2 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		s.mu.Lock()
		now := time.Now()
		for key, entry := range s.tmpFiles {
			if now.Sub(entry.createdAt) > 10*time.Minute {
				_ = os.Remove(entry.path)
				delete(s.tmpFiles, key)
				log.Printf("user_tables: cleaned up expired temp file %s", key)
			}
		}
		s.mu.Unlock()
	}
}

// intFromString is a helper used by the handler
func intFromString(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}
```

- [ ] **Step 6: Verify compilation**

```bash
cd /Users/zhangqq/Documents/pythonProject/HK_POC/backend
go build ./...
```

Expected: compiles with no errors (handler not yet registered, but file compiles standalone)

- [ ] **Step 7: Commit**

```bash
git add backend/user_tables.go
git commit -m "feat(backend): add user table service — Excel parsing, type inference, CRUD"
```

---

## Task 3: Backend HTTP handler — `user_tables_handler.go`

**Files:**
- Create: `backend/user_tables_handler.go`

- [ ] **Step 1: Create handler with route dispatch**

```go
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/google/uuid"
)

const maxUploadSize = 50 << 20 // 50MB

type UserTablesHandler struct {
	svc *UserTableService
}

func NewUserTablesHandler(svc *UserTableService) *UserTablesHandler {
	return &UserTablesHandler{svc: svc}
}

func (h *UserTablesHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	rest := strings.TrimPrefix(r.URL.Path, "/api/user-tables")
	rest = strings.Trim(rest, "/")

	switch {
	case rest == "" && r.Method == http.MethodGet:
		h.list(w, r)
	case rest == "preview" && r.Method == http.MethodPost:
		h.preview(w, r)
	case rest == "create" && r.Method == http.MethodPost:
		h.create(w, r)
	case strings.Contains(rest, "/"):
		parts := strings.SplitN(rest, "/", 2)
		tableName := parts[0]
		sub := parts[1]
		switch {
		case sub == "metadata" && r.Method == http.MethodPatch:
			h.updateMetadata(w, r, tableName)
		case sub == "preview" && r.Method == http.MethodGet:
			h.previewData(w, r, tableName)
		case sub == "columns" && r.Method == http.MethodGet:
			h.getColumns(w, r, tableName)
		default:
			http.NotFound(w, r)
		}
	case rest != "" && r.Method == http.MethodDelete:
		h.delete(w, r, rest)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}
```

- [ ] **Step 2: Add preview handler (multipart upload)**

```go
func (h *UserTablesHandler) preview(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadSize)
	if err := r.ParseMultipartForm(maxUploadSize); err != nil {
		http.Error(w, fmt.Sprintf("file too large (max 50MB): %v", err), http.StatusBadRequest)
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		http.Error(w, fmt.Sprintf("missing file field: %v", err), http.StatusBadRequest)
		return
	}
	defer file.Close()

	ext := strings.ToLower(filepath.Ext(header.Filename))
	if ext != ".xlsx" {
		http.Error(w, "only .xlsx files are supported", http.StatusBadRequest)
		return
	}

	fileKey := uuid.New().String()
	tmpPath := filepath.Join(h.svc.tmpDir, fileKey+".xlsx")
	dst, err := os.Create(tmpPath)
	if err != nil {
		http.Error(w, fmt.Sprintf("create temp file: %v", err), http.StatusInternalServerError)
		return
	}
	if _, err := io.Copy(dst, file); err != nil {
		dst.Close()
		os.Remove(tmpPath)
		http.Error(w, fmt.Sprintf("save file: %v", err), http.StatusInternalServerError)
		return
	}
	dst.Close()

	result, err := h.svc.PreviewExcel(tmpPath)
	if err != nil {
		os.Remove(tmpPath)
		http.Error(w, fmt.Sprintf("parse excel: %v", err), http.StatusBadRequest)
		return
	}

	result.FileKey = fileKey
	h.svc.SaveTempFile(fileKey, tmpPath)

	writeJSON(w, http.StatusOK, result)
}
```

- [ ] **Step 3: Add create, list, delete, metadata, preview data, and columns handlers**

```go
func (h *UserTablesHandler) create(w http.ResponseWriter, r *http.Request) {
	var req CreateTableRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, fmt.Sprintf("invalid request: %v", err), http.StatusBadRequest)
		return
	}

	rowCount, err := h.svc.CreateTable(r.Context(), &req)
	if err != nil {
		status := http.StatusInternalServerError
		if strings.Contains(err.Error(), "conflicts with") || strings.Contains(err.Error(), "must match") || strings.Contains(err.Error(), "expired") {
			status = http.StatusBadRequest
		}
		http.Error(w, err.Error(), status)
		return
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"table_name": req.TableName,
		"row_count":  rowCount,
	})
}

func (h *UserTablesHandler) list(w http.ResponseWriter, r *http.Request) {
	tables, err := h.svc.ListUserTables(r.Context())
	if err != nil {
		http.Error(w, fmt.Sprintf("list: %v", err), http.StatusInternalServerError)
		return
	}
	if tables == nil {
		tables = []UserTableMeta{}
	}
	writeJSON(w, http.StatusOK, tables)
}

func (h *UserTablesHandler) delete(w http.ResponseWriter, r *http.Request, name string) {
	if err := h.svc.DeleteTable(r.Context(), name); err != nil {
		status := http.StatusInternalServerError
		if strings.Contains(err.Error(), "not a user table") {
			status = http.StatusBadRequest
		}
		http.Error(w, err.Error(), status)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *UserTablesHandler) updateMetadata(w http.ResponseWriter, r *http.Request, name string) {
	var req UpdateMetadataRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, fmt.Sprintf("invalid request: %v", err), http.StatusBadRequest)
		return
	}
	if err := h.svc.UpdateMetadata(r.Context(), name, &req); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *UserTablesHandler) previewData(w http.ResponseWriter, r *http.Request, name string) {
	result, err := h.svc.PreviewData(r.Context(), name)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (h *UserTablesHandler) getColumns(w http.ResponseWriter, r *http.Request, name string) {
	cols, err := h.svc.GetTableColumnsWithMeta(r.Context(), name)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, cols)
}
```

- [ ] **Step 4: Verify compilation**

```bash
cd /Users/zhangqq/Documents/pythonProject/HK_POC/backend
go build ./...
```

Note: This will fail because `uuid` is not yet in go.mod. We need to add it OR generate UUIDs without the package. Since the project doesn't currently use `uuid`, use a simple approach instead. Replace the import and usage:

Remove `"github.com/google/uuid"` import. Replace `fileKey := uuid.New().String()` with:

```go
import "crypto/rand"

// At top of preview():
fileKey := generateFileKey()

// Add helper:
func generateFileKey() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return fmt.Sprintf("%x", b)
}
```

Then rebuild:

```bash
cd /Users/zhangqq/Documents/pythonProject/HK_POC/backend
go build ./...
```

Expected: compiles with no errors

- [ ] **Step 5: Commit**

```bash
git add backend/user_tables_handler.go
git commit -m "feat(backend): add user tables HTTP handler — preview, create, list, delete, metadata"
```

---

## Task 4: Wire up routes in `main.go` + dynamic `/api/tables`

**Files:**
- Modify: `backend/main.go:38-49` (replace hardcoded `/api/tables`)
- Modify: `backend/main.go` (add route registration after feedbackDB init)

- [ ] **Step 1: Add UserTableService initialization after `convDB` init (around line 67)**

After the line `clarifier := NewClarifier(...)` (line 70), add:

```go
	userTableSvc, err := NewUserTableService(feedbackDB.RawDB(), cfg.Explore.DBName)
	if err != nil {
		log.Fatalf("init user table service: %v", err)
	}
```

- [ ] **Step 2: Replace hardcoded `/api/tables` handler (lines 38-49)**

Replace the existing `mux.HandleFunc("/api/tables", ...)` block with:

```go
	mux.HandleFunc("/api/tables", func(w http.ResponseWriter, r *http.Request) {
		setCORSHeaders(w)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.Header().Set("Content-Type", "application/json")

		systemTbls := []map[string]string{
			{"name": "ms_v_stk_hsi_daily", "label": "恒生指数日线 / HSI Daily", "source": "system"},
			{"name": "ms_t_stk_sis", "label": "个股行情 / Stock Trading", "source": "system"},
			{"name": "ms_v_stock_capital", "label": "市值数据 / Market Cap", "source": "system"},
			{"name": "ds_t_int_hsicl_dtl", "label": "行业分类 / Industry Classification", "source": "system"},
			{"name": "sehknews", "label": "新闻公告 / News", "source": "system"},
			{"name": "profit_loss", "label": "财务报表 / Financial Statements", "source": "system"},
			{"name": "ccass_holdings", "label": "CCASS持仓 / CCASS Holdings", "source": "system"},
		}

		userTbls, err := userTableSvc.ListUserTables(r.Context())
		if err != nil {
			log.Printf("tables: list user tables: %v", err)
		}

		result := make([]map[string]string, 0, len(systemTbls)+len(userTbls))
		result = append(result, systemTbls...)
		for _, ut := range userTbls {
			result = append(result, map[string]string{
				"name":   ut.TableName,
				"label":  ut.TableName + " / " + ut.TableComment,
				"source": "user",
			})
		}
		json.NewEncoder(w).Encode(result)
	})
```

- [ ] **Step 3: Register user-tables handler routes (after knowledgeHandler)**

After `mux.Handle("/api/knowledge", knowledgeHandler)` (line 54), add:

```go
	userTablesHandler := NewUserTablesHandler(userTableSvc)
	mux.Handle("/api/user-tables/", userTablesHandler)
	mux.Handle("/api/user-tables", userTablesHandler)
```

- [ ] **Step 4: Modify Explore request to include user tables**

In `handler.go`, the `ExploreRequest` builds `TableList` from `req.Tables` or `h.cfg.Explore.Tables` (lines 188-194). We need to also merge user tables. Modify the `MessagesHandler` struct to hold a reference to `UserTableService`:

In `handler.go`, update `MessagesHandler`:

```go
type MessagesHandler struct {
	client       *ExploreClient
	clarify      *Clarifier
	db           *ConversationsDB
	cfg          *Config
	metrics      *MetricRegistry
	userTableSvc *UserTableService
}

func NewMessagesHandler(client *ExploreClient, clarify *Clarifier, db *ConversationsDB, cfg *Config, metrics *MetricRegistry, userTableSvc *UserTableService) *MessagesHandler {
	return &MessagesHandler{client: client, clarify: clarify, db: db, cfg: cfg, metrics: metrics, userTableSvc: userTableSvc}
}
```

Then update the `TableList` closure in `HandleSend` (around line 189):

```go
				TableList: func() []string {
					base := h.cfg.Explore.Tables
					if len(req.Tables) > 0 {
						base = req.Tables
					}
					if h.userTableSvc != nil {
						userNames, _ := h.userTableSvc.GetUserTableNames(r.Context())
						if len(userNames) > 0 {
							merged := make([]string, 0, len(base)+len(userNames))
							merged = append(merged, base...)
							existing := make(map[string]bool, len(base))
							for _, t := range base {
								existing[t] = true
							}
							for _, ut := range userNames {
								if !existing[ut] {
									merged = append(merged, ut)
								}
							}
							return merged
						}
					}
					return base
				}(),
```

- [ ] **Step 5: Update `NewMessagesHandler` call in `main.go`**

Change line 73:

```go
	messagesHandler := NewMessagesHandler(client, clarifier, convDB, cfg, metrics, userTableSvc)
```

- [ ] **Step 6: Verify compilation**

```bash
cd /Users/zhangqq/Documents/pythonProject/HK_POC/backend
go build ./...
```

Expected: compiles with no errors

- [ ] **Step 7: Commit**

```bash
git add backend/main.go backend/handler.go
git commit -m "feat(backend): wire user-tables routes + dynamic /api/tables + merge into Explore table_list"
```

---

## Task 5: Frontend API client — `api/userTables.ts`

**Files:**
- Create: `web/src/api/userTables.ts`

- [ ] **Step 1: Create API client**

```typescript
export interface ColumnInfo {
  name: string
  inferred_type?: string
  type?: string
  comment?: string
  samples?: string[]
}

export interface PreviewResult {
  file_key: string
  sheet_name: string
  columns: ColumnInfo[]
  preview_rows: string[][]
  total_rows: number
}

export interface UserTableMeta {
  table_name: string
  table_comment: string
  row_count: number
  created_at: string
  source: string
}

export interface DataPreviewResult {
  columns: string[]
  rows: string[][]
  total: number
}

const BASE = '/api/user-tables'

async function parseJSON<T>(resp: Response): Promise<T> {
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`HTTP ${resp.status}: ${text}`)
  }
  return resp.json() as Promise<T>
}

export async function uploadPreview(file: File): Promise<PreviewResult> {
  const form = new FormData()
  form.append('file', file)
  const resp = await fetch(`${BASE}/preview`, { method: 'POST', body: form })
  return parseJSON<PreviewResult>(resp)
}

export async function createTable(req: {
  file_key: string
  table_name: string
  table_comment: string
  columns: ColumnInfo[]
}): Promise<{ table_name: string; row_count: number }> {
  const resp = await fetch(`${BASE}/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  })
  return parseJSON<{ table_name: string; row_count: number }>(resp)
}

export async function listUserTables(): Promise<UserTableMeta[]> {
  const resp = await fetch(BASE)
  return parseJSON<UserTableMeta[]>(resp)
}

export async function deleteUserTable(name: string): Promise<void> {
  const resp = await fetch(`${BASE}/${name}`, { method: 'DELETE' })
  if (!resp.ok) throw new Error(`delete failed: ${resp.status}`)
}

export async function updateMetadata(
  name: string,
  req: { table_comment: string; columns: { name: string; comment: string }[] }
): Promise<void> {
  const resp = await fetch(`${BASE}/${name}/metadata`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  })
  if (!resp.ok) throw new Error(`update metadata failed: ${resp.status}`)
}

export async function previewTableData(name: string): Promise<DataPreviewResult> {
  const resp = await fetch(`${BASE}/${name}/preview`)
  return parseJSON<DataPreviewResult>(resp)
}

export async function getTableColumns(name: string): Promise<ColumnInfo[]> {
  const resp = await fetch(`${BASE}/${name}/columns`)
  return parseJSON<ColumnInfo[]>(resp)
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/api/userTables.ts
git commit -m "feat(frontend): add user tables API client"
```

---

## Task 6: i18n — add translation keys

**Files:**
- Modify: `web/src/i18n/zh.json`
- Modify: `web/src/i18n/en.json`

- [ ] **Step 1: Add keys to `zh.json`**

Add these entries before the closing `}`:

```json
  "tableManagement": "数据表管理",
  "tableManagementDesc": "管理用户上传的数据表",
  "uploadExcel": "上传 Excel",
  "uploadDragHint": "拖拽 .xlsx 文件到此处，或点击选择",
  "confirmCreate": "确认建表",
  "editMetadata": "编辑元数据",
  "deleteTable": "删除",
  "previewTable": "预览",
  "tableName": "表名",
  "tableComment": "表注释",
  "columnName": "列名",
  "columnType": "类型",
  "columnComment": "列注释",
  "inferredType": "推断类型",
  "previewData": "预览数据",
  "rowCount": "行数",
  "noUserTables": "暂无用户上传的表",
  "confirmDeleteTable": "确认删除此表？删除后不可恢复。",
  "tableCreated": "表创建成功",
  "metadataSaved": "元数据保存成功",
  "uploadError": "上传失败",
  "createError": "建表失败",
  "tableNameHint": "仅允许小写字母、数字和下划线",
  "save": "保存",
  "cancel": "取消",
  "close": "关闭",
  "creating": "建表中...",
  "uploading": "解析中..."
```

- [ ] **Step 2: Add keys to `en.json`**

Add the same keys with English values:

```json
  "tableManagement": "Table Management",
  "tableManagementDesc": "Manage user-uploaded data tables",
  "uploadExcel": "Upload Excel",
  "uploadDragHint": "Drag & drop .xlsx file here, or click to select",
  "confirmCreate": "Create Table",
  "editMetadata": "Edit Metadata",
  "deleteTable": "Delete",
  "previewTable": "Preview",
  "tableName": "Table Name",
  "tableComment": "Table Description",
  "columnName": "Column",
  "columnType": "Type",
  "columnComment": "Comment",
  "inferredType": "Inferred Type",
  "previewData": "Preview Data",
  "rowCount": "Rows",
  "noUserTables": "No user-uploaded tables yet",
  "confirmDeleteTable": "Delete this table? This cannot be undone.",
  "tableCreated": "Table created successfully",
  "metadataSaved": "Metadata saved successfully",
  "uploadError": "Upload failed",
  "createError": "Create table failed",
  "tableNameHint": "Only lowercase letters, numbers, and underscores",
  "save": "Save",
  "cancel": "Cancel",
  "close": "Close",
  "creating": "Creating...",
  "uploading": "Parsing..."
```

- [ ] **Step 3: Commit**

```bash
git add web/src/i18n/zh.json web/src/i18n/en.json
git commit -m "feat(i18n): add user table management translations"
```

---

## Task 7: Frontend — `ExcelUploadDialog.tsx`

**Files:**
- Create: `web/src/components/ExcelUploadDialog.tsx`

- [ ] **Step 1: Create the upload dialog component**

```tsx
import { useState, useRef, useCallback } from 'react'
import { useT } from '../i18n'
import type { PreviewResult, ColumnInfo } from '../api/userTables'
import { uploadPreview, createTable } from '../api/userTables'

interface ExcelUploadDialogProps {
  open: boolean
  onClose: () => void
  onCreated: () => void
}

const ALLOWED_TYPES = [
  'VARCHAR', 'BIGINT', 'DECIMAL(18,6)', 'DATE', 'DATETIME', 'TEXT',
]

export function ExcelUploadDialog({ open, onClose, onCreated }: ExcelUploadDialogProps) {
  const { t } = useT()
  const fileInput = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [tableName, setTableName] = useState('')
  const [tableComment, setTableComment] = useState('')
  const [columns, setColumns] = useState<ColumnInfo[]>([])

  const reset = useCallback(() => {
    setPreview(null)
    setTableName('')
    setTableComment('')
    setColumns([])
    setError('')
    setUploading(false)
    setCreating(false)
  }, [])

  const handleClose = () => {
    reset()
    onClose()
  }

  const handleFile = async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.xlsx')) {
      setError('Only .xlsx files are supported')
      return
    }
    setError('')
    setUploading(true)
    try {
      const result = await uploadPreview(file)
      setPreview(result)
      setColumns(result.columns.map(c => ({ ...c, type: c.inferred_type, comment: '' })))
      const suggested = file.name.replace(/\.xlsx$/i, '')
        .toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').slice(0, 64)
      setTableName(suggested)
    } catch (err: any) {
      setError(err.message || t('uploadError'))
    } finally {
      setUploading(false)
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }

  const handleCreate = async () => {
    if (!preview || !tableName) return
    setCreating(true)
    setError('')
    try {
      await createTable({
        file_key: preview.file_key,
        table_name: tableName,
        table_comment: tableComment,
        columns: columns.map(c => ({
          name: c.name,
          type: c.type || c.inferred_type || 'VARCHAR(255)',
          comment: c.comment || '',
        })),
      })
      handleClose()
      onCreated()
    } catch (err: any) {
      setError(err.message || t('createError'))
    } finally {
      setCreating(false)
    }
  }

  const updateColumn = (idx: number, field: keyof ColumnInfo, value: string) => {
    setColumns(prev => prev.map((c, i) => i === idx ? { ...c, [field]: value } : c))
  }

  if (!open) return null

  return (
    <div className="knowledge-modal-overlay" onClick={handleClose}>
      <div
        className="knowledge-modal"
        style={{ maxWidth: '800px', width: '90vw', maxHeight: '85vh', overflow: 'auto' }}
        onClick={e => e.stopPropagation()}
      >
        <h3>{t('uploadExcel')}</h3>

        {error && <div style={{ color: '#e53e3e', marginBottom: '12px', fontSize: '14px' }}>{error}</div>}

        {!preview ? (
          <div
            className={`upload-dropzone${dragging ? ' dragging' : ''}`}
            onDragOver={e => { e.preventDefault(); setDragging(true) }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            onClick={() => fileInput.current?.click()}
            style={{
              border: '2px dashed #d0d5dd',
              borderRadius: '8px',
              padding: '48px 24px',
              textAlign: 'center',
              cursor: 'pointer',
              background: dragging ? '#f0f5ff' : '#fafafa',
              transition: 'background 0.2s',
            }}
          >
            <input
              ref={fileInput}
              type="file"
              accept=".xlsx"
              style={{ display: 'none' }}
              onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f) }}
            />
            {uploading ? (
              <div><div className="phase-spinner" style={{ margin: '0 auto 8px' }} />{t('uploading')}</div>
            ) : (
              <div style={{ color: '#667085' }}>{t('uploadDragHint')}</div>
            )}
          </div>
        ) : (
          <>
            {/* Table name + comment */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '16px' }}>
              <div className="knowledge-form-group">
                <label>{t('tableName')}</label>
                <input value={tableName} onChange={e => setTableName(e.target.value)} />
                <div className="form-hint">{t('tableNameHint')}</div>
              </div>
              <div className="knowledge-form-group">
                <label>{t('tableComment')}</label>
                <input value={tableComment} onChange={e => setTableComment(e.target.value)} />
              </div>
            </div>

            {/* Columns */}
            <div style={{ marginBottom: '16px' }}>
              <label style={{ fontWeight: 600, fontSize: '13px', marginBottom: '8px', display: 'block' }}>
                {t('columnName')} / {t('columnType')} / {t('columnComment')}
              </label>
              <div style={{ maxHeight: '200px', overflow: 'auto', border: '1px solid #e4e7ec', borderRadius: '6px' }}>
                <table style={{ width: '100%', fontSize: '13px', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#f9fafb' }}>
                      <th style={{ padding: '6px 8px', textAlign: 'left' }}>{t('columnName')}</th>
                      <th style={{ padding: '6px 8px', textAlign: 'left' }}>{t('columnType')}</th>
                      <th style={{ padding: '6px 8px', textAlign: 'left' }}>{t('columnComment')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {columns.map((col, i) => (
                      <tr key={i} style={{ borderTop: '1px solid #f0f0f0' }}>
                        <td style={{ padding: '4px 8px' }}>{col.name}</td>
                        <td style={{ padding: '4px 8px' }}>
                          <select
                            value={col.type || col.inferred_type}
                            onChange={e => updateColumn(i, 'type', e.target.value)}
                            style={{ fontSize: '12px', padding: '2px 4px' }}
                          >
                            {ALLOWED_TYPES.map(t => (
                              <option key={t} value={t}>{t}</option>
                            ))}
                            {col.inferred_type && !ALLOWED_TYPES.includes(col.inferred_type) && (
                              <option value={col.inferred_type}>{col.inferred_type}</option>
                            )}
                          </select>
                        </td>
                        <td style={{ padding: '4px 8px' }}>
                          <input
                            value={col.comment || ''}
                            onChange={e => updateColumn(i, 'comment', e.target.value)}
                            placeholder="..."
                            style={{ width: '100%', fontSize: '12px', border: '1px solid #e4e7ec', borderRadius: '4px', padding: '2px 4px' }}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Data preview */}
            <div style={{ marginBottom: '16px' }}>
              <label style={{ fontWeight: 600, fontSize: '13px', marginBottom: '8px', display: 'block' }}>
                {t('previewData')} ({preview.total_rows} {t('rowCount')})
              </label>
              <div style={{ maxHeight: '180px', overflow: 'auto', border: '1px solid #e4e7ec', borderRadius: '6px' }}>
                <table style={{ width: '100%', fontSize: '12px', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#f9fafb' }}>
                      {preview.columns.map((c, i) => (
                        <th key={i} style={{ padding: '4px 8px', textAlign: 'left', whiteSpace: 'nowrap' }}>{c.name}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.preview_rows.map((row, ri) => (
                      <tr key={ri} style={{ borderTop: '1px solid #f0f0f0' }}>
                        {row.map((cell, ci) => (
                          <td key={ci} style={{ padding: '4px 8px', whiteSpace: 'nowrap', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis' }}>{cell}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Actions */}
            <div className="knowledge-form-actions">
              <button className="knowledge-btn-cancel" onClick={handleClose}>{t('cancel')}</button>
              <button
                className="knowledge-btn-save"
                onClick={handleCreate}
                disabled={creating || !tableName.match(/^[a-z0-9_]{1,64}$/)}
              >
                {creating ? t('creating') : t('confirmCreate')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/components/ExcelUploadDialog.tsx
git commit -m "feat(frontend): add Excel upload dialog with preview and type editing"
```

---

## Task 8: Frontend — `ColumnMetaEditor.tsx`

**Files:**
- Create: `web/src/components/ColumnMetaEditor.tsx`

- [ ] **Step 1: Create the metadata editor component**

```tsx
import { useState, useEffect } from 'react'
import { useT } from '../i18n'
import type { ColumnInfo } from '../api/userTables'
import { getTableColumns, updateMetadata } from '../api/userTables'

interface ColumnMetaEditorProps {
  tableName: string
  tableComment: string
  onSaved: () => void
  onCancel: () => void
}

export function ColumnMetaEditor({ tableName, tableComment, onSaved, onCancel }: ColumnMetaEditorProps) {
  const { t } = useT()
  const [columns, setColumns] = useState<ColumnInfo[]>([])
  const [comment, setComment] = useState(tableComment)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    getTableColumns(tableName)
      .then(setColumns)
      .catch(err => console.error('[ColumnMetaEditor] load columns:', err))
      .finally(() => setLoading(false))
  }, [tableName])

  const handleSave = async () => {
    setSaving(true)
    try {
      await updateMetadata(tableName, {
        table_comment: comment,
        columns: columns.map(c => ({ name: c.name, comment: c.comment || '' })),
      })
      onSaved()
    } catch (err) {
      console.error('[ColumnMetaEditor] save error:', err)
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <div style={{ padding: '12px', textAlign: 'center' }}><div className="phase-spinner" /></div>
  }

  return (
    <div style={{ padding: '12px 0' }}>
      <div className="knowledge-form-group" style={{ marginBottom: '12px' }}>
        <label>{t('tableComment')}</label>
        <input value={comment} onChange={e => setComment(e.target.value)} />
      </div>

      <div style={{ maxHeight: '240px', overflow: 'auto', border: '1px solid #e4e7ec', borderRadius: '6px', marginBottom: '12px' }}>
        <table style={{ width: '100%', fontSize: '13px', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: '#f9fafb' }}>
              <th style={{ padding: '6px 8px', textAlign: 'left' }}>{t('columnName')}</th>
              <th style={{ padding: '6px 8px', textAlign: 'left' }}>{t('columnType')}</th>
              <th style={{ padding: '6px 8px', textAlign: 'left' }}>{t('columnComment')}</th>
            </tr>
          </thead>
          <tbody>
            {columns.map((col, i) => (
              <tr key={i} style={{ borderTop: '1px solid #f0f0f0' }}>
                <td style={{ padding: '4px 8px', fontFamily: 'monospace', fontSize: '12px' }}>{col.name}</td>
                <td style={{ padding: '4px 8px', color: '#667085', fontSize: '12px' }}>{col.type}</td>
                <td style={{ padding: '4px 8px' }}>
                  <input
                    value={col.comment || ''}
                    onChange={e => setColumns(prev => prev.map((c, j) => j === i ? { ...c, comment: e.target.value } : c))}
                    style={{ width: '100%', fontSize: '12px', border: '1px solid #e4e7ec', borderRadius: '4px', padding: '2px 6px' }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
        <button className="knowledge-btn-cancel" onClick={onCancel}>{t('cancel')}</button>
        <button className="knowledge-btn-save" onClick={handleSave} disabled={saving}>
          {saving ? '...' : t('save')}
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/components/ColumnMetaEditor.tsx
git commit -m "feat(frontend): add column metadata editor component"
```

---

## Task 9: Frontend — `UserTablePanel.tsx` + CSS

**Files:**
- Create: `web/src/components/UserTablePanel.tsx`
- Create: `web/src/components/UserTablePanel.css`

- [ ] **Step 1: Create CSS (based on KnowledgePanel.css pattern)**

```css
/* User Table Panel - Slide-over Drawer */
.usertable-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.3);
  z-index: 100;
  animation: kp-fadeIn 0.2s ease-out;
}

.usertable-panel {
  position: fixed;
  top: 0;
  right: 0;
  width: 640px;
  max-width: 90vw;
  height: 100vh;
  background: #fff;
  z-index: 101;
  display: flex;
  flex-direction: column;
  box-shadow: -4px 0 24px rgba(0, 0, 0, 0.12);
  animation: kp-slideIn 0.25s ease-out;
}

.usertable-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid #e4e7ec;
  flex-shrink: 0;
}

.usertable-panel-header-left h2 {
  font-size: 17px;
  font-weight: 600;
  color: #1a1a2e;
  margin: 0;
}

.usertable-panel-header-left p {
  font-size: 12px;
  color: #667085;
  margin: 4px 0 0;
}

.usertable-panel-close {
  background: none;
  border: none;
  font-size: 22px;
  cursor: pointer;
  color: #667085;
  padding: 4px 8px;
  border-radius: 4px;
}

.usertable-panel-close:hover {
  background: #f2f4f7;
}

.usertable-toolbar {
  display: flex;
  justify-content: flex-end;
  padding: 12px 20px;
  border-bottom: 1px solid #f2f4f7;
  flex-shrink: 0;
}

.usertable-upload-btn {
  background: #4f46e5;
  color: #fff;
  border: none;
  padding: 6px 14px;
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
  font-weight: 500;
}

.usertable-upload-btn:hover {
  background: #4338ca;
}

.usertable-list {
  flex: 1;
  overflow-y: auto;
  padding: 12px 20px;
}

.usertable-empty {
  text-align: center;
  color: #98a2b3;
  padding: 48px 0;
  font-size: 14px;
}

.usertable-card {
  border: 1px solid #e4e7ec;
  border-radius: 8px;
  padding: 14px 16px;
  margin-bottom: 10px;
  transition: box-shadow 0.15s;
}

.usertable-card:hover {
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
}

.usertable-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.usertable-card-name {
  font-weight: 600;
  font-size: 14px;
  color: #1a1a2e;
  font-family: monospace;
}

.usertable-card-meta {
  font-size: 12px;
  color: #98a2b3;
  margin-top: 4px;
}

.usertable-card-comment {
  font-size: 13px;
  color: #475467;
  margin-top: 4px;
}

.usertable-card-actions {
  display: flex;
  gap: 6px;
}

.usertable-card-actions button {
  background: none;
  border: 1px solid #e4e7ec;
  padding: 3px 10px;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  color: #475467;
}

.usertable-card-actions button:hover {
  background: #f9fafb;
}

.usertable-card-actions button.delete {
  color: #e53e3e;
  border-color: #fed7d7;
}

.usertable-card-actions button.delete:hover {
  background: #fff5f5;
}

.usertable-preview-section {
  margin-top: 10px;
  border-top: 1px solid #f2f4f7;
  padding-top: 10px;
}

.usertable-preview-section table {
  width: 100%;
  font-size: 12px;
  border-collapse: collapse;
}

.usertable-preview-section th {
  background: #f9fafb;
  padding: 4px 8px;
  text-align: left;
  font-weight: 500;
}

.usertable-preview-section td {
  padding: 3px 8px;
  border-top: 1px solid #f0f0f0;
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

- [ ] **Step 2: Create `UserTablePanel.tsx`**

```tsx
import { useState, useEffect, useCallback } from 'react'
import { useT } from '../i18n'
import { listUserTables, deleteUserTable, previewTableData } from '../api/userTables'
import type { UserTableMeta, DataPreviewResult } from '../api/userTables'
import { ExcelUploadDialog } from './ExcelUploadDialog'
import { ColumnMetaEditor } from './ColumnMetaEditor'
import './UserTablePanel.css'

interface UserTablePanelProps {
  open: boolean
  onClose: () => void
}

export function UserTablePanel({ open, onClose }: UserTablePanelProps) {
  const { t } = useT()
  const [tables, setTables] = useState<UserTableMeta[]>([])
  const [loading, setLoading] = useState(false)
  const [showUpload, setShowUpload] = useState(false)
  const [editingTable, setEditingTable] = useState<string | null>(null)
  const [previewingTable, setPreviewingTable] = useState<string | null>(null)
  const [previewData, setPreviewData] = useState<DataPreviewResult | null>(null)

  const fetchTables = useCallback(async () => {
    setLoading(true)
    try {
      const list = await listUserTables()
      setTables(list)
    } catch (err) {
      console.error('[UserTablePanel] fetch error:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) fetchTables()
  }, [open, fetchTables])

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showUpload) setShowUpload(false)
        else if (editingTable) setEditingTable(null)
        else onClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, showUpload, editingTable, onClose])

  const handleDelete = async (name: string) => {
    if (!confirm(t('confirmDeleteTable'))) return
    try {
      await deleteUserTable(name)
      await fetchTables()
    } catch (err) {
      console.error('[UserTablePanel] delete error:', err)
    }
  }

  const handlePreview = async (name: string) => {
    if (previewingTable === name) {
      setPreviewingTable(null)
      setPreviewData(null)
      return
    }
    try {
      const data = await previewTableData(name)
      setPreviewData(data)
      setPreviewingTable(name)
    } catch (err) {
      console.error('[UserTablePanel] preview error:', err)
    }
  }

  if (!open) return null

  return (
    <>
      <div className="usertable-overlay" onClick={onClose} />
      <div className="usertable-panel">
        <div className="usertable-panel-header">
          <div className="usertable-panel-header-left">
            <h2>{t('tableManagement')}</h2>
            <p>{t('tableManagementDesc')}</p>
          </div>
          <button className="usertable-panel-close" onClick={onClose}>×</button>
        </div>

        <div className="usertable-toolbar">
          <button className="usertable-upload-btn" onClick={() => setShowUpload(true)}>
            + {t('uploadExcel')}
          </button>
        </div>

        <div className="usertable-list">
          {loading ? (
            <div className="usertable-empty"><div className="phase-spinner" /> Loading...</div>
          ) : tables.length === 0 ? (
            <div className="usertable-empty">{t('noUserTables')}</div>
          ) : (
            tables.map(tbl => (
              <div key={tbl.table_name} className="usertable-card">
                <div className="usertable-card-header">
                  <div>
                    <div className="usertable-card-name">{tbl.table_name}</div>
                    {tbl.table_comment && (
                      <div className="usertable-card-comment">{tbl.table_comment}</div>
                    )}
                    <div className="usertable-card-meta">
                      {tbl.row_count} {t('rowCount')} · {tbl.created_at?.slice(0, 10)}
                    </div>
                  </div>
                  <div className="usertable-card-actions">
                    <button onClick={() => setEditingTable(editingTable === tbl.table_name ? null : tbl.table_name)}>
                      {t('editMetadata')}
                    </button>
                    <button onClick={() => handlePreview(tbl.table_name)}>
                      {t('previewTable')}
                    </button>
                    <button className="delete" onClick={() => handleDelete(tbl.table_name)}>
                      {t('deleteTable')}
                    </button>
                  </div>
                </div>

                {editingTable === tbl.table_name && (
                  <ColumnMetaEditor
                    tableName={tbl.table_name}
                    tableComment={tbl.table_comment}
                    onSaved={() => { setEditingTable(null); fetchTables() }}
                    onCancel={() => setEditingTable(null)}
                  />
                )}

                {previewingTable === tbl.table_name && previewData && (
                  <div className="usertable-preview-section">
                    <div style={{ maxHeight: '200px', overflow: 'auto' }}>
                      <table>
                        <thead>
                          <tr>
                            {previewData.columns.map((col, i) => (
                              <th key={i}>{col}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {previewData.rows.slice(0, 20).map((row, ri) => (
                            <tr key={ri}>
                              {row.map((cell, ci) => (
                                <td key={ci}>{cell}</td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div style={{ fontSize: '11px', color: '#98a2b3', marginTop: '6px' }}>
                      {previewData.total} {t('rowCount')}
                    </div>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      <ExcelUploadDialog
        open={showUpload}
        onClose={() => setShowUpload(false)}
        onCreated={fetchTables}
      />
    </>
  )
}
```

- [ ] **Step 3: Commit**

```bash
git add web/src/components/UserTablePanel.tsx web/src/components/UserTablePanel.css
git commit -m "feat(frontend): add user table management panel with upload, preview, delete, metadata editing"
```

---

## Task 10: Wire into `App.tsx` + update `TableSelector.tsx`

**Files:**
- Modify: `web/src/App.tsx`
- Modify: `web/src/components/TableSelector.tsx`

- [ ] **Step 1: Add UserTablePanel to App.tsx**

Add import at top:

```tsx
import { UserTablePanel } from './components/UserTablePanel'
```

Add state (after `const [analysisOpen, setAnalysisOpen] = useState(false)`):

```tsx
const [tableManageOpen, setTableManageOpen] = useState(false)
```

Add button in header (before the knowledge button, inside the `<div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>` block):

```tsx
            <button
              className="lang-switch"
              onClick={() => setTableManageOpen(true)}
            >
              {t('tableManagement')}
            </button>
```

Add panel render (after `<AnalysisPanel .../>`, before closing `</LangContext.Provider>`):

```tsx
      <UserTablePanel open={tableManageOpen} onClose={() => setTableManageOpen(false)} />
```

- [ ] **Step 2: Update TableSelector to distinguish user tables**

In `TableSelector.tsx`, update the `TableInfo` interface to include `source`:

```tsx
interface TableInfo {
  name: string
  label: string
  source?: string
}
```

Update the chip rendering to add a visual indicator for user tables. In the `tables.map(...)` callback, change the button:

```tsx
            <button
              key={t.name}
              onClick={() => toggle(t.name)}
              title={t.name}
              className={`table-chip${isOn ? ' active' : ''}${t.source === 'user' ? ' user-table' : ''}`}
            >
              {t.source === 'user' ? t.name : (t.label.split(' / ')[lang === 'zh' ? 0 : 1] || t.label)}
            </button>
```

- [ ] **Step 3: Add CSS for user-table chip**

Add to `web/src/App.css` (or wherever `.table-chip` styles live):

```css
.table-chip.user-table {
  border-style: dashed;
}
```

- [ ] **Step 4: Verify frontend builds**

```bash
cd /Users/zhangqq/Documents/pythonProject/HK_POC/web
npm run build
```

Expected: builds with no errors

- [ ] **Step 5: Commit**

```bash
git add web/src/App.tsx web/src/components/TableSelector.tsx web/src/App.css
git commit -m "feat(frontend): wire table management panel into App + user table chip style"
```

---

## Task 11: Build, deploy, and end-to-end verification

**Files:** None (verification only)

- [ ] **Step 1: Rebuild and deploy**

```bash
cd /Users/zhangqq/Documents/pythonProject/HK_POC
docker compose build app && docker compose up -d --force-recreate app
```

- [ ] **Step 2: Verify backend logs**

```bash
docker logs hk-poc-app 2>&1 | tail -20
```

Expected: logs show `init user table service` or similar without errors, server starts on :3000

- [ ] **Step 3: Test preview API**

Create a simple test Excel file and upload:

```bash
curl -s -X POST http://localhost:3000/api/user-tables/preview \
  -F "file=@test.xlsx" | python3 -m json.tool
```

Expected: JSON with `file_key`, `columns` (with inferred types), `preview_rows`, `total_rows`

- [ ] **Step 4: Test create API**

Using the `file_key` from previous step:

```bash
curl -s -X POST http://localhost:3000/api/user-tables/create \
  -H "Content-Type: application/json" \
  -d '{"file_key":"<KEY>","table_name":"test_upload","table_comment":"测试表","columns":[...]}' | python3 -m json.tool
```

Expected: `{"table_name":"test_upload","row_count":N}`

- [ ] **Step 5: Test /api/tables includes user table**

```bash
curl -s http://localhost:3000/api/tables | python3 -m json.tool
```

Expected: list includes `test_upload` with `"source":"user"`

- [ ] **Step 6: Test nl2sql query against uploaded table**

Open browser at `http://localhost:3000`, verify:
1. "数据表管理" button appears in header
2. Click it → panel opens with the uploaded table
3. Click "编辑元数据" → column editor works
4. Click "预览" → shows data rows
5. In chat, ask a question about the uploaded table's data
6. Verify Explore returns SQL results (the table is in the query scope)

- [ ] **Step 7: Test delete**

```bash
curl -s -X DELETE http://localhost:3000/api/user-tables/test_upload
```

Expected: 204 No Content, table removed from `/api/tables` list

- [ ] **Step 8: Commit any fixes**

If any issues found during testing, fix and commit.
