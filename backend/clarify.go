package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"sync"
)

const classifySystemPrompt = `你是香港证券市场数据分析平台的参数完整性检查器。

系统背景：
- 本平台专注于港交所（HKEX）上市证券的数据分析
- 数据覆盖：恒生指数行情、个股行情与成交量、行业分类与市值、新闻公告、CCASS券商持仓、上市公司财务报表
- 默认分析对象为恒生指数和港股主板股票

你的职责：
判断用户的提问是否包含执行查询所需的关键参数。结合对话历史综合判断，仅在确实缺少必要参数时才反问，一次只问一个最关键的缺失参数。

需要的关键参数：
- 时间范围：指数分析、成交量统计、均线筛选、新闻异常检测、行业市值对比等场景需要
- 股票标识：个股财务数据（营收、利润）查询需要股票代码或名称
- 具体日期：CCASS持仓变动分析需要

判断规则：
- "今年"、"最近"、"上半年"、"Q1 2025"等表述视为已提供时间范围
- "腾讯"、"00700"、"stock 88"等视为已提供股票标识
- "市场指数"、"指数"默认指恒生指数（HSI），不需要追问具体是哪个指数
- "全市场"、"市场总成交量"默认包含所有港股，不需要追问范围
- "重大新闻"、"重大公告"已有明确定义（按新闻类型筛选），不需要追问如何定义
- 如果用户的问题是对之前查询的追问或修改条件（如"那超过3%的呢"、"换成月度数据"、"占比多少"），所需参数可从对话历史中继承，视为参数齐全
- 闲聊或无法归类的问题视为参数齐全
- 宁可放行让 Explore 引擎处理，也不要过度反问。只在关键参数明显缺失时才反问

仅返回 JSON，不要其他内容：
- 参数齐全：{"complete": true}
- 参数缺失：{"complete": false, "reply": "用自然语言反问用户补充缺失参数，简洁友好，一句话"}`

const mergeSystemPrompt = `你是一个问题合并助手。用户之前问了一个不完整的问题，现在补充了信息。
请判断用户的新输入：
1. 如果是对原始问题的补充（提供了缺失的时间范围、股票代码等），把原始问题和补充合并成一个完整的自然语言问题。
2. 如果是一个全新的、与原始问题无关的问题，只返回新问题原文。

只返回合并后的问题文本，不要任何解释。`

// ClarifyResult 是分类 LLM 的返回结果。
type ClarifyResult struct {
	Complete bool   `json:"complete"`
	Reply    string `json:"reply,omitempty"`
}

// Clarifier 通过 Catalog LLM API 判断问题参数是否完整，并管理反问上下文。
type Clarifier struct {
	catalogURL  string
	apiKey      string
	workspaceID string
	model       string
	httpClient  *http.Client

	mu      sync.Mutex
	pending map[string]string   // session_id → 被反问的原始问题
	history map[string][]string // session_id → 已发送到 Explore 的历史问题
}

func NewClarifier(catalogURL, apiKey, workspaceID, model string) *Clarifier {
	return &Clarifier{
		catalogURL:  catalogURL,
		apiKey:      apiKey,
		workspaceID: workspaceID,
		model:       model,
		httpClient:  &http.Client{},
		pending:     make(map[string]string),
		history:     make(map[string][]string),
	}
}

// Process 是反问的完整流程入口。
// 返回值：(最终问题, 需要反问的回复, error)
//   - 如果参数齐全：返回 (question, "", nil)，调用方继续走 Explore
//   - 如果需要反问：返回 ("", reply, nil)，调用方返回反问 SSE
func (c *Clarifier) Process(ctx context.Context, sessionID, question string) (finalQuestion string, clarifyReply string, err error) {
	c.mu.Lock()
	pendingQ, hasPending := c.pending[sessionID]
	if hasPending {
		delete(c.pending, sessionID)
	}
	hist := make([]string, len(c.history[sessionID]))
	copy(hist, c.history[sessionID])
	c.mu.Unlock()

	// Step 1: 用户回答反问 → merge 后直接放行，不再二次检查
	if hasPending {
		merged := c.merge(ctx, pendingQ, question)
		log.Printf("clarify: merged pending=%q + input=%q → %q", pendingQ, question, merged)
		return merged, "", nil
	}

	// Step 2: 带对话历史检查参数完整性
	result := c.check(ctx, question, hist)
	if result == nil {
		return question, "", nil
	}

	// Step 3: 参数不完整，缓存当前问题，返回反问
	c.mu.Lock()
	c.pending[sessionID] = question
	c.mu.Unlock()

	return "", result.Reply, nil
}

// ClearSession 清除某个 session 的全部状态（如用户点了 New Chat）。
func (c *Clarifier) ClearSession(sessionID string) {
	c.mu.Lock()
	delete(c.pending, sessionID)
	delete(c.history, sessionID)
	c.mu.Unlock()
}

// RecordExplored 记录一条已发送到 Explore 的问题，用于后续对话历史上下文。
func (c *Clarifier) RecordExplored(sessionID, question string) {
	c.mu.Lock()
	h := c.history[sessionID]
	h = append(h, question)
	if len(h) > 5 {
		h = h[len(h)-5:]
	}
	c.history[sessionID] = h
	c.mu.Unlock()
}

