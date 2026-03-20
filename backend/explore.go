package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

// --- 请求结构体 ---

type QueryDomain struct {
	Text string `json:"text"`
}

type SessionDomain struct {
	SessionID string `json:"session_id,omitempty"`
}

type TableSource struct {
	TableName string `json:"table_name"`
}

type DataSourceDomain struct {
	DBName  string        `json:"db_name"`
	Sources []TableSource `json:"sources"`
}

type TraceOptions struct {
	Verbose string `json:"verbose,omitempty"`
}

type ExploreOptions struct {
	PlanningMode string       `json:"planning_mode,omitempty"`
	Trace        TraceOptions `json:"trace,omitempty"`
}

type ExploreRequest struct {
	WorkspaceID string           `json:"workspace_id"`
	Query       QueryDomain      `json:"query"`
	Session     SessionDomain    `json:"session,omitempty"`
	DataSource  DataSourceDomain `json:"data_source"`
	Options     ExploreOptions   `json:"options,omitempty"`
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

// QueryStream 发起 POST 请求到 Explore SSE 接口，返回 response body 流。
func (c *ExploreClient) QueryStream(ctx context.Context, req ExploreRequest) (io.ReadCloser, error) {
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
		_ = resp.Body.Close()
		return nil, fmt.Errorf("upstream returned status %d", resp.StatusCode)
	}

	return resp.Body, nil
}
