package main

import (
	"context"
	"database/sql"
	"encoding/csv"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/text/encoding/unicode"
	"golang.org/x/text/transform"

	"github.com/xuri/excelize/v2"
)

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

type CreateTableRequest struct {
	FileKey      string       `json:"file_key"`
	TableName    string       `json:"table_name"`
	TableComment string       `json:"table_comment"`
	Columns      []ColumnInfo `json:"columns"`
}

type UpdateMetadataRequest struct {
	TableComment string       `json:"table_comment,omitempty"`
	Columns      []ColumnInfo `json:"columns,omitempty"`
}

type DataPreviewResult struct {
	Columns []string   `json:"columns"`
	Rows    [][]string `json:"rows"`
	Total   int64      `json:"total"`
}

var validTableName = regexp.MustCompile(`^[a-z0-9_]{1,64}$`)

var systemTables = map[string]bool{
	"ms_t_stk_hsi":        true,
	"ms_v_stk_hsi_daily":  true,
	"ms_t_stk_sis":        true,
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

type tempFileEntry struct {
	path      string
	fileName  string
	createdAt time.Time
}

type UserTableService struct {
	db     *sql.DB
	dbName string

	mu    sync.Mutex
	temps map[string]tempFileEntry
}

func NewUserTableService(db *sql.DB, dbName string) (*UserTableService, error) {
	// Check if old schema exists (display_name column) and migrate
	var hasOldSchema bool
	_ = db.QueryRow(`SELECT 1 FROM information_schema.columns
		WHERE table_schema = ? AND table_name = 'poc_user_tables' AND column_name = 'display_name'`, dbName).Scan(&hasOldSchema)
	if hasOldSchema {
		log.Printf("user_tables: migrating poc_user_tables from old schema")
		db.Exec("DROP TABLE IF EXISTS poc_user_tables")
	}

	const ddl = `
CREATE TABLE IF NOT EXISTS poc_user_tables (
    table_name    VARCHAR(128) PRIMARY KEY,
    table_comment VARCHAR(512) DEFAULT '',
    row_count     BIGINT DEFAULT 0,
    created_at    DATETIME DEFAULT NOW()
)`
	if _, err := db.Exec(ddl); err != nil {
		return nil, fmt.Errorf("create poc_user_tables: %w", err)
	}

	svc := &UserTableService{
		db:     db,
		dbName: dbName,
		temps:  make(map[string]tempFileEntry),
	}
	go svc.cleanupLoop()
	return svc, nil
}

func (s *UserTableService) SaveTempFile(key, path, fileName string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.temps[key] = tempFileEntry{path: path, fileName: fileName, createdAt: time.Now()}
}

func (s *UserTableService) GetTempFile(key string) (string, string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.temps[key]
	if !ok {
		return "", "", false
	}
	return e.path, e.fileName, true
}

func (s *UserTableService) removeTempFile(key string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.temps, key)
}

func (s *UserTableService) cleanupLoop() {
	ticker := time.NewTicker(2 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		s.mu.Lock()
		cutoff := time.Now().Add(-10 * time.Minute)
		for k, e := range s.temps {
			if e.createdAt.Before(cutoff) {
				delete(s.temps, k)
			}
		}
		s.mu.Unlock()
	}
}

func (s *UserTableService) PreviewFile(filePath string) (*PreviewResult, error) {
	ext := strings.ToLower(filepath.Ext(filePath))
	if ext == ".csv" {
		return s.PreviewCSV(filePath)
	}
	return s.PreviewExcel(filePath)
}

func (s *UserTableService) PreviewCSV(filePath string) (*PreviewResult, error) {
	rows, err := readCSVRows(filePath)
	if err != nil {
		return nil, err
	}
	if len(rows) < 1 {
		return nil, fmt.Errorf("empty CSV: no header row")
	}
	return s.buildPreview(rows, filepath.Base(filePath))
}

