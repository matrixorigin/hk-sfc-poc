# Knowledge Management UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a frontend UI to view, create, edit, and delete nl2sql knowledge entries, with backend Go proxy routes to the Catalog API.

**Architecture:** Backend adds REST proxy routes (`/api/knowledge/*`) that forward to Catalog's nl2sql-knowledge API. Frontend adds a `KnowledgePanel` component as a slide-over drawer accessible from the header. "Edit" is implemented as delete-then-create since Catalog has no update endpoint.

**Tech Stack:** Go (backend proxy), React + TypeScript (frontend), existing CSS patterns

**Key Finding:** Knowledge has NO cache in moi-core. Each Explore query fetches knowledge fresh from the database. Updates take effect immediately on the next query.

---

## File Structure

### Backend (Go)
- **Create:** `backend/knowledge.go` — Knowledge proxy handler: list, create, delete endpoints
- **Modify:** `backend/main.go` — Register new `/api/knowledge` routes

### Frontend (React + TypeScript)
- **Create:** `web/src/components/KnowledgePanel.tsx` — Slide-over drawer with knowledge list, create/edit form
- **Create:** `web/src/components/KnowledgePanel.css` — Styles for the knowledge panel
- **Modify:** `web/src/App.tsx` — Add knowledge panel toggle button in header, render KnowledgePanel
- **Modify:** `web/src/i18n/en.json` — English translations for knowledge UI
- **Modify:** `web/src/i18n/zh.json` — Chinese translations for knowledge UI

---

## Task 1: Backend — Knowledge Proxy Handler

**Files:**
- Create: `backend/knowledge.go`
- Modify: `backend/main.go`

### Knowledge Types Reference

From the Catalog API, each knowledge entry has:
```json
{
  "id": 123,
  "knowledge_base_id": 10001,
  "knowledge_type": "logic|glossary|case_library",
  "knowledge_key": "unique_key",
  "name": "display name",
  "knowledge_value": ["string1", "string2"],
  "associate_tables": ["table1", "table2"],
  "created_at": 1711500000,
  "updated_at": 1711500000
}
```

- [ ] **Step 1: Create `backend/knowledge.go`**

This file implements a `KnowledgeHandler` that proxies requests to the Catalog nl2sql-knowledge API.

```go
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
)

// KnowledgeHandler proxies knowledge CRUD to the Catalog API.
type KnowledgeHandler struct {
	catalogURL  string
	apiKey      string
	workspaceID string
	kbID        int64
	httpClient  *http.Client
}

func NewKnowledgeHandler(cfg *Config) *KnowledgeHandler {
	return &KnowledgeHandler{
		catalogURL:  cfg.Catalog.URL,
		apiKey:      cfg.Catalog.APIKey,
		workspaceID: cfg.Catalog.WorkspaceID,
		kbID:        cfg.Explore.KnowledgeBaseID,
		httpClient:  &http.Client{},
	}
}

func (h *KnowledgeHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	// Route: /api/knowledge or /api/knowledge/{id}
	path := strings.TrimPrefix(r.URL.Path, "/api/knowledge")
	path = strings.TrimPrefix(path, "/")

	switch {
	case r.Method == http.MethodGet && path == "":
		h.handleList(w, r)
	case r.Method == http.MethodPost && path == "":
		h.handleCreate(w, r)
	case r.Method == http.MethodDelete && path != "":
		h.handleDelete(w, r, path)
	default:
		http.Error(w, "not found", http.StatusNotFound)
	}
}

func (h *KnowledgeHandler) handleList(w http.ResponseWriter, r *http.Request) {
	body := map[string]any{
		"knowledge_base_ids": []int64{h.kbID},
		"page_size":          200,
	}
	bodyBytes, _ := json.Marshal(body)

	endpoint := fmt.Sprintf("%s/api/v1/workspaces/%s/nl2sql-knowledge/list", h.catalogURL, h.workspaceID)
	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, endpoint, bytes.NewReader(bodyBytes))
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-Key", h.apiKey)

	resp, err := h.httpClient.Do(req)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}

func (h *KnowledgeHandler) handleCreate(w http.ResponseWriter, r *http.Request) {
	// Read frontend request body, inject knowledge_base_id
	var incoming map[string]any
	if err := json.NewDecoder(r.Body).Decode(&incoming); err != nil {
		http.Error(w, fmt.Sprintf("invalid request: %v", err), http.StatusBadRequest)
		return
	}
	incoming["knowledge_base_id"] = h.kbID

	bodyBytes, _ := json.Marshal(incoming)

	endpoint := fmt.Sprintf("%s/api/v1/workspaces/%s/nl2sql-knowledge", h.catalogURL, h.workspaceID)
	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, endpoint, bytes.NewReader(bodyBytes))
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-Key", h.apiKey)

	resp, err := h.httpClient.Do(req)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}

func (h *KnowledgeHandler) handleDelete(w http.ResponseWriter, r *http.Request, knowledgeID string) {
	endpoint := fmt.Sprintf("%s/api/v1/workspaces/%s/nl2sql-knowledge/%s", h.catalogURL, h.workspaceID, knowledgeID)
	req, err := http.NewRequestWithContext(r.Context(), http.MethodDelete, endpoint, nil)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	req.Header.Set("X-API-Key", h.apiKey)

	resp, err := h.httpClient.Do(req)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}
```

