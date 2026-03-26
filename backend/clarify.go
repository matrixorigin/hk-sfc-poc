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

const classifySystemPrompt = `你是一个参数完整性检查器。用户在问港股数据分析问题。
判断用户问题是否缺少必要参数。

规则：
- 涉及指数行情/个股行情/成交量/均线分析：需要时间范围（日期、月份、季度、年份均可）
- 涉及财务数据（营收、利润）：需要股票代码或股票名称
- 涉及 CCASS 持仓变动：需要具体日期（至少一天）
- 涉及行业分类/市值对比：需要时间范围
- "今年"、"最近"、"上半年"、"Q1"等表述视为已提供时间范围
- "腾讯"、"00700"、"stock 88"等视为已提供股票标识
- 如果问题是闲聊、打招呼或与港股数据无关，返回 complete

仅返回 JSON，不要其他内容：
- 参数齐全：{"complete": true}
- 参数缺失：{"complete": false, "reply": "用自然语言反问用户补充缺失参数，简洁友好，一句话"}

示例：
用户: "恒指大跌的时候哪些股票成交量最大"
返回: {"complete": false, "reply": "请问您想查看哪个时间段的数据？比如2025年上半年，或者某个具体月份？"}

用户: "2025年4月恒指跌超2%时成交量最大的股票"
返回: {"complete": true}

用户: "营收增长情况"
返回: {"complete": false, "reply": "请问您想查看哪只股票的营收数据？请提供股票代码或名称。"}

用户: "股票88从2023到2025的营收"
返回: {"complete": true}`

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

	mu       sync.Mutex
	pending  map[string]string // session_id → 被反问的原始问题
	explored map[string]bool   // session_id → 是否已经有过 Explore 查询
}

func NewClarifier(catalogURL, apiKey, workspaceID, model string) *Clarifier {
	return &Clarifier{
		catalogURL:  catalogURL,
		apiKey:      apiKey,
		workspaceID: workspaceID,
		model:       model,
		httpClient:  &http.Client{},
		pending:     make(map[string]string),
		explored:    make(map[string]bool),
	}
}

// Process 是反问的完整流程入口。
// 返回值：(最终问题, 需要反问的回复, error)
//   - 如果参数齐全：返回 (question, "", nil)，调用方继续走 Explore
//   - 如果需要反问：返回 ("", reply, nil)，调用方返回反问 SSE
func (c *Clarifier) Process(ctx context.Context, sessionID, question string) (finalQuestion string, clarifyReply string, err error) {
	// Step 0: 如果该 session 已有 Explore 查询历史，短句追问直接放行给 Explore
	c.mu.Lock()
	hasExplored := c.explored[sessionID]
	pendingQ, hasPending := c.pending[sessionID]
	if hasPending {
		delete(c.pending, sessionID)
	}
	c.mu.Unlock()

	// Step 1: 如果有 pending，先合并
	if hasPending {
		merged := c.merge(ctx, pendingQ, question)
		log.Printf("clarify: merged pending=%q + input=%q → %q", pendingQ, question, merged)
		question = merged
	}

	// Step 2: 检查参数完整性（传入 session 是否已有查询历史）
	result := c.check(ctx, question, hasExplored)
	if result == nil {
		return question, "", nil
	}

	// Step 3: 参数不完整，缓存当前问题，返回反问
	c.mu.Lock()
	c.pending[sessionID] = question
	c.mu.Unlock()

	return "", result.Reply, nil
}

// ClearPending 清除某个 session 的 pending 状态（如用户点了 New Chat）。
func (c *Clarifier) ClearPending(sessionID string) {
	c.mu.Lock()
	delete(c.pending, sessionID)
	c.mu.Unlock()
}

// MarkExplored 标记该 session 已经有过 Explore 查询。
func (c *Clarifier) MarkExplored(sessionID string) {
	c.mu.Lock()
	c.explored[sessionID] = true
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

// check 调用 LLM 判断参数完整性。hasHistory 为 true 时提示 LLM 考虑追问场景。
func (c *Clarifier) check(ctx context.Context, question string, hasHistory bool) *ClarifyResult {
	prompt := classifySystemPrompt
	if hasHistory {
		prompt += `

重要补充：当前对话已有之前的查询历史。用户可能在追问或修改之前的查询条件（如"超过3%的呢"、"那2023年呢"、"排除衍生品"、"换成月度数据"等）。
这类追问虽然看起来缺少完整参数，但它们引用了之前的上下文，应该被视为参数齐全（complete=true），交给对话引擎处理。
只有当用户的问题是一个全新的、与之前无关的话题且确实缺少必要参数时，才返回 complete=false。`
	}
	content, err := c.callLLM(ctx, prompt, question)
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

// extractJSON 从可能包含 <think>...</think> 的文本中提取最后一个 JSON 对象。
func extractJSON(s string) string {
	start := -1
	end := -1
	for i := len(s) - 1; i >= 0; i-- {
		if s[i] == '}' && end == -1 {
			end = i
		}
		if s[i] == '{' && end != -1 {
			start = i
			break
		}
	}
	if start >= 0 && end > start {
		return s[start : end+1]
	}
	return ""
}
