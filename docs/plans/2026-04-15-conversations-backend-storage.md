# Conversations Backend Storage — Implementation Plan

Spec: [`docs/specs/2026-04-15-conversations-backend-storage.md`](../specs/2026-04-15-conversations-backend-storage.md)

## 实施顺序

按「后端独立联调 → 前端集成 → 端到端」三段式。每段结束有可验证产出。

---

## 阶段 1：后端 DB 层 + 聚合器

目标：后端单独跑通，可用 curl 验证 CRUD + SSE 聚合落库。

### 1.1 新增 `backend/conversations_db.go`

- [ ] `ConversationsDB` struct 持有 `*sql.DB`（复用 `feedbackdb.go` 的同一连接）
- [ ] `NewConversationsDB(db *sql.DB)` 在构造时跑两条 `CREATE TABLE IF NOT EXISTS`
- [ ] **Message seq 生成**：`seq = time.Now().UnixNano()`，单调保序、无需 SELECT MAX、并发冲突概率可忽略
- [ ] 方法清单：
  - [ ] `CreateConversation() (id string, err error)` — 插入空行，返回 UUID
  - [ ] `ListConversations() ([]ConversationMeta, error)` — `ORDER BY updated_at DESC`
  - [ ] `GetConversation(id string) (*Conversation, error)`
  - [ ] `UpdateTitle(id, title string) error`
  - [ ] `UpdateTitleIfEmpty(id, title string) error` — 只在 title 为空时更新；用户首问入库时顺手调
  - [ ] `UpdateCatalogSessionID(id, catalogID string) error`
  - [ ] `UpdatePendingClarify(id, pending string) error` — 空串即清除
  - [ ] `DeleteConversation(id string) error` — 先删 messages 再删 conversations（MO 无外键）
  - [ ] `InsertMessage(msg Message) error` — 内部生成 seq
  - [ ] `UpdateMessageStatus(id, status string) error`
  - [ ] `PersistAssistantMessage(msg Message) error` — 一次性把聚合结果写回并设 `status=done`
  - [ ] `ListMessages(conversationID string) ([]Message, error)` — `ORDER BY seq ASC`
  - [ ] `RecentUserQuestions(conversationID string, n int) ([]string, error)` — Clarifier 用；由于 Clarifier 先跑、写 message 后跑，天然不包含当前问题，无需额外 exclude

### 1.2 新增 `backend/message_aggregator.go`

- [ ] `MessageAggregate` struct 字段同 spec 表格
- [ ] `Apply(evt SSEEvent)` 按事件类型分发
- [ ] `Finalize() Message` 返回可直接入库的 Message
- [ ] 单元逻辑：
  - [ ] `sql.result` → 追加 sql_statements（去重）+ sql_results（按列数替换规则）
  - [ ] `chart.recommendation` → 存 chart_spec
  - [ ] `synthesis.done` → 反序列化 payload 为 `SynthesisResult`（字段对齐 `moi-core/explore/synthesizer/types.go:19`），遍历 `Blocks`，取 `type=text` 的 `Content` 按顺序拼接为 `content`
  - [ ] 事件 → phase_history 映射表（thinking/planning/querying/answering/done）
  - [ ] `run.error` / `run.completed status=failed` → 写 error
- [ ] **不需要移植前端 `stripJsonWrapper`**，blocks 路径取到的就是最终纯文本

### 1.3 改 `backend/event_processor.go`

- [ ] `EventProcessor` 新增 `aggregator *MessageAggregate` 字段
- [ ] `ProcessEvent` 每次调用前同步 `aggregator.Apply(evt)`
- [ ] 保留原有 chart.recommendation 注入行为

### 1.4 新增 `backend/conversations_handler.go`

- [ ] `ConversationsHandler` 持有 `*ConversationsDB` 和 `*MessagesHandler`（转发 POST messages）
- [ ] **路径解析**：Go `net/http.ServeMux` 无路径变量支持，统一 `strings.TrimPrefix(r.URL.Path, "/api/conversations")` → 按 `/` 拆段：
  - 空段 → `/api/conversations`（列表 / 创建）
  - 单段 `{id}` → `/api/conversations/{id}`（PATCH / DELETE）
  - 双段 `{id}/messages` → 消息子资源
- [ ] 路由分发：
  - [ ] `GET /api/conversations` → `list`
  - [ ] `POST /api/conversations` → `create`
  - [ ] `PATCH /api/conversations/{id}` → `updateTitle`
  - [ ] `DELETE /api/conversations/{id}` → `delete`
  - [ ] `GET /api/conversations/{id}/messages` → `listMessages`
  - [ ] `POST /api/conversations/{id}/messages` → 转给 `MessagesHandler`（见 1.5），透传解析出的 `conversationID`
- [ ] CORS 头复用 `setCORSHeaders`

### 1.5 改 `backend/handler.go`