- [ ] **Step 2: Register routes in `main.go`**

In `backend/main.go`, after the existing `mux.HandleFunc("/api/chat", ...)` line (line 27), add:

```go
	knowledgeHandler := NewKnowledgeHandler(cfg)
	mux.Handle("/api/knowledge/", knowledgeHandler)
	mux.Handle("/api/knowledge", knowledgeHandler)
```

Note: Two registrations needed because Go's `http.ServeMux` treats `/api/knowledge` and `/api/knowledge/` as different patterns.

- [ ] **Step 3: Build and verify**

```bash
cd backend && go build -o hk-poc-backend . && echo "BUILD OK"
```

Expected: `BUILD OK`

- [ ] **Step 4: Commit**

```bash
git add backend/knowledge.go backend/main.go
git commit -m "feat: add backend knowledge proxy routes (list/create/delete)"
```

---

## Task 2: Frontend — i18n Translations

**Files:**
- Modify: `web/src/i18n/en.json`
- Modify: `web/src/i18n/zh.json`

- [ ] **Step 1: Add English translations**

Add these keys to `web/src/i18n/en.json`:

```json
{
  "knowledge": "Knowledge Base",
  "knowledgeDesc": "Manage semantic knowledge for SQL generation",
  "knowledgeType": "Type",
  "knowledgeKey": "Key",
  "knowledgeName": "Name",
  "knowledgeValue": "Content",
  "knowledgeTables": "Associated Tables",
  "knowledgeAdd": "Add Knowledge",
  "knowledgeEdit": "Edit",
  "knowledgeDelete": "Delete",
  "knowledgeSave": "Save",
  "knowledgeCancel": "Cancel",
  "knowledgeEmpty": "No knowledge entries yet",
  "knowledgeConfirmDelete": "Confirm delete this entry?",
  "knowledgeTypeLogic": "Business Logic",
  "knowledgeTypeGlossary": "Glossary",
  "knowledgeTypeCaseLibrary": "Case Library"
}
```

- [ ] **Step 2: Add Chinese translations**

Add these keys to `web/src/i18n/zh.json`:

```json
{
  "knowledge": "知识库",
  "knowledgeDesc": "管理 SQL 生成的语义知识",
  "knowledgeType": "类型",
  "knowledgeKey": "标识",
  "knowledgeName": "名称",
  "knowledgeValue": "内容",
  "knowledgeTables": "关联表",
  "knowledgeAdd": "添加知识",
  "knowledgeEdit": "编辑",
  "knowledgeDelete": "删除",
  "knowledgeSave": "保存",
  "knowledgeCancel": "取消",
  "knowledgeEmpty": "暂无知识条目",
  "knowledgeConfirmDelete": "确认删除此条目？",
  "knowledgeTypeLogic": "业务逻辑",
  "knowledgeTypeGlossary": "术语表",
  "knowledgeTypeCaseLibrary": "案例库"
}
```

- [ ] **Step 3: Commit**

```bash
git add web/src/i18n/en.json web/src/i18n/zh.json
git commit -m "feat: add i18n translations for knowledge management UI"
```

---

## Task 3: Frontend — KnowledgePanel Component

**Files:**
- Create: `web/src/components/KnowledgePanel.tsx`
- Create: `web/src/components/KnowledgePanel.css`

- [ ] **Step 1: Create `KnowledgePanel.css`**

