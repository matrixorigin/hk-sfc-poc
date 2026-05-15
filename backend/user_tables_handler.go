package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

const maxUploadSize = 300 << 20 // 300 MB

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
	case rest != "" && !strings.Contains(rest, "/"):
		// /api/user-tables/{name}
		switch r.Method {
		case http.MethodDelete:
			h.delete(w, r, rest)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	case strings.HasSuffix(rest, "/metadata"):
		name := strings.TrimSuffix(rest, "/metadata")
		if r.Method == http.MethodPatch {
			h.updateMetadata(w, r, name)
		} else {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	case strings.HasSuffix(rest, "/preview"):
		name := strings.TrimSuffix(rest, "/preview")
		if r.Method == http.MethodGet {
			h.previewData(w, r, name)
		} else {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	case strings.HasSuffix(rest, "/columns"):
		name := strings.TrimSuffix(rest, "/columns")
		if r.Method == http.MethodGet {
			h.columns(w, r, name)
		} else {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	default:
		http.NotFound(w, r)
	}
}

func (h *UserTablesHandler) preview(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadSize)
	if err := r.ParseMultipartForm(maxUploadSize); err != nil {
		http.Error(w, "file too large (max 300MB)", http.StatusBadRequest)
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		http.Error(w, fmt.Sprintf("file required: %v", err), http.StatusBadRequest)
		return
	}
	defer file.Close()

	ext := strings.ToLower(filepath.Ext(header.Filename))
	if ext != ".xlsx" && ext != ".xls" && ext != ".csv" {
		http.Error(w, "only .xlsx and .csv files are supported", http.StatusBadRequest)
		return
	}

	tmpFile, err := os.CreateTemp("", "user-table-*"+ext)
	if err != nil {
		http.Error(w, fmt.Sprintf("create temp file: %v", err), http.StatusInternalServerError)
		return
	}
	defer tmpFile.Close()

	if _, err := io.Copy(tmpFile, file); err != nil {
		os.Remove(tmpFile.Name())
		http.Error(w, fmt.Sprintf("save file: %v", err), http.StatusInternalServerError)
		return
	}

	result, err := h.svc.PreviewFile(tmpFile.Name())
	if err != nil {
		os.Remove(tmpFile.Name())
		http.Error(w, fmt.Sprintf("preview: %v", err), http.StatusBadRequest)
		return
	}

	fileKey := generateFileKey()
	h.svc.SaveTempFile(fileKey, tmpFile.Name(), header.Filename)

	result.FileKey = fileKey
	writeJSON(w, http.StatusOK, result)
}

func (h *UserTablesHandler) create(w http.ResponseWriter, r *http.Request) {
	var req CreateTableRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	if req.TableName == "" || req.FileKey == "" || len(req.Columns) == 0 {
		http.Error(w, "table_name, file_key, and columns are required", http.StatusBadRequest)
		return
	}

	userID := UserIDFromContext(r.Context())
	if err := h.svc.CreateTable(r.Context(), &req, userID); err != nil {
		status := http.StatusInternalServerError
		msg := err.Error()
		if strings.Contains(msg, "invalid table name") || strings.Contains(msg, "conflicts with") || strings.Contains(msg, "not found or expired") {
			status = http.StatusBadRequest
		}
		http.Error(w, msg, status)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"table_name": req.TableName})
}

func (h *UserTablesHandler) list(w http.ResponseWriter, r *http.Request) {
	userID := UserIDFromContext(r.Context())
	tables, err := h.svc.ListUserTables(r.Context(), userID)
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
	userID := UserIDFromContext(r.Context())
	if err := h.svc.DeleteTable(r.Context(), name, userID); err != nil {
		status := http.StatusInternalServerError
		if strings.Contains(err.Error(), "invalid") || strings.Contains(err.Error(), "system table") {
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
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	userID := UserIDFromContext(r.Context())
	if err := h.svc.UpdateMetadata(r.Context(), name, userID, &req); err != nil {
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

func (h *UserTablesHandler) columns(w http.ResponseWriter, r *http.Request, name string) {
	cols, err := h.svc.GetTableColumnsWithMeta(r.Context(), name)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if cols == nil {
		cols = []ColumnInfo{}
	}
	writeJSON(w, http.StatusOK, cols)
}

func generateFileKey() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}
