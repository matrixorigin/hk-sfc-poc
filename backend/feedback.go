package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"regexp"
	"strings"
)

const feedbackSystemPrompt = `你是香港证券市场 NL2SQL 系统的**系统优化专家**。

## 背景
本系统通过 LLM 将用户自然语言问题翻译为 SQL 并在 MatrixOne 数据库上执行。系统可通过以下手段持续优化：
- **知识库规则**（logic）：业务约束，LLM 生成 SQL 时必须遵守的规则
- **Fewshot 示例**（case_library）：SQL 模板，LLM 可参考的高质量查询模式
- **术语表**（glossary）：术语到表/列的映射
- **Schema 优化**：列注释改进，帮助 LLM 更好理解列的含义和用法
- **数据预处理**：新增预计算列，简化 LLM 需要生成的 SQL 复杂度
- **参数校验**：前端反问机制，在查询前确保关键参数完整

## 你的任务
分析用户对某次查询结果的反馈，完成两个层次的分析：

### 层次一：诊断（这条 SQL 哪里错了）
1. 对比用户问题的语义意图与生成 SQL 的逻辑
2. 检查是否正确使用了预计算列（而非重复计算或遗漏）
3. 检查是否遗漏了必要过滤条件
4. 检查是否违反了知识库中已有的业务规则
5. 检查 MatrixOne SQL 方言兼容性
6. 如果能修正，给出修正后的 SQL

### 层次二：系统优化（怎么改配置让这类问题以后不再出错）
从以下维度思考系统级改进，每个维度如果有建议就给出，没有就跳过：

- **知识库规则（logic）**：是否需要新增业务约束规则？给出规则的 key、描述、关联表
- **Fewshot 示例（case_library）**：是否需要新增 SQL 模板？给出问题模式和 SQL
- **术语表（glossary）**：是否有用户常用术语没有映射到正确的表/列？
- **Schema 注释**：表或列的注释是否不够清晰，导致 LLM 误解？建议改成什么
- **数据预处理**：是否有反复出现的复杂计算可以预计算为新列？
- **参数校验**：是否应该在前端反问阶段就拦截这类不完整的问题？
- **其他**：任何你能想到的、能让系统整体变得更好的改进

## 输出格式
仅返回 JSON，不要任何其他内容：
{
  "problems": [
    {"severity": "error|warning|info", "description": "问题描述"}
  ],
  "corrected_sql": "修正后的 SQL，如无法修正则为空字符串",
  "system_actions": [
    {
      "category": "knowledge_rule|case_library|glossary|schema_comment|data_preprocessing|param_validation|other",
      "title": "建议标题",
      "detail": "具体内容（如果是知识库规则，给出完整的规则文本；如果是 fewshot，给出问题和 SQL；如果是 schema 注释，给出建议的新注释）",
      "priority": "high|medium|low",
      "reason": "为什么这个改动能防止类似问题再次发生"
    }
  ]
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
	sampleData := fa.fetchSampleData(ctx, tables)
	rules := fa.fetchKnowledgeRules(ctx)
	truncated := truncateResult(task.SQLResult, 20)

	var sb strings.Builder
	sb.WriteString("## 用户问题\n")
	sb.WriteString(task.Question)
	sb.WriteString("\n\n")

	if task.UserNote != "" {
		sb.WriteString("## 用户反馈\n")
		sb.WriteString(task.UserNote)
		sb.WriteString("\n\n")
	}

	sb.WriteString("## 生成的 SQL\n```sql\n")
	sb.WriteString(task.SQL)
	sb.WriteString("\n```\n\n")

	sb.WriteString("## SQL 执行结果（最多 20 行）\n")
	sb.WriteString(truncated)
	sb.WriteString("\n\n")

	if schema != "" {
		sb.WriteString("## 涉及表的 Schema（含列注释）\n")
		sb.WriteString(schema)
		sb.WriteString("\n")
	}

	if sampleData != "" {
		sb.WriteString("## 示例数据（每表前5行）\n")
		sb.WriteString(sampleData)
		sb.WriteString("\n")
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

	log.Printf("feedback: LLM response received (%d bytes)", len(rawContent))

	jsonStr := extractJSON(rawContent)
	if jsonStr == "" {
		return nil, fmt.Errorf("no JSON found in LLM response")
	}

	log.Printf("feedback: extracted JSON (first 300 chars): %s", jsonStr[:min(len(jsonStr), 300)])

	// 验证是合法 JSON
	var check json.RawMessage
	if err := json.Unmarshal([]byte(jsonStr), &check); err != nil {
		return nil, fmt.Errorf("invalid JSON from LLM: %w\njsonStr=%s", err, jsonStr[:min(len(jsonStr), 500)])
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

// fetchSchema 通过 MO 直接查询 SHOW FULL COLUMNS 获取表 schema。
func (fa *FeedbackAnalyzer) fetchSchema(_ context.Context, tables []string) string {
	if len(tables) == 0 {
		return ""
	}

	var sb strings.Builder
	for _, table := range tables {
		rows, err := fa.db.db.Query("SHOW FULL COLUMNS FROM " + table)
		if err != nil {
			log.Printf("feedback: show columns for %s: %v", table, err)
			continue
		}
		fmt.Fprintf(&sb, "### %s\n", table)
		cols, _ := rows.Columns()
		for rows.Next() {
			vals := make([]sql.NullString, len(cols))
			ptrs := make([]any, len(cols))
			for i := range vals {
				ptrs[i] = &vals[i]
			}
			if err := rows.Scan(ptrs...); err != nil {
				continue
			}
			// cols: Field, Type, Collation, Null, Key, Default, Extra, Privileges, Comment
			field := vals[0].String
			colType := vals[1].String
			comment := ""
			if len(vals) > 8 {
				comment = vals[8].String
			}
			if comment != "" {
				fmt.Fprintf(&sb, "- %s %s -- %s\n", field, colType, comment)
			} else {
				fmt.Fprintf(&sb, "- %s %s\n", field, colType)
			}
		}
		rows.Close()
		sb.WriteString("\n")
	}

	return sb.String()
}

// fetchSampleData 通过 MO 直接查每张表前5行作为示例数据。
func (fa *FeedbackAnalyzer) fetchSampleData(_ context.Context, tables []string) string {
	if len(tables) == 0 {
		return ""
	}

	var sb strings.Builder
	for _, table := range tables {
		rows, err := fa.db.db.Query("SELECT * FROM " + table + " LIMIT 5")
		if err != nil {
			log.Printf("feedback: sample data for %s: %v", table, err)
			continue
		}
		cols, _ := rows.Columns()
		fmt.Fprintf(&sb, "### %s\n", table)
		sb.WriteString("| " + strings.Join(cols, " | ") + " |\n")
		sb.WriteString("|" + strings.Repeat("---|", len(cols)) + "\n")

		for rows.Next() {
			vals := make([]sql.NullString, len(cols))
			ptrs := make([]any, len(cols))
			for i := range vals {
				ptrs[i] = &vals[i]
			}
			if err := rows.Scan(ptrs...); err != nil {
				continue
			}
			sb.WriteString("| ")
			for i, v := range vals {
				s := v.String
				if len(s) > 50 {
					s = s[:50] + "..."
				}
				sb.WriteString(s)
				if i < len(vals)-1 {
					sb.WriteString(" | ")
				}
			}
			sb.WriteString(" |\n")
		}
		rows.Close()
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
		fmt.Fprintf(&sb, "- [%s] %s: %s\n", item.Type, item.Key, string(valBytes))
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