```css
/* Knowledge Panel - slide-over drawer from right */
.knowledge-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.3);
  z-index: 100;
  animation: fadeIn 0.15s ease;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.knowledge-panel {
  position: fixed;
  top: 0;
  right: 0;
  width: 640px;
  max-width: 90vw;
  height: 100vh;
  background: #fff;
  box-shadow: -4px 0 24px rgba(0,0,0,0.12);
  z-index: 101;
  display: flex;
  flex-direction: column;
  animation: slideIn 0.2s ease;
}

@keyframes slideIn {
  from { transform: translateX(100%); }
  to { transform: translateX(0); }
}

.knowledge-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid #e4e7ec;
  flex-shrink: 0;
}

.knowledge-panel-header h2 {
  font-size: 16px;
  font-weight: 600;
  color: #1a1a2e;
  margin: 0;
}

.knowledge-panel-header p {
  font-size: 12px;
  color: #94a3b8;
  margin: 2px 0 0;
}

.knowledge-close-btn {
  background: none;
  border: none;
  font-size: 20px;
  color: #94a3b8;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 6px;
  transition: all 0.15s;
}

.knowledge-close-btn:hover {
  background: #f1f5f9;
  color: #475569;
}

.knowledge-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 20px;
  border-bottom: 1px solid #f1f5f9;
  flex-shrink: 0;
}

.knowledge-type-tabs {
  display: flex;
  gap: 4px;
}

.knowledge-type-tab {
  padding: 6px 12px;
  border: 1px solid #e4e7ec;
  border-radius: 6px;
  background: #fff;
  cursor: pointer;
  font-size: 12px;
  color: #64748b;
  transition: all 0.15s;
}

.knowledge-type-tab:hover {
  background: #f8fafc;
}

.knowledge-type-tab.active {
  background: #eef2ff;
  border-color: #c7d2fe;
  color: #4f46e5;
  font-weight: 500;
}

.knowledge-add-btn {
  padding: 6px 14px;
  background: linear-gradient(135deg, #0f3460, #1a1a2e);
  color: #fff;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  transition: opacity 0.15s;
}

.knowledge-add-btn:hover {
  opacity: 0.9;
}

.knowledge-list {
  flex: 1;
  overflow-y: auto;
  padding: 12px 20px;
}

.knowledge-list::-webkit-scrollbar {
  width: 4px;
}

.knowledge-list::-webkit-scrollbar-thumb {
  background: #ddd;
  border-radius: 2px;
}

.knowledge-card {
  border: 1px solid #e4e7ec;
  border-radius: 10px;
  padding: 14px 16px;
  margin-bottom: 10px;
  transition: all 0.15s;
}

.knowledge-card:hover {
  border-color: #c7d2fe;
  box-shadow: 0 1px 4px rgba(0,0,0,0.04);
}

.knowledge-card-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}

.knowledge-card-title {
  font-size: 13px;
  font-weight: 600;
  color: #1e293b;
  word-break: break-word;
}

.knowledge-card-key {
  font-size: 11px;
  color: #94a3b8;
  margin-top: 2px;
  font-family: 'SF Mono', 'Fira Code', monospace;
}

.knowledge-card-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.knowledge-card-actions button {
  padding: 3px 8px;
  border: 1px solid #e4e7ec;
  border-radius: 4px;
  background: #fff;
  cursor: pointer;
  font-size: 11px;
  color: #64748b;
  transition: all 0.15s;
}

.knowledge-card-actions button:hover {
  background: #f8fafc;
  border-color: #cbd5e1;
}

.knowledge-card-actions button.delete:hover {
  color: #ef4444;
  background: #fef2f2;
  border-color: #fecaca;
}

.knowledge-card-body {
  margin-top: 8px;
}

.knowledge-card-value {
  font-size: 12px;
  color: #475569;
  line-height: 1.6;
  background: #f8fafc;
  padding: 8px 10px;
  border-radius: 6px;
  white-space: pre-wrap;
  word-break: break-word;
}

.knowledge-card-tables {
  margin-top: 6px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.knowledge-table-tag {
  padding: 2px 8px;
  background: #eef2ff;
  border-radius: 4px;
  font-size: 11px;
  color: #4f46e5;
  font-family: 'SF Mono', 'Fira Code', monospace;
}

.knowledge-type-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.knowledge-type-badge.logic {
  background: #dbeafe;
  color: #1d4ed8;
}

.knowledge-type-badge.glossary {
  background: #dcfce7;
  color: #15803d;
}

.knowledge-type-badge.case_library {
  background: #fef3c7;
  color: #b45309;
}

.knowledge-empty {
  text-align: center;
  padding: 40px 20px;
  color: #94a3b8;
  font-size: 13px;
}

/* Form */
.knowledge-form-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.4);
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
}

.knowledge-form {
  background: #fff;
  border-radius: 12px;
  width: 520px;
  max-width: 90vw;
  max-height: 80vh;
  overflow-y: auto;
  box-shadow: 0 12px 40px rgba(0,0,0,0.15);
  padding: 24px;
}

.knowledge-form h3 {
  font-size: 16px;
  font-weight: 600;
  color: #1a1a2e;
  margin: 0 0 16px;
}

.knowledge-form-group {
  margin-bottom: 14px;
}

.knowledge-form-group label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  color: #475569;
  margin-bottom: 4px;
}

.knowledge-form-group input,
.knowledge-form-group textarea,
.knowledge-form-group select {
  width: 100%;
  padding: 8px 12px;
  border: 1.5px solid #e4e7ec;
  border-radius: 8px;
  font-size: 13px;
  font-family: inherit;
  color: #1a1a2e;
  outline: none;
  transition: border-color 0.2s;
}

.knowledge-form-group input:focus,
.knowledge-form-group textarea:focus,
.knowledge-form-group select:focus {
  border-color: #0f3460;
  box-shadow: 0 0 0 3px rgba(15,52,96,0.08);
}

.knowledge-form-group textarea {
  resize: vertical;
  min-height: 80px;
  line-height: 1.5;
}

.knowledge-form-group .hint {
  font-size: 11px;
  color: #94a3b8;
  margin-top: 3px;
}

.knowledge-form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 20px;
}

.knowledge-form-actions button {
  padding: 8px 18px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
}

.knowledge-form-actions .btn-cancel {
  background: #fff;
  border: 1px solid #e4e7ec;
  color: #64748b;
}

.knowledge-form-actions .btn-cancel:hover {
  background: #f8fafc;
}

.knowledge-form-actions .btn-save {
  background: linear-gradient(135deg, #0f3460, #1a1a2e);
  border: none;
  color: #fff;
}

.knowledge-form-actions .btn-save:hover {
  opacity: 0.9;
}

.knowledge-form-actions .btn-save:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Loading state */
.knowledge-loading {
  text-align: center;
  padding: 40px;
  color: #94a3b8;
}

.knowledge-loading .phase-spinner {
  margin: 0 auto 12px;
}
```

