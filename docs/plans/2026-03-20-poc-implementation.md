# HK SFC POC 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个可演示的 AI 数据探索 POC，用户通过对话界面查询香港股市数据，后端透传 moi-core Explore SSE 流。

**Architecture:** Go 薄后端接收前端请求，拼装 ExploreRequest 后转发给 Catalog API，SSE 事件流原样透传给 React 前端。前端解析事件流，渲染文字（打字机效果）、表格和图表。

**Tech Stack:** Go 1.24 (后端), React + Vite + TypeScript (前端), ECharts (图表), gopkg.in/yaml.v3 (配置)

**Spec:** `docs/specs/2026-03-20-poc-architecture-design.md`

---

## 文件结构

### 后端 (`backend/`)

| 文件 | 职责 |
|------|------|
| `backend/main.go` | 入口：加载配置、注册路由、启动 HTTP 服务 (8083) |
| `backend/config.go` | 定义 Config 结构体，从 config.yaml 加载 |
| `backend/config.yaml` | 配置文件（catalog_url, api_key, workspace_id, tables 等） |
| `backend/handler.go` | HTTP handler：接收请求、拼装 ExploreRequest、预处理/后处理钩子 |
| `backend/explore.go` | 封装 Catalog API 调用：POST SSE 请求、逐行读取并转发 |

### 前端 (`web/`)

| 文件 | 职责 |
|------|------|
| `web/package.json` | 依赖声明 |
| `web/vite.config.ts` | Vite 配置（dev proxy 到 8083） |
| `web/index.html` | HTML 入口 |
| `web/src/main.tsx` | React 挂载点 |
| `web/src/App.tsx` | 根组件：布局 + 语言上下文 |
| `web/src/types.ts` | ExploreEvent、Message 等类型定义 |
| `web/src/hooks/useExploreSSE.ts` | SSE hook：发请求、解析事件流、更新消息状态 |
| `web/src/components/ChatPanel.tsx` | 对话面板：消息列表 + 输入框 |
| `web/src/components/MessageBubble.tsx` | 单条消息渲染（文字 + 表格 + 图表 + SQL 折叠） |
| `web/src/components/DataTable.tsx` | 表格组件 |
| `web/src/components/Chart.tsx` | ECharts 折线图组件 |
| `web/src/components/LangSwitch.tsx` | 语言切换按钮 |
| `web/src/i18n/en.json` | 英文 UI 文案 |
| `web/src/i18n/zh.json` | 中文 UI 文案 |

---

## Task 1: Go 后端 — 配置加载

**Files:**
- Create: `backend/config.go`
- Create: `backend/config.yaml`

- [ ] **Step 1: 创建 config.yaml**

```yaml
server:
  port: 8083

catalog:
  url: "http://localhost:8082"
  api_key: "${MOI_SYSTEM_API_KEY}"
  workspace_id: "${POC_WORKSPACE_ID}"

explore:
  db_name: "hk_sfc"
  tables:
    - ms_t_stk_hsi
    - ms_t_stk_sis
    - ms_v_stock_capital
    - ds_t_int_hsicl_dtl
    - sehknews
    - profit_loss
    - ccass_holdings
  planning_mode: "auto"
  verbose: "steps"
```

- [ ] **Step 2: 实现 config.go**

```go
// config.go
package main

import (
    "os"
    "strings"
    "gopkg.in/yaml.v3"
)

type Config struct {
    Server  ServerConfig  `yaml:"server"`
    Catalog CatalogConfig `yaml:"catalog"`
    Explore ExploreConfig `yaml:"explore"`
}

type ServerConfig struct {
    Port int `yaml:"port"`
}

type CatalogConfig struct {
    URL         string `yaml:"url"`
    APIKey      string `yaml:"api_key"`
    WorkspaceID string `yaml:"workspace_id"`
}

type ExploreConfig struct {
    DBName       string   `yaml:"db_name"`
    Tables       []string `yaml:"tables"`
    PlanningMode string   `yaml:"planning_mode"`
    Verbose      string   `yaml:"verbose"`
}

func LoadConfig(path string) (*Config, error) {
    data, err := os.ReadFile(path)
    if err != nil {
        return nil, err
    }
    // 展开环境变量
    expanded := os.ExpandEnv(string(data))
    var cfg Config
    if err := yaml.Unmarshal([]byte(expanded), &cfg); err != nil {
        return nil, err
    }
    return &cfg, nil
}
```

