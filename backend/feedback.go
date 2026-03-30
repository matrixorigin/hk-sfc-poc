package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"regexp"
	"strings"
)

const feedbackSystemPrompt = `你是香港证券市场 NL2SQL 系统的分析专家。

你的任务是分析用户对某次查询的反馈，找出 SQL 生成环节存在的问题，并给出改进建议。

分析维度：
1. 语义对齐：对比用户问题的语义意图与生成 SQL 的逻辑，检查是否理解偏差或丢失关键条件。
2. 预计算列使用：检查是否正确利用了以下预计算列（而非重复计算）：
   - trade_date: 交易日期
   - avg_vol_30d: 30日平均成交量
   - industry_name: 行业分类名称
   - consecutive_above_ma3: 连续高于3日均线天数
3. 必要过滤条件缺失：检查是否遗漏了以下强制过滤：
   - 衍生品过滤：SISTKC < '10000'（排除权证、牛熊证等衍生品）
   - 新闻去重：同一新闻在多个来源出现时需去重处理
4. 知识库规则违反：对照提供的知识库规则，检查 SQL 是否违反了业务规则。
5. MatrixOne 方言兼容性：检查是否使用了 MatrixOne 不支持的语法，包括但不限于：
   - RIGHT() 函数不支持
   - CHANGE 是保留字，不能用作列名或别名
   - 其他与标准 MySQL 的语法差异
6. SQL 正确性：检查 SQL 本身的逻辑错误、语法错误。

输出要求：
仅返回 JSON，不要任何其他内容，格式如下：
{
  "problems": [
    {"severity": "error|warning|info", "description": "问题描述"}
  ],
  "suggestions": [
    {"type": "fix|improvement|note", "description": "建议标题", "detail": "详细说明"}
  ],
  "corrected_sql": "修正后的 SQL，如无需修改则为空字符串"
}`

// tableNameRe 从 SQL 中提取 FROM/JOIN 后跟随的表名。
var tableNameRe = regexp.MustCompile(`(?i)(?:FROM|JOIN)\s+(\w+)`)

// FeedbackAnalyzer 异步分析反馈任务。
type FeedbackAnalyzer struct {
	catalogURL  string
	apiKey      string
	workspaceID string
	model       string
	db          *FeedbackDB
	clarifier   *Clarifier
}

// NewFeedbackAnalyzer 创建 FeedbackAnalyzer。
func NewFeedbackAnalyzer(cfg *Config, db *FeedbackDB, clarifier *Clarifier) *FeedbackAnalyzer {
	return &FeedbackAnalyzer{
		catalogURL:  cfg.Catalog.URL,
		apiKey:      cfg.Catalog.APIKey,
		workspaceID: cfg.Catalog.WorkspaceID,
		model:       cfg.Explore.LLMModel,
		db:          db,
		clarifier:   clarifier,
	}
}

// RunAsync 异步启动分析任务。
func (fa *FeedbackAnalyzer) RunAsync(task *FeedbackTask) {
	go func() {
		if err := fa.db.UpdateStatus(task.ID, "analyzing"); err != nil {
			log.Printf("feedback: update status error: %v", err)
		}

		ctx := context.Background()
		result, err := fa.analyze(ctx, task)
		if err != nil {
			log.Printf("feedback: analyze error for task %s: %v", task.ID, err)
			if dbErr := fa.db.UpdateError(task.ID, err.Error()); dbErr != nil {
				log.Printf("feedback: update error field failed: %v", dbErr)
			}
			return
		}

		if err := fa.db.UpdateResult(task.ID, result); err != nil {
			log.Printf("feedback: update result error for task %s: %v", task.ID, err)
		}
	}()
}

// analyze 构建分析上下文并调用 LLM，返回解析后的 JSON 结果。
func (fa *FeedbackAnalyzer) analyze(ctx context.Context, task *FeedbackTask) (json.RawMessage, error) {
	tables := extractTableNames(task.SQL)
	schema := fa.fetchSchema(ctx, tables)
	rules := fa.fetchKnowledgeRules(ctx)
	truncated := truncateResult(task.SQLResult, 20)

	var sb strings.Builder
	sb.WriteString("## 用户问题\n")
	sb.WriteString(task.Question)
	sb.WriteString("\n\n")

	sb.WriteString("## 用户反馈\n")
	sb.WriteString(task.UserNote)
	sb.WriteString("\n\n")

	sb.WriteString("## 生成的 SQL\n```sql\n")
	sb.WriteString(task.SQL)
	sb.WriteString("\n```\n\n")

	sb.WriteString("## SQL 执行结果（最多 20 行）\n")
	sb.WriteString(truncated)
	sb.WriteString("\n\n")

	if schema != "" {
		sb.WriteString("## 表 Schema\n")
		sb.WriteString(schema)
		sb.WriteString("\n\n")
	}

	if rules != "" {
		sb.WriteString("## 知识库规则\n")
		sb.WriteString(rules)
		sb.WriteString("\n")
	}

	userContent := sb.String()
	rawContent, err := fa.callLLMWithThinking(ctx, feedbackSystemPrompt, userContent)
	if err != nil {
		return nil, fmt.Errorf("LLM call failed: %w", err)
	}

	jsonStr := extractJSON(rawContent)
	if jsonStr == "" {
		return nil, fmt.Errorf("no JSON found in LLM response: %s", rawContent)
	}

	// 验证是合法 JSON
	var check json.RawMessage
	if err := json.Unmarshal([]byte(jsonStr), &check); err != nil {
		return nil, fmt.Errorf("invalid JSON from LLM: %w", err)
	}

	return json.RawMessage(jsonStr), nil
}