func (s *UserTableService) PreviewExcel(filePath string) (*PreviewResult, error) {
	f, err := excelize.OpenFile(filePath)
	if err != nil {
		return nil, fmt.Errorf("open excel: %w", err)
	}
	defer f.Close()

	sheet := f.GetSheetName(0)
	if sheet == "" {
		return nil, fmt.Errorf("no sheets found")
	}

	rows, err := f.GetRows(sheet)
	if err != nil {
		return nil, fmt.Errorf("read rows: %w", err)
	}
	return s.buildPreview(rows, sheet)
}

func (s *UserTableService) buildPreview(rows [][]string, sheetName string) (*PreviewResult, error) {
	if len(rows) < 1 {
		return nil, fmt.Errorf("no header row")
	}
	headers := rows[0]
	if len(headers) == 0 {
		return nil, fmt.Errorf("empty header row")
	}

	maxScan := 1000
	dataRows := rows[1:]
	scanRows := dataRows
	if len(scanRows) > maxScan {
		scanRows = scanRows[:maxScan]
	}

	colValues := make([][]string, len(headers))
	for i := range headers {
		colValues[i] = make([]string, 0, len(scanRows))
	}
	for _, row := range scanRows {
		for i := range headers {
			val := ""
			if i < len(row) {
				val = strings.TrimSpace(row[i])
			}
			colValues[i] = append(colValues[i], val)
		}
	}

	columns := make([]ColumnInfo, len(headers))
	for i, h := range headers {
		colType := inferType(colValues[i])
		var samples []string
		for j := 0; j < len(colValues[i]) && j < 5; j++ {
			if colValues[i][j] != "" {
				samples = append(samples, colValues[i][j])
			}
		}
		columns[i] = ColumnInfo{
			Name:         sanitizeColumnName(h),
			InferredType: colType,
			Samples:      samples,
		}
	}

	previewLimit := 20
	if len(dataRows) < previewLimit {
		previewLimit = len(dataRows)
	}
	previewRows := make([][]string, previewLimit)
	for i := 0; i < previewLimit; i++ {
		row := make([]string, len(headers))
		for j := range headers {
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

func readCSVRows(filePath string) ([][]string, error) {
	f, err := os.Open(filePath)
	if err != nil {
		return nil, fmt.Errorf("open csv: %w", err)
	}
	defer f.Close()

	// Detect BOM for UTF-16/UTF-8 BOM
	buf := make([]byte, 3)
	n, _ := f.Read(buf)
	f.Seek(0, 0)

	var reader io.Reader = f
	if n >= 2 && buf[0] == 0xFF && buf[1] == 0xFE {
		reader = transform.NewReader(f, unicode.UTF16(unicode.LittleEndian, unicode.UseBOM).NewDecoder())
	} else if n >= 2 && buf[0] == 0xFE && buf[1] == 0xFF {
		reader = transform.NewReader(f, unicode.UTF16(unicode.BigEndian, unicode.UseBOM).NewDecoder())
	} else if n >= 3 && buf[0] == 0xEF && buf[1] == 0xBB && buf[2] == 0xBF {
		f.Seek(3, 0)
	}

	r := csv.NewReader(reader)
	r.LazyQuotes = true
	r.FieldsPerRecord = -1
	rows, err := r.ReadAll()
	if err != nil {
		return nil, fmt.Errorf("parse csv: %w", err)
	}
	return rows, nil
}

func readFileRows(filePath string) ([][]string, error) {
	ext := strings.ToLower(filepath.Ext(filePath))
	if ext == ".csv" {
		return readCSVRows(filePath)
	}
	f, err := excelize.OpenFile(filePath)
	if err != nil {
		return nil, fmt.Errorf("open excel: %w", err)
	}
	defer f.Close()
	sheet := f.GetSheetName(0)
	if sheet == "" {
		return nil, fmt.Errorf("no sheets found")
	}
	return f.GetRows(sheet)
}

func inferType(values []string) string {
	nonEmpty := 0
	isInt := true
	isDecimal := true
	isDate := true
	isDatetime := true
	maxLen := 0

	dateLayouts := []string{"2006-01-02", "2006/01/02", "20060102"}
	datetimeLayouts := []string{
		"2006-01-02 15:04:05",
		"2006/01/02 15:04:05",
		"2006-01-02T15:04:05",
	}

	for _, v := range values {
		if v == "" {
			continue
		}
		nonEmpty++
		if len(v) > maxLen {
			maxLen = len(v)
		}

		if isInt {
			if _, err := strconv.ParseInt(v, 10, 64); err != nil {
				isInt = false
			}
		}
		if isDecimal {
			if _, err := strconv.ParseFloat(v, 64); err != nil {
				isDecimal = false
			}
		}
		if isDate {
			matched := false
			for _, layout := range dateLayouts {
				if _, err := time.Parse(layout, v); err == nil {
					matched = true
					break
				}
			}
			if !matched {
				isDate = false
			}
		}
		if isDatetime {
			matched := false
			for _, layout := range datetimeLayouts {
				if _, err := time.Parse(layout, v); err == nil {
					matched = true
					break
				}
			}
			// Date is also valid datetime
			if !matched && isDate {
				// still ok
			} else if !matched {
				isDatetime = false
			}
		}
	}

	if nonEmpty == 0 {
		return "VARCHAR(255)"
	}
	if isInt {
		return "BIGINT"
	}
	if isDecimal {
		return "DECIMAL(18,6)"
	}
	if isDatetime && !isDate {
		return "DATETIME"
	}
	if isDate {
		return "DATE"
	}

	size := maxLen * 3 // UTF-8 expansion
	if size < 255 {
		size = 255
	}
	if size > 65535 {
		return "TEXT"
	}
	return fmt.Sprintf("VARCHAR(%d)", size)
}

func sanitizeColumnName(name string) string {
	name = strings.TrimSpace(name)
	name = strings.ToLower(name)
	name = strings.ReplaceAll(name, " ", "_")
	name = strings.ReplaceAll(name, "-", "_")
	// Remove non-alphanumeric/underscore/Chinese chars
	var b strings.Builder
	for _, r := range name {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_' || r >= 0x4e00 {
			b.WriteRune(r)
		}
	}
	result := b.String()
	if result == "" {
		result = "col"
	}
	return result
}

func (s *UserTableService) CreateTable(ctx context.Context, req *CreateTableRequest) error {
	if !validTableName.MatchString(req.TableName) {
		return fmt.Errorf("invalid table name: must match %s", validTableName.String())
	}
	if systemTables[req.TableName] {
		return fmt.Errorf("table name %q conflicts with system table", req.TableName)
	}
	if len(req.Columns) == 0 {
		return fmt.Errorf("no columns specified")
	}

	filePath, _, ok := s.GetTempFile(req.FileKey)
	if !ok {
		return fmt.Errorf("file not found or expired (key: %s)", req.FileKey)
	}
	defer s.removeTempFile(req.FileKey)

	var ddl strings.Builder
	fmt.Fprintf(&ddl, "CREATE TABLE %s (\n", escapeID(req.TableName))
	for i, col := range req.Columns {
		colType := col.Type
		if colType == "" {
			colType = col.InferredType
		}
		fmt.Fprintf(&ddl, "  %s %s", escapeID(col.Name), colType)
		if col.Comment != "" {
			fmt.Fprintf(&ddl, " COMMENT %s", escapeStr(col.Comment))
		}
		if i < len(req.Columns)-1 {
			ddl.WriteString(",")
		}
		ddl.WriteString("\n")
	}
	ddl.WriteString(")")
	if req.TableComment != "" {
		fmt.Fprintf(&ddl, " COMMENT=%s", escapeStr(req.TableComment))
	}

	if _, err := s.db.ExecContext(ctx, ddl.String()); err != nil {
		return fmt.Errorf("create table: %w", err)
	}

	rowCount, err := s.importData(ctx, req.TableName, req.Columns, filePath)
	if err != nil {
		_, _ = s.db.ExecContext(ctx, fmt.Sprintf("DROP TABLE IF EXISTS %s", escapeID(req.TableName)))
		return fmt.Errorf("import data: %w", err)
	}

	_, err = s.db.ExecContext(ctx,
		`INSERT INTO poc_user_tables (table_name, table_comment, row_count) VALUES (?, ?, ?)`,
		req.TableName, req.TableComment, rowCount,
	)
	if err != nil {
		_, _ = s.db.ExecContext(ctx, fmt.Sprintf("DROP TABLE IF EXISTS %s", escapeID(req.TableName)))
		return fmt.Errorf("register table: %w", err)
	}

	log.Printf("user_tables: created %s (%d rows)", req.TableName, rowCount)
	return nil
}

func (s *UserTableService) importData(ctx context.Context, tableName string, columns []ColumnInfo, filePath string) (int, error) {
	rows, err := readFileRows(filePath)
	if err != nil {
		return 0, err
	}
	if len(rows) < 2 {
		return 0, nil
	}

	dataRows := rows[1:]
	colNames := make([]string, len(columns))
	for i, c := range columns {
		colNames[i] = escapeID(c.Name)
	}

	batchSize := 500
	total := 0

	for start := 0; start < len(dataRows); start += batchSize {
		end := start + batchSize
		if end > len(dataRows) {
			end = len(dataRows)
		}
		batch := dataRows[start:end]

		placeholders := make([]string, len(batch))
		args := make([]any, 0, len(batch)*len(columns))

		singleRow := "(" + strings.Repeat("?,", len(columns)-1) + "?)"
		for i, row := range batch {
			placeholders[i] = singleRow
			for j := range columns {
				val := ""
				if j < len(row) {
					val = strings.TrimSpace(row[j])
				}
				if val == "" {
					args = append(args, nil)
				} else {
					args = append(args, val)
				}
			}
		}

		query := fmt.Sprintf("INSERT INTO %s (%s) VALUES %s",
			escapeID(tableName),
			strings.Join(colNames, ","),
			strings.Join(placeholders, ","),
		)

		if _, err := s.db.ExecContext(ctx, query, args...); err != nil {
			return total, fmt.Errorf("batch insert at row %d: %w", start+1, err)
		}
		total += len(batch)
	}

	return total, nil
}

func (s *UserTableService) ListUserTables(ctx context.Context) ([]UserTableMeta, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT table_name, table_comment, row_count, created_at
		 FROM poc_user_tables ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []UserTableMeta
	for rows.Next() {
		var m UserTableMeta
		if err := rows.Scan(&m.TableName, &m.TableComment, &m.RowCount, &m.CreatedAt); err != nil {
			return nil, err
		}
		m.Source = "user"
		result = append(result, m)
	}
	return result, rows.Err()
}

func (s *UserTableService) DeleteTable(ctx context.Context, name string) error {
	if !validTableName.MatchString(name) {
		return fmt.Errorf("invalid table name")
	}
	if systemTables[name] {
		return fmt.Errorf("cannot delete system table")
	}

	if _, err := s.db.ExecContext(ctx, fmt.Sprintf("DROP TABLE IF EXISTS %s", escapeID(name))); err != nil {
		return fmt.Errorf("drop table: %w", err)
	}
	if _, err := s.db.ExecContext(ctx, `DELETE FROM poc_user_tables WHERE table_name = ?`, name); err != nil {
		return fmt.Errorf("unregister: %w", err)
	}
	log.Printf("user_tables: deleted %s", name)
	return nil
}

func (s *UserTableService) UpdateMetadata(ctx context.Context, name string, req *UpdateMetadataRequest) error {
	if !validTableName.MatchString(name) {
		return fmt.Errorf("invalid table name")
	}

	if req.TableComment != "" {
		if _, err := s.db.ExecContext(ctx,
			`UPDATE poc_user_tables SET table_comment = ? WHERE table_name = ?`,
			req.TableComment, name); err != nil {
			return fmt.Errorf("update table comment: %w", err)
		}
		alterTable := fmt.Sprintf("ALTER TABLE %s COMMENT=%s", escapeID(name), escapeStr(req.TableComment))
		if _, err := s.db.ExecContext(ctx, alterTable); err != nil {
			log.Printf("user_tables: alter table comment failed: %v", err)
		}
	}

	for _, col := range req.Columns {
		if col.Comment == "" {
			continue
		}
		colType := col.Type
		if colType == "" {
			colType = s.getColumnType(ctx, name, col.Name)
		}
		alterCol := fmt.Sprintf("ALTER TABLE %s MODIFY COLUMN %s %s COMMENT %s",
			escapeID(name), escapeID(col.Name), colType, escapeStr(col.Comment))
		if _, err := s.db.ExecContext(ctx, alterCol); err != nil {
			return fmt.Errorf("update column comment %s: %w", col.Name, err)
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

func (s *UserTableService) PreviewData(ctx context.Context, name string) (*DataPreviewResult, error) {
	if !validTableName.MatchString(name) {
		return nil, fmt.Errorf("invalid table name")
	}

	var total int64
	if err := s.db.QueryRowContext(ctx, fmt.Sprintf("SELECT COUNT(*) FROM %s", escapeID(name))).Scan(&total); err != nil {
		return nil, fmt.Errorf("count: %w", err)
	}

	rows, err := s.db.QueryContext(ctx, fmt.Sprintf("SELECT * FROM %s LIMIT 100", escapeID(name)))
	if err != nil {
		return nil, fmt.Errorf("query: %w", err)
	}
	defer rows.Close()

	colNames, err := rows.Columns()
	if err != nil {
		return nil, fmt.Errorf("columns: %w", err)
	}

	var result [][]string
	for rows.Next() {
		vals := make([]sql.NullString, len(colNames))
		ptrs := make([]any, len(colNames))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return nil, fmt.Errorf("scan: %w", err)
		}
		row := make([]string, len(colNames))
		for i, v := range vals {
			if v.Valid {
				row[i] = v.String
			}
		}
		result = append(result, row)
	}

	return &DataPreviewResult{
		Columns: colNames,
		Rows:    result,
		Total:   total,
	}, rows.Err()
}

func (s *UserTableService) GetUserTableNames(ctx context.Context) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT table_name FROM poc_user_tables ORDER BY created_at`)
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

func (s *UserTableService) GetTableColumnsWithMeta(ctx context.Context, name string) ([]ColumnInfo, error) {
	if !validTableName.MatchString(name) {
		return nil, fmt.Errorf("invalid table name")
	}

	rows, err := s.db.QueryContext(ctx,
		`SELECT column_name, column_type, column_comment
		 FROM information_schema.columns
		 WHERE table_schema = ? AND table_name = ?
		 ORDER BY ordinal_position`, s.dbName, name)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var cols []ColumnInfo
	for rows.Next() {
		var c ColumnInfo
		var comment sql.NullString
		if err := rows.Scan(&c.Name, &c.Type, &comment); err != nil {
			return nil, err
		}
		c.Comment = comment.String
		cols = append(cols, c)
	}
	return cols, rows.Err()
}

func escapeID(name string) string {
	return "`" + strings.ReplaceAll(name, "`", "``") + "`"
}

func escapeStr(s string) string {
	s = strings.ReplaceAll(s, "'", "''")
	s = strings.ReplaceAll(s, "\\", "\\\\")
	return "'" + s + "'"
}
