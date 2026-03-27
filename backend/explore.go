package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

// --- 请求结构体（匹配 Catalog Explore API） ---

type ExploreRequest struct {
	Query       QueryDomain      `json:"query"`
	Session     SessionDomain    `json:"session"`
	DataSources DataSourceDomain `json:"data_sources"`
	Options     ExploreOptions   `json:"options,omitempty"`
	Trace       TraceOptions     `json:"trace,omitempty"`
}

type QueryDomain struct {
	Question string `json:"question"`
}

type SessionDomain struct {
	SessionID   string `json:"session_id"`
	WorkspaceID string `json:"workspace_id"`
	UserID      string `json:"user_id,omitempty"`
}

type DataSourceDomain struct {
	Tables         *TableSource       `json:"tables,omitempty"`
	KnowledgeBases []KnowledgeBaseRef `json:"knowledge_bases,omitempty"`
}

type TableSource struct {
	DBName    string   `json:"db_name"`
	TableList []string `json:"table_list"`
}

type KnowledgeBaseRef struct {
	KnowledgeBaseID int64 `json:"knowledge_base_id"`
}

type ExploreOptions struct {
	PlanningMode string     `json:"planning_mode,omitempty"`
	Verbose      string     `json:"verbose,omitempty"`
	LLM          *LLMConfig `json:"llm,omitempty"`
}

type LLMConfig struct {
	Model string `json:"model"`
}

type TraceOptions struct {
	Enabled bool `json:"enabled"`
}

// --- 客户端 ---

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

// CreateSession 调用 Catalog API 创建 LLM 会话，返回数字 session ID。
func (c *ExploreClient) CreateSession(ctx context.Context, workspaceID, title string) (string, error) {
	reqBody := map[string]string{"title": title, "source": "explore"}
	bodyBytes, err := json.Marshal(reqBody)
	if err != nil {
		return "", fmt.Errorf("marshal: %w", err)
	}

	endpoint := fmt.Sprintf("%s/api/v1/workspaces/%s/llm/sessions", c.catalogURL, workspaceID)
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(bodyBytes))
	if err != nil {
		return "", fmt.Errorf("create request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if c.apiKey != "" {
		httpReq.Header.Set("X-API-Key", c.apiKey)
	}

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return "", fmt.Errorf("do request: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return "", fmt.Errorf("create session returned %d: %s", resp.StatusCode, string(respBody))
	}

	var result struct {
		Data struct {
			ID     int64  `json:"id"`
			UserID string `json:"user_id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(respBody, &result); err != nil {
		return "", fmt.Errorf("parse response: %w", err)
	}

	return fmt.Sprintf("%d", result.Data.ID), nil
}

// QueryStream 发起 POST 请求到 Explore SSE 接口，返回 response body 流。
func (c *ExploreClient) QueryStream(ctx context.Context, req *ExploreRequest) (io.ReadCloser, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("marshal explore request: %w", err)
	}

	endpoint := c.catalogURL + "/api/v1/explore/query/stream"
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("create http request: %w", err)
	}

	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "text/event-stream")
	httpReq.Header.Set("Cache-Control", "no-cache")
	if c.apiKey != "" {
		httpReq.Header.Set("X-API-Key", c.apiKey)
	}

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("do http request: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		errBody, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		return nil, fmt.Errorf("upstream returned status %d: %s", resp.StatusCode, string(errBody))
	}

	return resp.Body, nil
}