- [ ] 把 `ChatHandler` 重命名为 `MessagesHandler`（影响面：`main.go:28, 31` + `handler.go:22-23, 38, 182` 共 5 处，grep 确认无外部引用）
- [ ] 删除 `sessionMap` 和 `getOrCreateSession`
- [ ] 新流程（Clarifier 先跑，再写 message 行）：
  1. 从 `ConversationsHandler` 透传接收 `conversationID`
  2. `GetConversation(id)` — 不存在返回 404
  3. 若 `catalog_session_id` 为空 → `CreateSession` → `UpdateCatalogSessionID`
  4. 设置 SSE 头
  5. 跑 `Clarifier.Process(ctx, conversationID, question)`（此时 DB 里不含当前 user message，`RecentUserQuestions` 天然不包含自己）
  6. **反问分支**（`reply != ""`）：
     - 生成 `user_message_id` / `assistant_message_id`
     - `InsertMessage(user, status=done)`
     - `InsertMessage(assistant, content=reply, status=done)`
     - `UpdateTitleIfEmpty(conversationID, question 前 50 字)`
     - `UpdatePendingClarify(conversationID, question)`
     - 推 `message.created` → `synthesis.delta(reply)` → `synthesis.done` → `run.completed`（沿用 `writeClarifySSE` 里的 SSE 模板）
     - return
  7. **合并分支**（`reply == ""`，`finalQuestion` 可能是 merge 后的）：
     - 生成 `user_message_id` / `assistant_message_id`
     - `InsertMessage(user, content=finalQuestion, status=done)`
     - `InsertMessage(assistant, status=pending)`
     - `UpdateTitleIfEmpty(conversationID, finalQuestion 前 50 字)`
     - `UpdatePendingClarify(conversationID, "")`（清空）
     - 推 `message.created` 带两个 id
  8. 调 Catalog Explore → 转发 SSE + `EventProcessor` 同步聚合
  9. `synthesis.done` 之后：`PersistAssistantMessage(aggregator.Finalize())`，推 `message.persisted`
  10. 流中断（`ctx.Err() != nil`）→ 不写 done，assistant message 保持 pending
- [ ] `writeClarifySSE` 保留但不再独立返回，改为内部 helper 被反问分支调用

### 1.6 改 `backend/clarify.go`

- [ ] `Clarifier` 新增 `db *ConversationsDB` 依赖
- [ ] `Process` 参数改为 `conversationID`（不再是前端 sessionID）
- [ ] `pending` 读写走 `db.GetConversation` / `db.UpdatePendingClarify`
- [ ] `history` 用 `db.RecentUserQuestions(conversationID, 5)` — Clarifier 在 handler 流程里**先于 InsertMessage** 调用，天然不包含当前问题，无需额外 exclude
- [ ] 删除 `pending map` / `history map` / `ClearSession` / `RecordExplored`

### 1.7 改 `backend/main.go`

- [ ] 构造 `ConversationsDB`（复用 `feedbackDB.RawDB()`）
- [ ] 构造 `MessagesHandler`（依赖 `ConversationsDB` + `ExploreClient` + `Clarifier`）
- [ ] 构造 `ConversationsHandler`（依赖 `ConversationsDB` + `MessagesHandler`）
- [ ] 删除 `mux.HandleFunc("/api/chat", ...)`
- [ ] 注册 `mux.Handle("/api/conversations", convHandler)` + `mux.Handle("/api/conversations/", convHandler)`

### 1.8 构建 + curl 联调

- [ ] `docker compose build app && docker compose up -d --force-recreate app`
- [ ] `curl -X POST http://localhost:3000/api/conversations` → 拿到 id
- [ ] `curl -X POST http://localhost:3000/api/conversations/{id}/messages -d '{"question":"恒指今年一季度最大跌幅"}'` → 观察 SSE 流
- [ ] 确认首个事件是 `message.created`
- [ ] 确认 `synthesis.done` 之后收到 `message.persisted`
- [ ] `curl http://localhost:3000/api/conversations/{id}/messages` → 返回刚写的 2 条消息
- [ ] 检查 MO：`SELECT * FROM conversations; SELECT * FROM messages;` 数据正确

---

## 阶段 2：前端 API 层 + App / Sidebar

目标：前端会话列表从 API 读写，新建/删除/切换会话走 REST。

### 2.1 新增 `web/src/api/conversations.ts`

- [ ] `listConversations(): Promise<ConversationMeta[]>`
- [ ] `createConversation(): Promise<{id: string}>`
- [ ] `updateConversationTitle(id, title): Promise<void>`
- [ ] `deleteConversation(id): Promise<void>`
- [ ] `listMessages(id): Promise<Message[]>`

### 2.2 改 `web/src/types.ts`

- [ ] `Conversation` 去掉 `sessionId`、`messages` 字段（仅保留 `id, title, createdAt, updatedAt`）
- [ ] 新增 `ConversationMeta`（同上，列表用）
- [ ] `Message` 去掉 `_rawContent`

### 2.3 改 `web/src/App.tsx`

