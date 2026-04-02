package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
)

// PaginateHandler handles /api/query/paginate requests for server-side pagination.
type PaginateHandler struct {
	db *sql.DB
}

// NewPaginateHandler creates a PaginateHandler with the given database connection.
func NewPaginateHandler(db *sql.DB) *PaginateHandler {
	return &PaginateHandler{db: db}
}

type paginateRequest struct {
	SQL      string `json:"sql"`
	Page     int    `json:"page"`
	PageSize int    `json:"page_size"`
}

type paginateResponse struct {
	Columns  []string `json:"columns"`
	Rows     [][]any  `json:"rows"`
	Total    int      `json:"total"`
	Page     int      `json:"page"`
	PageSize int      `json:"page_size"`
}

// ServeHTTP handles the paginate request.
func (h *PaginateHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req paginateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
		return
	}

	if req.SQL == "" {
		http.Error(w, "sql is required", http.StatusBadRequest)
		return
	}

	// Basic read-only check: reject write operations
	if !isReadOnly(req.SQL) {
		http.Error(w, "only SELECT queries are allowed", http.StatusForbidden)
		return
	}

	// Defaults
	if req.Page < 1 {
		req.Page = 1
	}
	if req.PageSize < 1 {
		req.PageSize = 20
	}
	if req.PageSize > 500 {
		req.PageSize = 500
	}

	offset := (req.Page - 1) * req.PageSize

	// Execute paginated query
	paginatedSQL := fmt.Sprintf("SELECT * FROM (%s) _t LIMIT %d OFFSET %d", req.SQL, req.PageSize, offset)

	rows, err := h.db.Query(paginatedSQL)
	if err != nil {
		log.Printf("paginate query error: %v, sql: %s", err, paginatedSQL)
		http.Error(w, fmt.Sprintf("query error: %v", err), http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	// Read column names
	colTypes, err := rows.ColumnTypes()
	if err != nil {
		http.Error(w, fmt.Sprintf("column types error: %v", err), http.StatusInternalServerError)
		return
	}
	columns := make([]string, len(colTypes))
	for i, ct := range colTypes {
		columns[i] = ct.Name()
	}

	// Read rows
	var resultRows [][]any
	for rows.Next() {
		vals := make([]any, len(columns))
		ptrs := make([]any, len(columns))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			http.Error(w, fmt.Sprintf("scan error: %v", err), http.StatusInternalServerError)
			return
		}
		// Convert []byte to string for JSON serialization
		row := make([]any, len(vals))
		for i, v := range vals {
			if b, ok := v.([]byte); ok {
				row[i] = string(b)
			} else {
				row[i] = v
			}
		}
		resultRows = append(resultRows, row)
	}
	if err := rows.Err(); err != nil {
		http.Error(w, fmt.Sprintf("rows error: %v", err), http.StatusInternalServerError)
		return
	}

	// Get total count
	countSQL := fmt.Sprintf("SELECT COUNT(*) FROM (%s) _t", req.SQL)
	var total int
	if err := h.db.QueryRow(countSQL).Scan(&total); err != nil {
		log.Printf("paginate count error: %v, sql: %s", err, countSQL)
		// Non-fatal: return rows without accurate total
		total = offset + len(resultRows)
	}

	if resultRows == nil {
		resultRows = [][]any{}
	}

	resp := paginateResponse{
		Columns:  columns,
		Rows:     resultRows,
		Total:    total,
		Page:     req.Page,
		PageSize: req.PageSize,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

// isReadOnly does a basic check that the SQL is a SELECT statement and not a write operation.
func isReadOnly(s string) bool {
	upper := strings.ToUpper(strings.TrimSpace(s))
	forbidden := []string{"INSERT ", "UPDATE ", "DELETE ", "DROP ", "ALTER ", "TRUNCATE ", "CREATE ", "GRANT ", "REVOKE "}
	for _, kw := range forbidden {
		if strings.Contains(upper, kw) {
			return false
		}
	}
	return true
}