- [ ] **Step 2: Create `KnowledgePanel.tsx`**

```tsx
import { useState, useEffect, useCallback } from 'react'
import { useT } from '../i18n'
import './KnowledgePanel.css'

interface KnowledgeEntry {
  id: number
  knowledge_base_id: number
  knowledge_type: string
  knowledge_key: string
  name: string
  knowledge_value: string[]
  associate_tables: string[]
  created_at: number
  updated_at: number
}

interface KnowledgePanelProps {
  open: boolean
  onClose: () => void
}

const TYPES = ['all', 'logic', 'glossary', 'case_library'] as const
type TypeFilter = (typeof TYPES)[number]

const TYPE_LABELS: Record<string, string> = {
  all: 'All',
  logic: 'knowledgeTypeLogic',
  glossary: 'knowledgeTypeGlossary',
  case_library: 'knowledgeTypeCaseLibrary',
}

interface FormData {
  knowledge_type: string
  knowledge_key: string
  name: string
  knowledge_value: string
  associate_tables: string
}

const emptyForm: FormData = {
  knowledge_type: 'logic',
  knowledge_key: '',
  name: '',
  knowledge_value: '',
  associate_tables: '',
}

export function KnowledgePanel({ open, onClose }: KnowledgePanelProps) {
  const { t } = useT()
  const [entries, setEntries] = useState<KnowledgeEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [form, setForm] = useState<FormData>(emptyForm)
  const [saving, setSaving] = useState(false)

  const fetchEntries = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/knowledge')
      const json = await res.json()
      setEntries(json.data?.items || [])
    } catch (err) {
      console.error('Failed to fetch knowledge:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) fetchEntries()
  }, [open, fetchEntries])

  const filtered = typeFilter === 'all'
    ? entries
    : entries.filter((e) => e.knowledge_type === typeFilter)

  const handleAdd = () => {
    setEditingId(null)
    setForm(emptyForm)
    setShowForm(true)
  }

  const handleEdit = (entry: KnowledgeEntry) => {
    setEditingId(entry.id)
    setForm({
      knowledge_type: entry.knowledge_type,
      knowledge_key: entry.knowledge_key,
      name: entry.name,
      knowledge_value: entry.knowledge_value.join('\n'),
      associate_tables: entry.associate_tables.join(', '),
    })
    setShowForm(true)
  }

  const handleDelete = async (id: number) => {
    if (!confirm(t('knowledgeConfirmDelete'))) return
    try {
      await fetch(`/api/knowledge/${id}`, { method: 'DELETE' })
      await fetchEntries()
    } catch (err) {
      console.error('Failed to delete:', err)
    }
  }

  const handleSave = async () => {
    if (!form.knowledge_key.trim() || !form.knowledge_value.trim()) return
    setSaving(true)
    try {
      // If editing, delete old entry first (Catalog has no update API)
      if (editingId !== null) {
        await fetch(`/api/knowledge/${editingId}`, { method: 'DELETE' })
      }
      // Create new entry
      const values = form.knowledge_value.split('\n').filter((v) => v.trim())
      const tables = form.associate_tables
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)

      await fetch('/api/knowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          knowledge_type: form.knowledge_type,
          knowledge_key: form.knowledge_key.trim(),
          name: form.name.trim(),
          knowledge_value: values,
          associate_tables: tables,
        }),
      })
      setShowForm(false)
      await fetchEntries()
    } catch (err) {
      console.error('Failed to save:', err)
    } finally {
      setSaving(false)
    }
  }

  if (!open) return null

  return (
    <>
      <div className="knowledge-overlay" onClick={onClose} />
      <div className="knowledge-panel">
        <div className="knowledge-panel-header">
          <div>
            <h2>{t('knowledge')}</h2>
            <p>{t('knowledgeDesc')}</p>
          </div>
          <button className="knowledge-close-btn" onClick={onClose}>
            x
          </button>
        </div>

        <div className="knowledge-toolbar">
          <div className="knowledge-type-tabs">
            {TYPES.map((type) => (
              <button
                key={type}
                className={`knowledge-type-tab ${typeFilter === type ? 'active' : ''}`}
                onClick={() => setTypeFilter(type)}
              >
                {type === 'all' ? 'All' : t(TYPE_LABELS[type] as any)}
              </button>
            ))}
          </div>
          <button className="knowledge-add-btn" onClick={handleAdd}>
            + {t('knowledgeAdd')}
          </button>
        </div>

        <div className="knowledge-list">
          {loading ? (
            <div className="knowledge-loading">
              <div className="phase-spinner" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="knowledge-empty">{t('knowledgeEmpty')}</div>
          ) : (
            filtered.map((entry) => (
              <div key={entry.id} className="knowledge-card">
                <div className="knowledge-card-header">
                  <div>
                    <span className={`knowledge-type-badge ${entry.knowledge_type}`}>
                      {t(TYPE_LABELS[entry.knowledge_type] as any) || entry.knowledge_type}
                    </span>
                    <div className="knowledge-card-title">{entry.name || entry.knowledge_key}</div>
                    <div className="knowledge-card-key">{entry.knowledge_key}</div>
                  </div>
                  <div className="knowledge-card-actions">
                    <button onClick={() => handleEdit(entry)}>{t('knowledgeEdit')}</button>
                    <button className="delete" onClick={() => handleDelete(entry.id)}>
                      {t('knowledgeDelete')}
                    </button>
                  </div>
                </div>
                <div className="knowledge-card-body">
                  <div className="knowledge-card-value">
                    {entry.knowledge_value.join('\n')}
                  </div>
                  {entry.associate_tables.length > 0 && (
                    <div className="knowledge-card-tables">
                      {entry.associate_tables.map((table) => (
                        <span key={table} className="knowledge-table-tag">
                          {table}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Create/Edit form modal */}
      {showForm && (
        <div className="knowledge-form-overlay" onClick={() => setShowForm(false)}>
          <div className="knowledge-form" onClick={(e) => e.stopPropagation()}>
            <h3>{editingId !== null ? t('knowledgeEdit') : t('knowledgeAdd')}</h3>

            <div className="knowledge-form-group">
              <label>{t('knowledgeType')}</label>
              <select
                value={form.knowledge_type}
                onChange={(e) => setForm({ ...form, knowledge_type: e.target.value })}
              >
                <option value="logic">{t('knowledgeTypeLogic')}</option>
                <option value="glossary">{t('knowledgeTypeGlossary')}</option>
                <option value="case_library">{t('knowledgeTypeCaseLibrary')}</option>
              </select>
            </div>

            <div className="knowledge-form-group">
              <label>{t('knowledgeKey')}</label>
              <input
                value={form.knowledge_key}
                onChange={(e) => setForm({ ...form, knowledge_key: e.target.value })}
                placeholder="e.g. data_coverage_hsi"
              />
            </div>

            <div className="knowledge-form-group">
              <label>{t('knowledgeName')}</label>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. HSI date range"
              />
            </div>

            <div className="knowledge-form-group">
              <label>{t('knowledgeValue')}</label>
              <textarea
                value={form.knowledge_value}
                onChange={(e) => setForm({ ...form, knowledge_value: e.target.value })}
                rows={5}
                placeholder="One value per line"
              />
              <div className="hint">Each line becomes a separate knowledge value entry</div>
            </div>

            <div className="knowledge-form-group">
              <label>{t('knowledgeTables')}</label>
              <input
                value={form.associate_tables}
                onChange={(e) => setForm({ ...form, associate_tables: e.target.value })}
                placeholder="e.g. ms_t_stk_hsi, ms_t_stk_sis"
              />
              <div className="hint">Comma-separated table names</div>
            </div>

            <div className="knowledge-form-actions">
              <button className="btn-cancel" onClick={() => setShowForm(false)}>
                {t('knowledgeCancel')}
              </button>
              <button
                className="btn-save"
                onClick={handleSave}
                disabled={saving || !form.knowledge_key.trim() || !form.knowledge_value.trim()}
              >
                {saving ? '...' : t('knowledgeSave')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
```