// merge 调用 LLM 合并原始问题和用户补充。
func (c *Clarifier) merge(ctx context.Context, original, supplement string) string {
	userContent := fmt.Sprintf("原始问题：%s\n用户补充：%s", original, supplement)
	content, err := c.callLLM(ctx, mergeSystemPrompt, userContent)
	if err != nil {
		log.Printf("clarify: merge LLM error: %v, falling back to supplement", err)
		return supplement // 合并失败时用新输入
	}
	return content
}

// check 调用 LLM 判断参数完整性，传入对话历史供 LLM 综合判断。
func (c *Clarifier) check(ctx context.Context, question string, history []string) *ClarifyResult {
	// 构造包含对话历史的用户消息
	var userContent string
	if len(history) > 0 {
		userContent = "本次对话中用户的历史提问（均已获得回答）：\n"
		for i, q := range history {
			userContent += fmt.Sprintf("%d. %s\n", i+1, q)
		}
		userContent += fmt.Sprintf("\n当前提问：%s", question)
	} else {
		userContent = question
	}

	content, err := c.callLLM(ctx, classifySystemPrompt, userContent)
	if err != nil {
		log.Printf("clarify: check LLM error: %v", err)
		return nil // 出错时放行
	}

	// 提取 JSON（qwen3 可能有 <think>...</think>）
	jsonStr := extractJSON(content)
	if jsonStr == "" {
		log.Printf("clarify: no JSON found in: %s", content)
		return nil
	}

	var result ClarifyResult
	if err := json.Unmarshal([]byte(jsonStr), &result); err != nil {
		log.Printf("clarify: parse JSON error: %v, content: %s", err, jsonStr)
		return nil
	}

	if result.Complete {
		return nil
	}

	log.Printf("clarify: missing params for question=%q, reply=%q", question, result.Reply)
	return &result
}

// callLLM 调用 Catalog LLM chat completions API。
func (c *Clarifier) callLLM(ctx context.Context, systemPrompt, userContent string) (string, error) {
	reqBody := map[string]any{
		"model": c.model,
		"messages": []map[string]string{
			{"role": "system", "content": systemPrompt},
			{"role": "user", "content": userContent},
		},
		"temperature": 0,
	}

	bodyBytes, err := json.Marshal(reqBody)
	if err != nil {
		return "", fmt.Errorf("marshal: %w", err)
	}

	endpoint := fmt.Sprintf("%s/api/v1/workspaces/%s/llm/chat/completions", c.catalogURL, c.workspaceID)
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(bodyBytes))
	if err != nil {
		return "", fmt.Errorf("create request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("X-API-Key", c.apiKey)

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return "", fmt.Errorf("do request: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("LLM returned %d: %s", resp.StatusCode, string(respBody))
	}

	var llmResp struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(respBody, &llmResp); err != nil {
		return "", fmt.Errorf("parse response: %w", err)
	}

	if len(llmResp.Choices) == 0 {
		return "", fmt.Errorf("empty choices")
	}

	return llmResp.Choices[0].Message.Content, nil
}

// callLLMRaw 调用 Catalog LLM chat completions API，接受完整的请求体（支持 enable_thinking 等参数）。
func (c *Clarifier) callLLMRaw(ctx context.Context, reqBody map[string]any) (string, error) {
	bodyBytes, err := json.Marshal(reqBody)
	if err != nil {
		return "", fmt.Errorf("marshal: %w", err)
	}

	endpoint := fmt.Sprintf("%s/api/v1/workspaces/%s/llm/chat/completions", c.catalogURL, c.workspaceID)
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(bodyBytes))
	if err != nil {
		return "", fmt.Errorf("create request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("X-API-Key", c.apiKey)

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return "", fmt.Errorf("do request: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("LLM returned %d: %s", resp.StatusCode, string(respBody))
	}

	var llmResp struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(respBody, &llmResp); err != nil {
		return "", fmt.Errorf("parse response: %w", err)
	}

	if len(llmResp.Choices) == 0 {
		return "", fmt.Errorf("empty choices")
	}

	return llmResp.Choices[0].Message.Content, nil
}

// extractJSON 从可能包含 <think>...</think> 的文本中提取最后一个完整的 JSON 对象。
// 正确处理嵌套的 {} 括号。
func extractJSON(s string) string {
	// 从后往前找最后一个 }，然后往前匹配到对应的 {
	end := -1
	for i := len(s) - 1; i >= 0; i-- {
		if s[i] == '}' {
			end = i
			break
		}
	}
	if end < 0 {
		return ""
	}
	// 从 end 往前扫描，跟踪嵌套深度
	depth := 0
	start := -1
	for i := end; i >= 0; i-- {
		if s[i] == '}' {
			depth++
		} else if s[i] == '{' {
			depth--
			if depth == 0 {
				start = i
				break
			}
		}
	}
	if start >= 0 && end > start {
		return s[start : end+1]
	}
	return ""
}
