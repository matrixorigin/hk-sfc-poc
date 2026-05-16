package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
)

// followUpCheckPrompt 用于判断新问题是否是对历史问题的追问/修改。
// 只做一个判断，不检查参数。
const followUpCheckPrompt = `你是一个对话意图分类器。判断用户的"当前提问"是否是对前一个问题的追问或修改。

判断标准（必须严格遵守）：

只有满足以下任一条件才算追问：
1. 使用了指代词引用上文（"那"、"这些"、"其中"、"它们"）
2. 省略了关键信息，脱离上文无法独立理解（如"超过3%的呢"、"占比多少"、"用柱状图"）
3. 明确修改前一个查询的条件（"换成月度"、"加上行业筛选"、"去掉XX"）

以下情况绝对不是追问：
- 问题是一个语法完整的句子，包含自己的主语、谓语、条件
- 即使话题与历史相似（都是关于指数、都是关于成交量），只要问题本身是完整独立的，就不是追问
- 问题自身能被任何人独立理解，不需要看历史

核心原则：如果把"当前提问"单独拿出来给一个没看过历史的人，他能理解这个问题在问什么，那它就不是追问。

仅返回 JSON：
- 是追问：{"is_follow_up": true}
- 不是追问：{"is_follow_up": false}`

// classifySystemPrompt 用于检查独立问题在当前数据上下文下是否足以进入查询规划。
const classifySystemPrompt = `你是香港证券市场数据分析平台的查询准备检查器。

系统背景：
- 本平台专注于港交所（HKEX）上市证券的数据分析
- 数据覆盖：恒生指数行情、个股行情与成交量、行业分类与市值、新闻公告、CCASS券商持仓、上市公司财务报表
- 默认分析对象为恒生指数和港股主板股票

你的职责：
结合用户提问和当前数据上下文，判断这个问题是否足以进入查询规划。仅在确实缺少会导致无法形成合理查询计划的信息时才反问，一次只问一个最关键的问题。

关键判断：
- 时间范围：指数分析、成交量统计、均线筛选、新闻异常检测、行业市值对比等场景通常需要
- 股票标识：可以是股票代码、公司名称、股票简称、英文名或中文名
- 具体日期：CCASS持仓变动分析通常需要

数据上下文原则：
- 如果用户已选择数据表，优先依据这些表的字段语义判断
- 如果当前数据范围中存在公司名称、股票名称、证券名称、英文名、中文名等实体字段，用户提供公司/股票名称就视为已提供股票标识
- 不要为了把公司名称规范化成股票代码而反问
- 当前阶段不负责验证实体是否唯一命中；不要因为公司名可能重名、简称可能不完整而提前反问
- 用户给出了看起来具体的公司/股票名称时，应先放行给 Explore 查询；若查询后为空或多义，再由后续结果阶段处理
- 只有当对象、时间或必要条件缺失到无法形成查询计划时才反问

必须反问时间范围的需求场景：
- 市场指数单日跌幅超过某阈值时的全市场成交量
- 列出收盘价连续N个交易日高于N日移动均线的股票
- 检测重大新闻公告发布前，成交量超过N日平均值若干倍的股票
上述三类问题如果用户没有提供时间范围（如最近3个月、2025年全年、指定起止日期等），必须反问时间范围，不要直接放行。

判断规则：
- "今年"、"最近"、"上半年"、"Q1 2025"等表述视为已提供时间范围
- "腾讯"、"00700"、"stock 88"等视为已提供股票标识
- 即使你不认识某个公司名，也不要因为无法确认其股票代码而反问；只要它在问题中像一个具体公司/股票名称，就视为已提供对象
- "市场指数"、"指数"默认指恒生指数（HSI），不需要追问具体是哪个指数
- "全市场"、"市场总成交量"默认包含所有港股，不需要追问范围
- "重大新闻"、"重大公告"已有明确定义（按新闻类型筛选），不需要追问如何定义
- 闲聊或无法归类的问题视为参数齐全
- 宁可放行让 Explore 引擎处理，也不要过度反问。只在关键参数明显缺失时才反问

示例：
- 问题："2025年1月，新华电源每日的开盘价、收盘价、最高价、最低价"，当前数据范围有"公司名称"和价格字段。应返回：{"complete": true}
- 问题："2025年1月，每日的开盘价、收盘价、最高价、最低价"，没有说明股票、公司或指数对象。可以反问对象。
- 问题："列出收盘价连续10个交易日高于50日移动均线的股票，并绘制图表。"，没有时间范围。应返回：{"complete": false, "reply": "请问要查询哪个时间范围？例如最近3个月、2025年全年或指定起止日期。"}

仅返回 JSON，不要其他内容：
- 参数齐全：{"complete": true}
- 参数缺失：{"complete": false, "reply": "用自然语言反问用户补充缺失参数，简洁友好，一句话"}

重要：reply 字段必须使用与用户提问相同的语言。用户用英文问，reply 用英文；用户用中文问，reply 用中文。`

const mergeSystemPrompt = `你是一个问题合并助手。用户之前问了一个不完整的问题，现在补充了信息。
请判断用户的新输入：
1. 如果是对原始问题的补充（提供了缺失的时间范围、股票代码等），把原始问题和补充合并成一个完整的自然语言问题。
2. 如果是一个全新的、与原始问题无关的问题，只返回新问题原文。

只返回合并后的问题文本，不要任何解释。

重要：合并后的问题必须使用与原始问题相同的语言。原问题是英文就输出英文，是中文就输出中文。`

// ClarifyResult 是分类 LLM 的返回结果。
type ClarifyResult struct {
	Complete bool   `json:"complete"`
	Reply    string `json:"reply,omitempty"`
}

type ClarifyContext struct {
	Scope  string
	Tables []ClarifyTableCapability
}