- [ ] **Step 3: 安装依赖**

Run: `cd backend && go get gopkg.in/yaml.v3`

- [ ] **Step 4: 验证编译**

Run: `cd backend && go build ./...`
Expected: 编译错误（main.go 尚未创建），但 config.go 本身无语法错误

- [ ] **Step 5: Commit**

```
git add backend/config.go backend/config.yaml
git commit -m "feat(backend): add config loading with yaml + env var expansion"
```

---

## Task 2: Go 后端 — Explore API 调用 + SSE 转发

**Files:**
- Create: `backend/explore.go`

- [ ] **Step 1: 实现 explore.go**

```go
// explore.go
package main

import (
    "bytes"
    "context"
    "encoding/json"
    "fmt"
    "io"
    "net/http"
)

// ExploreRequest 是发给 Catalog 的请求体
type ExploreRequest struct {
    Query       QueryDomain      `json:"query"`
    Session     SessionDomain    `json:"session"`
    DataSources DataSourceDomain `json:"data_sources"`
    Options     ExploreOptions   `json:"options"`
    Trace       TraceOptions     `json:"trace"`
}

type QueryDomain struct {
    Question string `json:"question"`
}

type SessionDomain struct {
    SessionID   string `json:"session_id"`
    WorkspaceID string `json:"workspace_id"`
}

type DataSourceDomain struct {
    Tables *TableSource `json:"tables,omitempty"`
}

type TableSource struct {
    DBName    string   `json:"db_name"`
    TableList []string `json:"table_list"`
}

type ExploreOptions struct {
    PlanningMode string `json:"planning_mode,omitempty"`
    Verbose      string `json:"verbose,omitempty"`
}

type TraceOptions struct {
    Enabled bool `json:"enabled"`
}

// ExploreClient 封装对 Catalog Explore API 的调用
type ExploreClient struct {
    catalogURL string
    apiKey     string
    httpClient *http.Client
}

func NewExploreClient(catalogURL, apiKey string) *ExploreClient {
    return &ExploreClient{
        catalogURL: catalogURL,
        apiKey:     apiKey,
        httpClient: &http.Client{},
    }
}

// QueryStream 发送 Explore 请求，返回 SSE 流的 io.ReadCloser
func (c *ExploreClient) QueryStream(ctx context.Context, req *ExploreRequest) (io.ReadCloser, error) {
    body, err := json.Marshal(req)
    if err != nil {
        return nil, fmt.Errorf("marshal request: %w", err)
    }

    httpReq, err := http.NewRequestWithContext(ctx, "POST",
        c.catalogURL+"/api/v1/explore/query/stream",
        bytes.NewReader(body))
    if err != nil {
        return nil, fmt.Errorf("create request: %w", err)
    }

    httpReq.Header.Set("Content-Type", "application/json")
    httpReq.Header.Set("X-API-Key", c.apiKey)
    httpReq.Header.Set("Accept", "text/event-stream")

    resp, err := c.httpClient.Do(httpReq)
    if err != nil {
        return nil, fmt.Errorf("http request: %w", err)
    }

    if resp.StatusCode != http.StatusOK {
        defer resp.Body.Close()
        errBody, _ := io.ReadAll(resp.Body)
        return nil, fmt.Errorf("explore API error %d: %s", resp.StatusCode, string(errBody))
    }

    return resp.Body, nil
}
```

- [ ] **Step 2: 验证编译**

Run: `cd backend && go build ./...`

- [ ] **Step 3: Commit**

```
git add backend/explore.go
git commit -m "feat(backend): add ExploreClient with SSE stream support"
```

---

## Task 3: Go 后端 — HTTP Handler + 主入口

**Files:**
- Create: `backend/handler.go`
- Create: `backend/main.go`

- [ ] **Step 1: 实现 handler.go**