// callLLMWithThinking 使用 enable_thinking:true 调用 LLM。
func (fa *FeedbackAnalyzer) callLLMWithThinking(ctx context.Context, systemPrompt, userContent string) (string, error) {
	reqBody := map[string]any{
		"model": fa.model,
		"messages": []map[string]string{
			{"role": "system", "content": systemPrompt},
			{"role": "user", "content": userContent},
		},
		"temperature":     0,
		"enable_thinking": true,
	}
	return fa.clarifier.callLLMRaw(ctx, reqBody)
}

// fetchSchema 查询指定表的 schema 信息，返回格式化字符串。
func (fa *FeedbackAnalyzer) fetchSchema(ctx context.Context, tables []string) string {
	if len(tables) == 0 {
		return ""
	}

	var sb strings.Builder
	for _, table := range tables {
		url := fmt.Sprintf("%s/api/v1/workspaces/%s/sql-databases/hk_sfc/tables/%s/schema",
			fa.catalogURL, fa.workspaceID, table)

		data, err := httpGetWithKey(ctx, url, fa.apiKey)
		if err != nil {
			log.Printf("feedback: fetch schema for table %s: %v", table, err)
			continue
		}

		var resp struct {
			Columns []struct {
				Name    string `json:"name"`
				Type    string `json:"type"`
				Comment string `json:"comment"`
			} `json:"columns"`
		}
		if err := json.Unmarshal(data, &resp); err != nil {
			log.Printf("feedback: parse schema for table %s: %v", table, err)
			continue
		}

		sb.WriteString(fmt.Sprintf("### %s\n", table))
		for _, col := range resp.Columns {
			line := fmt.Sprintf("- %s %s", col.Name, col.Type)
			if col.Comment != "" {
				line += fmt.Sprintf(" -- %s", col.Comment)
			}
			sb.WriteString(line + "\n")
		}
		sb.WriteString("\n")
	}

	return sb.String()
}

// fetchKnowledgeRules 从 Catalog API 获取知识库规则，返回格式化字符串。
func (fa *FeedbackAnalyzer) fetchKnowledgeRules(ctx context.Context) string {
	url := fmt.Sprintf("%s/api/v1/workspaces/%s/nl2sql-knowledge/list",
		fa.catalogURL, fa.workspaceID)

	body, err := json.Marshal(map[string]any{"page_size": 100})
	if err != nil {
		log.Printf("feedback: marshal knowledge request: %v", err)
		return ""
	}

	data, err := httpPostWithKey(ctx, url, fa.apiKey, body)
	if err != nil {
		log.Printf("feedback: fetch knowledge rules: %v", err)
		return ""
	}

	var resp struct {
		Items []struct {
			Type   string `json:"type"`
			Key    string `json:"key"`
			Values any    `json:"values"`
		} `json:"items"`
	}
	if err := json.Unmarshal(data, &resp); err != nil {
		log.Printf("feedback: parse knowledge rules: %v", err)
		return ""
	}

	if len(resp.Items) == 0 {
		return ""
	}

	var sb strings.Builder
	for _, item := range resp.Items {
		valBytes, _ := json.Marshal(item.Values)
		sb.WriteString(fmt.Sprintf("- [%s] %s: %s\n", item.Type, item.Key, string(valBytes)))
	}
	return sb.String()
}

// extractTableNames 从 SQL 中提取所有表名（去重）。
func extractTableNames(sql string) []string {
	matches := tableNameRe.FindAllStringSubmatch(sql, -1)
	seen := make(map[string]struct{})
	var result []string
	for _, m := range matches {
		name := strings.ToLower(m[1])
		if _, exists := seen[name]; !exists {
			seen[name] = struct{}{}
			result = append(result, m[1])
		}
	}
	return result
}

// truncateResult 将 SQL 结果截断为最多 maxRows 行，返回 JSON 字符串。
func truncateResult(raw json.RawMessage, maxRows int) string {
	if len(raw) == 0 {
		return "(无结果)"
	}

	// 尝试解析为行数组
	var rows []json.RawMessage
	if err := json.Unmarshal(raw, &rows); err != nil {
		// 不是数组，直接返回原始字符串（截断过长内容）
		s := string(raw)
		if len(s) > 2000 {
			s = s[:2000] + "...(截断)"
		}
		return s
	}

	truncated := false
	if len(rows) > maxRows {
		rows = rows[:maxRows]
		truncated = true
	}

	out, err := json.MarshalIndent(rows, "", "  ")
	if err != nil {
		return string(raw)
	}

	result := string(out)
	if truncated {
		result += fmt.Sprintf("\n...(仅显示前 %d 行)", maxRows)
	}
	return result
}

// httpGetWithKey 发送 GET 请求并返回响应体。
func httpGetWithKey(ctx context.Context, url, apiKey string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("create GET request: %w", err)
	}
	req.Header.Set("X-API-Key", apiKey)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("do GET request: %w", err)
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read GET response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET %s returned %d: %s", url, resp.StatusCode, string(data))
	}

	return data, nil
}

// httpPostWithKey 发送 POST 请求并返回响应体。
func httpPostWithKey(ctx context.Context, url, apiKey string, body []byte) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("create POST request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-Key", apiKey)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("do POST request: %w", err)
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read POST response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("POST %s returned %d: %s", url, resp.StatusCode, string(data))
	}

	return data, nil
}