type ClarifyTableCapability struct {
	Name         string
	Source       string
	EntityFields []string
	TimeFields   []string
	MetricFields []string
}

// Clarifier 通过 Catalog LLM API 判断问题参数是否完整，并管理反问上下文。
// 状态（pending / history）持久化在 ConversationsDB 里，Clarifier 本身无内存态。
type Clarifier struct {
	catalogURL  string
	apiKey      string
	workspaceID string
	model       string
	httpClient  *http.Client
	db          *ConversationsDB
}

func NewClarifier(catalogURL, apiKey, workspaceID, model string, db *ConversationsDB) *Clarifier {
	return &Clarifier{
		catalogURL:  catalogURL,
		apiKey:      apiKey,
		workspaceID: workspaceID,
		model:       model,
		httpClient:  &http.Client{},
		db:          db,
	}
}

// Process 是反问的完整流程入口。
// 返回值：(最终问题, 需要反问的回复, error)
//   - 如果参数齐全：返回 (question, "", nil)，调用方继续走 Explore
//   - 如果需要反问：返回 ("", reply, nil)，调用方返回反问 SSE
//
// 注意：Process 由 MessagesHandler 在「写当前 user message 之前」调用，
// 因此 db.RecentUserQuestions 返回的历史天然不包含当前问题。
// handler 负责在反问分支写 pending_clarify、在合并分支清 pending_clarify。
func (c *Clarifier) Process(ctx context.Context, conversationID, userID, question string, qctx *ClarifyContext) (finalQuestion string, clarifyReply string, err error) {
	var pendingQ string
	var hist []string
	if c.db != nil {
		conv, dbErr := c.db.GetConversation(conversationID, userID)
		if dbErr == nil && conv != nil {
			pendingQ = conv.PendingClarify
		}
		if h, dbErr2 := c.db.RecentUserQuestions(conversationID, 5); dbErr2 == nil {
			hist = h
		}
	}

	// Step 1: 用户回答反问 → merge 后直接放行
	if pendingQ != "" {
		merged := c.merge(ctx, pendingQ, question)
		log.Printf("clarify: merged pending=%q + input=%q → %q", pendingQ, question, merged)
		return merged, "", nil
	}

	// Step 2: 有历史时先判断是否追问（一次 LLM 调用）
	if len(hist) > 0 {
		if c.isFollowUp(ctx, question, hist) {
			log.Printf("clarify: detected follow-up, skipping param check: %q", question)
			return question, "", nil
		}
		log.Printf("clarify: not a follow-up, checking params independently: %q", question)
	}

	// Step 3: 无状态参数检查（不传历史）
	result := c.checkParams(ctx, question, qctx)
	if result == nil {
		return question, "", nil
	}

	return "", result.Reply, nil
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

// isFollowUp 调用 LLM 判断问题是否是对历史的追问（传历史，只判断追问关系）。
func (c *Clarifier) isFollowUp(ctx context.Context, question string, history []string) bool {
	var userContent string
	userContent = "对话历史：\n"
	for i, q := range history {
		userContent += fmt.Sprintf("%d. %s\n", i+1, q)
	}
	userContent += fmt.Sprintf("\n当前提问：%s", question)

	content, err := c.callLLM(ctx, followUpCheckPrompt, userContent)
	if err != nil {
		log.Printf("clarify: follow-up check LLM error: %v", err)
		return false // 出错时视为非追问，走参数检查
	}

	jsonStr := extractJSON(content)
	if jsonStr == "" {
		return false
	}

	var result struct {
		IsFollowUp bool `json:"is_follow_up"`
	}
	if err := json.Unmarshal([]byte(jsonStr), &result); err != nil {
		return false
	}

	log.Printf("clarify: follow-up check result=%v for question=%q", result.IsFollowUp, question)
	return result.IsFollowUp
}

// checkParams 调用 LLM 检查参数完整性（不传历史，独立评估）。
func (c *Clarifier) checkParams(ctx context.Context, question string, qctx *ClarifyContext) *ClarifyResult {
	content, err := c.callLLM(ctx, classifySystemPrompt, buildClarifyUserContent(question, qctx))
	if err != nil {
		log.Printf("clarify: param check LLM error: %v", err)
		return nil // 出错时放行
	}

	jsonStr := extractJSON(content)
	if jsonStr == "" {
		log.Printf("clarify: no JSON found in param check: %s", content)
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

func buildClarifyUserContent(question string, qctx *ClarifyContext) string {
	if qctx == nil || len(qctx.Tables) == 0 {
		return question
	}

	var sb strings.Builder
	sb.WriteString("用户问题：")
	sb.WriteString(question)
	sb.WriteString("\n\n当前数据上下文：\n")
	if qctx.Scope != "" {
		sb.WriteString("查询范围：")
		sb.WriteString(qctx.Scope)
		sb.WriteString("\n")
	}
	for _, table := range qctx.Tables {
		sb.WriteString("- ")
		sb.WriteString(table.Name)
		if table.Source != "" {
			sb.WriteString("（")
			sb.WriteString(table.Source)
			sb.WriteString("）")
		}
		sb.WriteString("\n")
		if len(table.EntityFields) > 0 {
			sb.WriteString("  实体字段：")
			sb.WriteString(strings.Join(table.EntityFields, "，"))
			sb.WriteString("\n")
		}
		if len(table.TimeFields) > 0 {
			sb.WriteString("  时间字段：")
			sb.WriteString(strings.Join(table.TimeFields, "，"))
			sb.WriteString("\n")
		}
		if len(table.MetricFields) > 0 {
			sb.WriteString("  指标字段：")
			sb.WriteString(strings.Join(table.MetricFields, "，"))
			sb.WriteString("\n")
		}
	}
	return sb.String()
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