- [ ] **Step 3: Commit**

```bash
git add web/src/components/KnowledgePanel.tsx web/src/components/KnowledgePanel.css
git commit -m "feat: add KnowledgePanel component with list, create, edit, delete"
```

---

## Task 4: Frontend — Integrate KnowledgePanel into App

**Files:**
- Modify: `web/src/App.tsx`

- [ ] **Step 1: Add knowledge panel state and header button**

In `web/src/App.tsx`:

1. Add import at top:
```tsx
import { KnowledgePanel } from './components/KnowledgePanel'
```

2. Add state inside the `App` function:
```tsx
const [knowledgeOpen, setKnowledgeOpen] = useState(false)
```

3. In the header, between `</div>` (closing header-left) and `<LangSwitch />`, add the knowledge button:
```tsx
<div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
  <button
    className="lang-switch"
    onClick={() => setKnowledgeOpen(true)}
    title={t('knowledge')}
  >
    {t('knowledge')}
  </button>
  <LangSwitch />
</div>
```

4. Before the closing `</LangContext.Provider>`, add:
```tsx
<KnowledgePanel open={knowledgeOpen} onClose={() => setKnowledgeOpen(false)} />
```

- [ ] **Step 2: Build frontend to verify**

```bash
cd web && npm run build
```

Expected: Build succeeds with no errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/App.tsx
git commit -m "feat: integrate knowledge panel into app header"
```

---

## Task 5: End-to-End Verification

- [ ] **Step 1: Build backend**

```bash
cd backend && go build -o hk-poc-backend .
```

- [ ] **Step 2: Build frontend**

```bash
cd web && npm run build
```

- [ ] **Step 3: Manual verification checklist**

With Docker stack running (`docker compose up -d`):

1. Open http://localhost:3000
2. Click "Knowledge Base" button in header — drawer opens
3. Verify knowledge list loads (should show ~19 entries from the script)
4. Click type tabs — filters work
5. Click "Add Knowledge" — form modal opens
6. Fill form and save — new entry appears in list
7. Click "Edit" on an entry — form pre-filled, save works (delete + recreate)
8. Click "Delete" on an entry — confirm dialog, entry removed
9. Ask a question in chat — verify it still uses knowledge correctly
10. Add a new knowledge entry, then ask a question referencing it — verify the new knowledge is picked up immediately (no cache issue)