- [ ] 删 `STORAGE_KEY` / `loadConversations` / `saveConversations` / `createConversation`
- [ ] `useState<ConversationMeta[]>` 初始空数组
- [ ] `useEffect(() => listConversations().then(setConversations), [])`
- [ ] `handleNewChat`:保留「回到欢迎页」语义，不立即建会话
- [ ] `handleEnsureConversation`：`createConversation()` → setConversations prepend → return meta
- [ ] `handleDelete`：`deleteConversation(id)` → setConversations filter
- [ ] `handleMessagesChange` / 整个 messages 同步逻辑：**删除**（前端不再持有 messages，ChatPanel 自己管理本地状态）
- [ ] `handleRename`（新增，可选）：PATCH title

### 2.4 改 `web/src/components/Sidebar.tsx`

- [ ] 接口从 `Conversation[]` 改 `ConversationMeta[]`
- [ ] 删 `.filter((c) => c.messages.length > 0)` — 后端不存空会话
- [ ] `sorted` 直接按 `updatedAt DESC`

### 2.5 构建验证

- [ ] `cd web && npm run build`
- [ ] `docker compose build app && docker compose up -d --force-recreate app`
- [ ] 打开页面，新建 → 刷新 → 列表还在
- [ ] 删除 → 刷新 → 列表不包含

---

## 阶段 3：前端 ChatPanel + SSE

目标：消息发送、历史加载、流转统一走后端。

### 3.1 改 `web/src/hooks/useExploreSSE.ts`

- [ ] `send` 参数改为 `(conversationId: string, question: string, tables?: string[])`
- [ ] URL 改为 `/api/conversations/${conversationId}/messages`
- [ ] `handleEvent` 新增 case：
  - [ ] `message.created` → `onMessageCreated(user_message_id, assistant_message_id)`
  - [ ] `message.persisted` → 日志即可（前端不做特殊处理）
- [ ] 接口增加 `onMessageCreated` 回调

### 3.2 改 `web/src/components/ChatPanel.tsx`

- [ ] 删 `sendingRef` / `loadingHistoryRef` / `sessionIdRef` / `prevConvIdRef`
- [ ] 删原有两个 useEffect（messages 同步 + 父通知）
- [ ] 新 useEffect：`conversation?.id` 变化 → `listMessages(id).then(setMessages)`
- [ ] `handleSend`：
  1. 若无 conversation → `onEnsureConversation()` 拿新 id
  2. 乐观插入两条占位消息（client_temp_id）
  3. `send(id, question, tables)`
- [ ] `onMessageCreated` 回调：用服务端 id 替换占位消息的 id，`streamingMsgIdRef` 指向新 assistant_message_id
- [ ] `onUpdate` / `onDone` / `onError` 行为不变
- [ ] **不做前端 title 生成**：后端 `UpdateTitleIfEmpty` 在写 user message 时已同步完成，前端下次 `listConversations` 会拿到新 title

### 3.3 端到端验证

- [ ] 新建会话 → 发消息 → 页面显示完整流式过程
- [ ] 刷新 → 点击该会话 → 历史消息完整显示（含 SQL 结果表格 + 图表）
- [ ] 删除会话 → 刷新 → 没了
- [ ] 两个浏览器标签页同时操作 → 不互相覆盖
- [ ] 反问流程：问一个不完整问题 → 收到反问 → 补充 → 正常返回
- [ ] 刷新后反问上下文仍在（`pending_clarify` 列生效）

---

## 阶段 4：回归测试

- [ ] `python3 scripts/09_accuracy_test.py -c 4` — 预期 19/19 通过
  - **确认过**：该脚本直接打 `CATALOG_URL/api/v1/explore/query/stream`（`scripts/09_accuracy_test.py:35, 174`），绕过后端，本次改造不影响
- [ ] `bash scripts/08_integration_test.sh`
- [ ] 浏览器手工测试：V1 恒指跌幅、V6 营收 YoY、V2 行业市值、反问流程
- [ ] 刷新后手工验证反问上下文仍在（`pending_clarify` 列生效）

---

## 验收标准

- [ ] 前端源码里 `localStorage` 已无 `hk-poc-conversations` 残留
- [ ] 后端源码里 `sessionMap` 已无，`clarify.go` 无 in-memory map
- [ ] MO `hk_sfc` 数据库有 `conversations` + `messages` 两张非空表
- [ ] 重启 backend 容器后，所有历史会话仍可打开
- [ ] accuracy test 19/19 通过
- [ ] 两个浏览器并发无覆盖

---

## 回滚预案

- 本次改动不涉及已有 MO 业务表，只新增两张表
- 如需回滚：切回上一个 git tag，两张新表留着即可（也可以 `DROP TABLE conversations, messages`，**需用户确认**）
- 前端 localStorage 历史已被废弃，无法回填，回滚后用户历史会话丢失——这点需要在上线前与用户确认

## 工作量估算

| 阶段 | 估算 |
|---|---|
| 阶段 1（后端） | 6-8h |
| 阶段 2（前端列表） | 2-3h |
| 阶段 3（前端聊天） | 3-4h |
| 阶段 4（测试） | 1-2h |
| **合计** | **12-17h** |