```go
// handler.go
package main

import (
    "bufio"
    "encoding/json"
    "log"
    "net/http"
    "strings"
)

type ChatRequest struct {
    Question  string `json:"question"`
    SessionID string `json:"session_id"`
}

type ChatHandler struct {
    client *ExploreClient
    cfg    *Config
}

func NewChatHandler(client *ExploreClient, cfg *Config) *ChatHandler {
    return &ChatHandler{client: client, cfg: cfg}
}

// preProcess 预处理钩子（当前透传，未来可增强）
func (h *ChatHandler) preProcess(question string) string {
    return question
}

// postProcess 后处理钩子（当前透传，未来可加工）
func (h *ChatHandler) postProcess(line string) string {
    return line
}

func (h *ChatHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    if r.Method != http.MethodPost {
        http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
        return
    }

    var req ChatRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        http.Error(w, "invalid request body", http.StatusBadRequest)
        return
    }

    if req.Question == "" {
        http.Error(w, "question is required", http.StatusBadRequest)
        return
    }

    if req.SessionID == "" {
        req.SessionID = "default"
    }

    question := h.preProcess(req.Question)

    exploreReq := &ExploreRequest{
        Query: QueryDomain{Question: question},
        Session: SessionDomain{
            SessionID:   req.SessionID,
            WorkspaceID: h.cfg.Catalog.WorkspaceID,
        },
        DataSources: DataSourceDomain{
            Tables: &TableSource{
                DBName:    h.cfg.Explore.DBName,
                TableList: h.cfg.Explore.Tables,
            },
        },
        Options: ExploreOptions{
            PlanningMode: h.cfg.Explore.PlanningMode,
            Verbose:      h.cfg.Explore.Verbose,
        },
        Trace: TraceOptions{Enabled: true},
    }

    sseStream, err := h.client.QueryStream(r.Context(), exploreReq)
    if err != nil {
        log.Printf("explore error: %v", err)
        http.Error(w, "explore query failed: "+err.Error(), http.StatusBadGateway)
        return
    }
    defer sseStream.Close()

    // 设置 SSE 响应头
    w.Header().Set("Content-Type", "text/event-stream")
    w.Header().Set("Cache-Control", "no-cache")
    w.Header().Set("Connection", "keep-alive")
    w.Header().Set("Access-Control-Allow-Origin", "*")

    flusher, ok := w.(http.Flusher)
    if !ok {
        http.Error(w, "streaming not supported", http.StatusInternalServerError)
        return
    }

    // 逐行读取 Explore SSE 流并转发
    scanner := bufio.NewScanner(sseStream)
    scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
    for scanner.Scan() {
        line := h.postProcess(scanner.Text())
        w.Write([]byte(line + "\n"))
        flusher.Flush()

        // 检测客户端断开
        if r.Context().Err() != nil {
            break
        }
    }
}
```

- [ ] **Step 2: 实现 main.go**

```go
// main.go
package main

import (
    "fmt"
    "log"
    "net/http"
    "os"
)

func main() {
    cfgPath := "config.yaml"
    if len(os.Args) > 1 {
        cfgPath = os.Args[1]
    }

    cfg, err := LoadConfig(cfgPath)
    if err != nil {
        log.Fatalf("load config: %v", err)
    }

    client := NewExploreClient(cfg.Catalog.URL, cfg.Catalog.APIKey)
    handler := NewChatHandler(client, cfg)

    mux := http.NewServeMux()
    mux.Handle("/api/chat", handler)

    // CORS preflight
    mux.HandleFunc("/api/chat", func(w http.ResponseWriter, r *http.Request) {
        if r.Method == http.MethodOptions {
            w.Header().Set("Access-Control-Allow-Origin", "*")
            w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
            w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
            w.WriteHeader(http.StatusNoContent)
            return
        }
        handler.ServeHTTP(w, r)
    })

    addr := fmt.Sprintf(":%d", cfg.Server.Port)
    log.Printf("HK SFC POC backend starting on %s", addr)
    log.Printf("Catalog: %s, Workspace: %s", cfg.Catalog.URL, cfg.Catalog.WorkspaceID)
    if err := http.ListenAndServe(addr, mux); err != nil {
        log.Fatalf("server error: %v", err)
    }
}
```

- [ ] **Step 3: 验证编译和启动**

Run: `cd backend && go build -o poc-server . && echo "build ok"`
Expected: build ok

- [ ] **Step 4: Commit**

```
git add backend/handler.go backend/main.go
git commit -m "feat(backend): add chat handler with SSE passthrough and main entry"
```

---

## Task 4: 前端 — 项目初始化 + 类型定义

**Files:**
- Create: `web/` (via vite scaffold)
- Create: `web/src/types.ts`
- Modify: `web/vite.config.ts` (proxy)

- [ ] **Step 1: 创建 Vite React 项目**

Run:
```bash
cd /Users/zhangqq/Documents/pythonProject/HK_POC
npm create vite@latest web -- --template react-ts
cd web && npm install
```

- [ ] **Step 2: 安装依赖**

Run:
```bash
cd web
npm install echarts echarts-for-react
```

- [ ] **Step 3: 配置 vite dev proxy**

覆盖 `web/vite.config.ts`:

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:8083',
        changeOrigin: true,
      },
    },
  },
})
```

- [ ] **Step 4: 创建 types.ts**

```ts
// src/types.ts

export interface ExploreEvent {
  schema_version: string
  run_id: string
  event: string       // 事件类型: run.started, synthesis.delta, sql.result, etc.
  ts_ms: number
  seq: number
  trace_id?: string
  data: any
}

export interface SQLResult {
  columns: string[]
  rows: any[][]
  sql?: string
  total_count?: number
}

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string              // AI 文字内容（流式追加）
  sqlResults: SQLResult[]      // SQL 查询结果
  sqlStatements: string[]      // 生成的 SQL 语句
  isStreaming: boolean
  error?: string
}

export type Language = 'en' | 'zh'
```

- [ ] **Step 5: Commit**

```
git add web/
git commit -m "feat(web): init vite react-ts project with types and proxy config"
```

---

## Task 5: 前端 — SSE Hook

**Files:**
- Create: `web/src/hooks/useExploreSSE.ts`

- [ ] **Step 1: 实现 SSE hook**

```ts
// src/hooks/useExploreSSE.ts
import { useCallback, useRef } from 'react'
import type { ExploreEvent, Message, SQLResult } from '../types'

interface UseChatOptions {
  onUpdate: (msg: Message) => void
  onDone: (msg: Message) => void
  onError: (error: string) => void
}

export function useExploreSSE({ onUpdate, onDone, onError }: UseChatOptions) {
  const abortRef = useRef<AbortController | null>(null)

  const send = useCallback(async (question: string, sessionId: string) => {
    // 取消上一个请求
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    const msg: Message = {
      id: `msg_${Date.now()}`,
      role: 'assistant',
      content: '',
      sqlResults: [],
      sqlStatements: [],
      isStreaming: true,
    }

    try {
      const resp = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, session_id: sessionId }),
        signal: controller.signal,
      })

      if (!resp.ok) {
        const text = await resp.text()
        onError(text || `HTTP ${resp.status}`)
        return
      }

      const reader = resp.body?.getReader()
      if (!reader) {
        onError('No response body')
        return
      }

      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data:')) continue
          const jsonStr = line.slice(5).trim()
          if (!jsonStr) continue

          try {
            const event: ExploreEvent = JSON.parse(jsonStr)

            switch (event.event) {
              case 'synthesis.delta':
                msg.content += event.data?.delta || ''
                onUpdate({ ...msg })
                break

              case 'synthesis.done':
                msg.isStreaming = false
                break

              case 'sql.result':
                if (event.data) {
                  const sqlResult: SQLResult = {
                    columns: event.data.columns || [],
                    rows: event.data.rows || [],
                    sql: event.data.sql,
                    total_count: event.data.total_count,
                  }
                  msg.sqlResults = [...msg.sqlResults, sqlResult]
                  onUpdate({ ...msg })
                }
                break

              case 'sql.generated':
                if (event.data?.sql) {
                  msg.sqlStatements = [...msg.sqlStatements, event.data.sql]
                }
                break

              case 'run.error':
                msg.error = event.data?.message || 'Unknown error'
                msg.isStreaming = false
                onError(msg.error)
                break

              case 'run.completed':
                msg.isStreaming = false
                break
            }
          } catch {
            // 忽略解析失败的行
          }
        }
      }

      msg.isStreaming = false
      onDone(msg)
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        onError(err.message || 'Connection failed')
      }
    }
  }, [onUpdate, onDone, onError])

  const cancel = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  return { send, cancel }
}
```

- [ ] **Step 2: Commit**

```
git add web/src/hooks/useExploreSSE.ts
git commit -m "feat(web): add SSE hook for streaming explore events"
```

---

## Task 6: 前端 — i18n 双语

**Files:**
- Create: `web/src/i18n/en.json`
- Create: `web/src/i18n/zh.json`
- Create: `web/src/i18n/index.ts`

- [ ] **Step 1: 创建语言文件和 hook**

`web/src/i18n/en.json`:
```json
{
  "title": "HK Market Data Explorer",
  "placeholder": "Ask a question about Hong Kong market data...",
  "send": "Send",
  "thinking": "Analyzing...",
  "showSQL": "Show SQL",
  "hideSQL": "Hide SQL",
  "noData": "No data returned",
  "error": "An error occurred",
  "newChat": "New Chat"
}
```

`web/src/i18n/zh.json`:
```json
{
  "title": "香港市场数据探索",
  "placeholder": "输入关于香港市场数据的问题...",
  "send": "发送",
  "thinking": "分析中...",
  "showSQL": "显示 SQL",
  "hideSQL": "隐藏 SQL",
  "noData": "无数据返回",
  "error": "发生错误",
  "newChat": "新对话"
}
```

`web/src/i18n/index.ts`:
```ts
import en from './en.json'
import zh from './zh.json'
import { createContext, useContext } from 'react'
import type { Language } from '../types'

const messages: Record<Language, Record<string, string>> = { en, zh }

export const LangContext = createContext<{
  lang: Language
  setLang: (l: Language) => void
  t: (key: string) => string
}>({
  lang: 'en',
  setLang: () => {},
  t: (key) => key,
})

export function useT() {
  return useContext(LangContext)
}

export function getT(lang: Language) {
  return (key: string) => messages[lang]?.[key] ?? key
}
```

- [ ] **Step 2: Commit**

```
git add web/src/i18n/
git commit -m "feat(web): add i18n with en/zh support"
```

---

## Task 7: 前端 — UI 组件

**Files:**
- Create: `web/src/components/LangSwitch.tsx`
- Create: `web/src/components/DataTable.tsx`
- Create: `web/src/components/Chart.tsx`
- Create: `web/src/components/MessageBubble.tsx`
- Create: `web/src/components/ChatPanel.tsx`

- [ ] **Step 1: LangSwitch 组件**

```tsx
// src/components/LangSwitch.tsx
import { useT } from '../i18n'

export function LangSwitch() {
  const { lang, setLang } = useT()
  return (
    <button
      onClick={() => setLang(lang === 'en' ? 'zh' : 'en')}
      style={{ padding: '4px 12px', cursor: 'pointer' }}
    >
      {lang === 'en' ? '中文' : 'EN'}
    </button>
  )
}
```

- [ ] **Step 2: DataTable 组件**

```tsx
// src/components/DataTable.tsx
import type { SQLResult } from '../types'

export function DataTable({ data }: { data: SQLResult }) {
  if (!data.columns.length) return null
  return (
    <div style={{ overflowX: 'auto', margin: '8px 0' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '13px' }}>
        <thead>
          <tr>
            {data.columns.map((col, i) => (
              <th key={i} style={{ border: '1px solid #ddd', padding: '6px 10px', background: '#f5f5f5', textAlign: 'left' }}>
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.slice(0, 100).map((row, ri) => (
            <tr key={ri}>
              {row.map((cell, ci) => (
                <td key={ci} style={{ border: '1px solid #ddd', padding: '4px 10px' }}>
                  {cell ?? ''}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {data.rows.length > 100 && (
        <div style={{ color: '#888', fontSize: '12px', marginTop: 4 }}>
          Showing 100 of {data.rows.length} rows
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Chart 组件**

```tsx
// src/components/Chart.tsx
import ReactECharts from 'echarts-for-react'
import type { SQLResult } from '../types'

// 简单判断：第一列像日期、后续列是数值 → 展示折线图
function isChartable(data: SQLResult): boolean {
  if (data.columns.length < 2 || data.rows.length < 2) return false
  // 检查第二列是否为数值
  return data.rows.some(row => typeof row[1] === 'number' || !isNaN(Number(row[1])))
}

export function Chart({ data }: { data: SQLResult }) {
  if (!isChartable(data)) return null

  const xData = data.rows.map(row => String(row[0]))
  const series = data.columns.slice(1).map((col, idx) => ({
    name: col,
    type: 'line' as const,
    data: data.rows.map(row => Number(row[idx + 1]) || 0),
    smooth: true,
  }))

  const option = {
    tooltip: { trigger: 'axis' as const },
    legend: { data: data.columns.slice(1) },
    xAxis: { type: 'category' as const, data: xData },
    yAxis: { type: 'value' as const },
    series,
    grid: { left: '3%', right: '4%', bottom: '3%', containLabel: true },
  }

  return (
    <div style={{ margin: '8px 0' }}>
      <ReactECharts option={option} style={{ height: 300 }} />
    </div>
  )
}
```

- [ ] **Step 4: MessageBubble 组件**

```tsx
// src/components/MessageBubble.tsx
import { useState } from 'react'
import type { Message } from '../types'
import { useT } from '../i18n'
import { DataTable } from './DataTable'
import { Chart } from './Chart'

export function MessageBubble({ message }: { message: Message }) {
  const { t } = useT()
  const [showSQL, setShowSQL] = useState(false)
  const isUser = message.role === 'user'

  return (
    <div style={{
      display: 'flex',
      justifyContent: isUser ? 'flex-end' : 'flex-start',
      margin: '8px 0',
    }}>
      <div style={{
        maxWidth: '80%',
        padding: '10px 14px',
        borderRadius: 12,
        background: isUser ? '#1677ff' : '#f0f0f0',
        color: isUser ? '#fff' : '#000',
      }}>
        {/* 文字内容 */}
        {message.content && (
          <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
            {message.content}
            {message.isStreaming && <span className="cursor">▊</span>}
          </div>
        )}

        {/* 错误 */}
        {message.error && (
          <div style={{ color: '#ff4d4f', marginTop: 8 }}>{message.error}</div>
        )}

        {/* SQL 结果表格 + 图表 */}
        {message.sqlResults.map((result, i) => (
          <div key={i}>
            <DataTable data={result} />
            <Chart data={result} />
          </div>
        ))}

        {/* SQL 折叠 */}
        {message.sqlStatements.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <button onClick={() => setShowSQL(!showSQL)}
              style={{ fontSize: 12, color: '#666', cursor: 'pointer', background: 'none', border: 'none' }}>
              {showSQL ? t('hideSQL') : t('showSQL')}
            </button>
            {showSQL && (
              <pre style={{ background: '#1e1e1e', color: '#d4d4d4', padding: 8, borderRadius: 6, fontSize: 12, overflow: 'auto' }}>
                {message.sqlStatements.join('\n\n')}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 5: ChatPanel 组件**

```tsx
// src/components/ChatPanel.tsx
import { useState, useRef, useEffect, useCallback } from 'react'
import type { Message } from '../types'
import { useT } from '../i18n'
import { useExploreSSE } from '../hooks/useExploreSSE'
import { MessageBubble } from './MessageBubble'

export function ChatPanel() {
  const { t } = useT()
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [sessionId] = useState(() => `sess_${Date.now()}`)
  const listRef = useRef<HTMLDivElement>(null)

  // 自动滚到底部
  useEffect(() => {
    listRef.current?.scrollTo(0, listRef.current.scrollHeight)
  }, [messages])

  const updateLastMsg = useCallback((msg: Message) => {
    setMessages(prev => {
      const copy = [...prev]
      copy[copy.length - 1] = msg
      return copy
    })
  }, [])

  const { send, cancel } = useExploreSSE({
    onUpdate: updateLastMsg,
    onDone: (msg) => {
      updateLastMsg(msg)
      setLoading(false)
    },
    onError: (err) => {
      setMessages(prev => {
        const copy = [...prev]
        if (copy.length > 0) {
          const last = copy[copy.length - 1]
          copy[copy.length - 1] = { ...last, error: err, isStreaming: false }
        }
        return copy
      })
      setLoading(false)
    },
  })

  const handleSend = () => {
    const q = input.trim()
    if (!q || loading) return

    const userMsg: Message = {
      id: `user_${Date.now()}`,
      role: 'user',
      content: q,
      sqlResults: [],
      sqlStatements: [],
      isStreaming: false,
    }
    const aiMsg: Message = {
      id: `ai_${Date.now()}`,
      role: 'assistant',
      content: '',
      sqlResults: [],
      sqlStatements: [],
      isStreaming: true,
    }
    setMessages(prev => [...prev, userMsg, aiMsg])
    setInput('')
    setLoading(true)
    send(q, sessionId)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* 消息列表 */}
      <div ref={listRef} style={{ flex: 1, overflow: 'auto', padding: '16px' }}>
        {messages.map(msg => (
          <MessageBubble key={msg.id} message={msg} />
        ))}
        {loading && messages.length > 0 && messages[messages.length - 1].content === '' && (
          <div style={{ color: '#888', padding: '8px 16px' }}>{t('thinking')}</div>
        )}
      </div>

      {/* 输入框 */}
      <div style={{ display: 'flex', padding: '12px 16px', borderTop: '1px solid #e8e8e8' }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleSend()}
          placeholder={t('placeholder')}
          disabled={loading}
          style={{ flex: 1, padding: '8px 12px', borderRadius: 8, border: '1px solid #d9d9d9', fontSize: 14 }}
        />
        <button
          onClick={handleSend}
          disabled={loading || !input.trim()}
          style={{ marginLeft: 8, padding: '8px 20px', borderRadius: 8, background: '#1677ff', color: '#fff', border: 'none', cursor: 'pointer' }}
        >
          {t('send')}
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 6: Commit**

```
git add web/src/components/
git commit -m "feat(web): add all UI components - ChatPanel, MessageBubble, DataTable, Chart, LangSwitch"
```

---

## Task 8: 前端 — App 根组件 + 入口

**Files:**
- Modify: `web/src/App.tsx`
- Modify: `web/src/main.tsx`
- Create: `web/src/App.css`

- [ ] **Step 1: 实现 App.tsx**

```tsx
// src/App.tsx
import { useState } from 'react'
import { LangContext, getT } from './i18n'
import { ChatPanel } from './components/ChatPanel'
import { LangSwitch } from './components/LangSwitch'
import type { Language } from './types'
import './App.css'

function App() {
  const [lang, setLang] = useState<Language>('en')
  const t = getT(lang)

  return (
    <LangContext.Provider value={{ lang, setLang, t }}>
      <div className="app">
        <header className="header">
          <h1>{t('title')}</h1>
          <LangSwitch />
        </header>
        <main className="main">
          <ChatPanel />
        </main>
      </div>
    </LangContext.Provider>
  )
}

export default App
```

- [ ] **Step 2: 创建 App.css**

```css
/* src/App.css */
* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 24px;
  border-bottom: 1px solid #e8e8e8;
  background: #fff;
}

.header h1 {
  font-size: 18px;
  font-weight: 600;
}

.main {
  flex: 1;
  overflow: hidden;
}

.cursor {
  animation: blink 1s step-end infinite;
}

@keyframes blink {
  50% { opacity: 0; }
}
```

- [ ] **Step 3: 清理 main.tsx**

```tsx
// src/main.tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

- [ ] **Step 4: 验证前端启动**

Run: `cd web && npm run dev`
Expected: Vite dev server 启动在 localhost:3000，页面显示标题和输入框

- [ ] **Step 5: Commit**

```
git add web/src/App.tsx web/src/App.css web/src/main.tsx
git commit -m "feat(web): wire up App root with i18n context and chat layout"
```

---

## Task 9: 集成验证

- [ ] **Step 1: 确保 POC 环境已初始化**

验证：
```bash
# Catalog 健康检查
curl -s http://localhost:8082/health

# 如果未初始化，执行:
# bash scripts/04_init_poc_env.sh
```

- [ ] **Step 2: 配置后端 config.yaml**

用 .env 中的实际值替换 config.yaml 中的占位符，或确保环境变量已设置：
```bash
source .env
echo "API_KEY: $MOI_SYSTEM_API_KEY"
echo "WORKSPACE: $POC_WORKSPACE_ID"
```

- [ ] **Step 3: 启动后端**

```bash
cd backend
source ../.env
export MOI_SYSTEM_API_KEY POC_WORKSPACE_ID
go run . config.yaml
```
Expected: `HK SFC POC backend starting on :8083`

- [ ] **Step 4: 启动前端**

```bash
cd web
npm run dev
```
Expected: `Local: http://localhost:3000/`

- [ ] **Step 5: 端到端测试**

打开浏览器 http://localhost:3000，输入：
- "Show me the first 5 rows of ms_t_stk_sis" — 验证基础查询
- "What was the total trading volume when HSI dropped over 2%?" — 验证问题 1
- 切换语言到中文，输入"显示恒生指数最近的数据" — 验证双语

- [ ] **Step 6: Commit**

```
git add .
git commit -m "feat: complete initial POC integration - backend + frontend + moi-core"
```
