# Conversations Backend Storage — Design

## 背景

当前会话/消息历史存储在前端 `localStorage['hk-poc-conversations']`（`web/src/App.tsx:12-25`），包含：

- 全量会话列表 + 每条 message 的完整内容
- `sqlResults`（可能 10KB~1MB / 条）、`chartSpec`、`phaseHistory`
- 后端 `handler.go:28` 只在 in-memory map 里维护「前端 UUID → Catalog 数字 sessionID」映射，**无持久化**
- Clarifier 的 `pending` / `history` 也是 in-memory map（`backend/clarify.go:87-88`）

用户反馈存在异常。怀疑根因：

1. **localStorage 5MB 上限**：单条消息带 SQL 结果容易几百 KB，多会话累积后写入会**静默失败**，历史错乱或丢失
2. **schema 漂移**：近期改了 `chartSpec` 字段结构，旧数据反序列化报错
3. **跨标签页并发写**：同一 key 互相覆盖
4. **后端重启丢失 session 映射**：所有 Catalog 会话上下文中断
5. **ChatPanel useEffect 同步体操**（`sendingRef` / `loadingHistoryRef`）—— 前端既是 source of truth 又要响应 props，同步 bug 温床

## 第一性原理

- 会话与消息是**用户数据**，source of truth 必须在服务端
- 前端是视图层，应当无状态，启动时 fetch，不持久化
- SSE 是实时传输通道，不是存储
- 服务端自己聚合 SSE 事件 → 持久化，前端加载历史时完全信任服务端数据

## 总体设计

```
                  ┌────────────────────┐
                  │  React Frontend    │
                  │  (无 localStorage)  │
                  └──────┬─────────────┘
                         │ REST / SSE
                  ┌──────▼─────────────┐
                  │   Go Backend       │
                  │  ┌──────────────┐  │
                  │  │ConversationsDB│◄─┤── MatrixOne (workspace account)
                  │  ├──────────────┤  │    ├─ conversations
                  │  │Aggregator    │  │    └─ messages
                  │  └──────────────┘  │
                  └──────┬─────────────┘
                         │ SSE
                  ┌──────▼─────────────┐
                  │  Catalog Explore   │
                  └────────────────────┘
```

### 核心决策

| 决策 | 选项 | 结论 | 理由 |
|---|---|---|---|
| 存储后端 | SQLite / MO / 外挂 | **MO 复用** | `feedbackdb.go` 已连好同一 MO workspace account；新表放同 DB，零新依赖零新 volume |
| ID 归属 | 前端 UUID / 后端生成 | **后端生成** | 避免前端造 ID 导致的乐观 / 权威冲突 |
| Session 双 ID | 前端 UUID + catalog 数字 | **合并成一个** | `conversations.id` 作为唯一外部 ID，`catalog_session_id` 仅存在行里 |
| 流中断语义 | 补偿 / 标灰 | **标灰** | status=pending 不补偿，下次加载能看到"中断"状态，用户自行删除或重发 |
| 迁移 | 导入旧 localStorage / 丢弃 | **丢弃** | 不兼容实现，前端刷新即空列表 |
| Catalog session 生命周期 | 级联删 / 不管 | **不管** | 当前代码无 DELETE 调用，Catalog 自己管理 orphan |
| Clarifier 状态 | 保留内存 / 迁 DB | **迁 DB** | `history` 从 `messages` 表查最近 5 条 role=user 即可，`pending` 放 `conversations.pending_clarify` 列 |

## 数据模型

```sql
CREATE TABLE conversations (
    id                 VARCHAR(64) PRIMARY KEY,     -- UUID，后端生成
    title              VARCHAR(255) NOT NULL DEFAULT '',
    catalog_session_id VARCHAR(64),                  -- Catalog llm/sessions ID
    pending_clarify    TEXT,                         -- 反问待合并的原问题
    created_at         BIGINT NOT NULL,              -- unix ms
    updated_at         BIGINT NOT NULL
);

CREATE TABLE messages (
    id                VARCHAR(64) PRIMARY KEY,       -- UUID，后端生成
    conversation_id   VARCHAR(64) NOT NULL,
    role              VARCHAR(16) NOT NULL,          -- user | assistant
    content           TEXT,
    sql_statements    TEXT,                           -- JSON array
    sql_results       TEXT,                           -- JSON array of SQLResult
    chart_spec        TEXT,                           -- JSON
    phase_history     TEXT,                           -- JSON array of Phase
    error             TEXT,
    feedback_question TEXT,
    status            VARCHAR(16) NOT NULL,           -- pending | done | failed
    seq               INT NOT NULL,                   -- 会话内顺序
    created_at        BIGINT NOT NULL
);
```

JSON 列选择 `TEXT` 而非分列，理由：

- SQL 结果结构不固定（columns/rows 二维数组），拆表反而复杂
- 查询只按 `conversation_id + seq` 检索，不对 JSON 内容做过滤
- MO 3.0.8 对 JSON 原生类型支持不完整，用 TEXT 存 JSON 字符串最稳

不建索引（MO 3.0.8 的普通 index 语法不保，先不加；实际 POC 量级 `WHERE conversation_id = ? ORDER BY seq` 全表扫也够快）。

## API

| 方法 | 路径 | 作用 | Body / 响应 |
|---|---|---|---|
| GET | `/api/conversations` | 列表 | `[{id, title, updated_at}]`，按 `updated_at DESC` |
| POST | `/api/conversations` | 创建空会话 | 响应 `{id}` |
| PATCH | `/api/conversations/{id}` | 改 title | body `{title}` |
| DELETE | `/api/conversations/{id}` | 级联删 messages | — |
| GET | `/api/conversations/{id}/messages` | 拉历史 | `[{...Message}]` |
| POST | `/api/conversations/{id}/messages` | 发消息 | body `{question, tables?}`，返回 SSE |

旧 `POST /api/chat` 路由**彻底废除**。

### POST messages 事件流

上游 Catalog 事件外，增补两个自研事件：

**`message.created`**（转发之前最先发出）

```json
{
  "event": "message.created",
  "data": {
    "user_message_id": "uuid-a",
    "assistant_message_id": "uuid-b"
  }
}
```

**`message.persisted`**（`synthesis.done` 之后，落库后发出）

```json
{
  "event": "message.persisted",
  "data": {
    "assistant_message_id": "uuid-b",
    "status": "done"
  }
}
```

其余事件原样透传，保持前端 `useExploreSSE.ts` 的 switch 分支兼容。

### 处理流程（含反问分支）

```
1. 解析 URL path 拿 conversation_id
2. GetConversation(id)，不存在 → 404
3. 若 catalog_session_id 为空 → CreateSession → UpdateCatalogSessionID
4. 设置 SSE 头
5. 先跑 Clarifier（此时 DB 里还没有当前 user message，history 天然不包含自己）
   ├─ 反问分支（参数不全）
   │   a. 生成 user_message_id + assistant_message_id
   │   b. 写 user message（status=done）+ assistant message（content=反问文本, status=done）
   │   c. 若 conversations.title 为空，同一事务内 UPDATE title = substring(question, 1, 50)
   │   d. UpdatePendingClarify 记原问题
   │   e. 推 message.created → synthesis.delta(反问) → synthesis.done → run.completed
   │   f. 返回
   └─ 合并分支（追问 merge 后 or 参数齐全）
       a. 生成 user_message_id + assistant_message_id
       b. 写 user message（status=done）+ assistant message（status=pending）
       c. 若 conversations.title 为空 → UPDATE title
       d. 清 pending_clarify（合并分支）
       e. 推 message.created
       f. 调 Catalog Explore SSE → 转发 + Aggregator 同步聚合
       g. synthesis.done 后：PersistAssistantMessage 落库（status=done）→ 推 message.persisted
       h. 流中断（ctx cancel）→ 不落库，assistant message 保持 pending
```

关键点：**Clarifier 先跑，再写任何 message 行**。这保证 `RecentUserQuestions` 不会把当前问题算进历史，追问判断语义正确。

### 并发假设

POC 单用户单标签页。**不处理同一会话在两个标签页并发发送的场景** —— 后端不加 per-conversation 锁，并发时可能出现 seq 冲突（实际用 `time.Now().UnixNano()` 几乎不会撞）或 SSE 流交叉显示。不同会话并发无冲突。

`pending` 消息永久保留，由用户手动删除会话清理，不做定时 GC。

## 后端聚合器（message_aggregator.go）

`EventProcessor` 内嵌 Aggregator，转发 SSE 的同时把字段聚进内存，`synthesis.done` 后由 handler 调用 `Finalize()` 落库。

收集规则：

| 字段 | 来源 |
|---|---|
| `content` | `synthesis.done` 的 payload 是 `SynthesisResult`（`moi-core/explore/synthesizer/types.go:19`），遍历 `blocks[]` 取 `type=text` 的 block，按顺序拼接 `content` 字段 |
| `sql_statements` | 每次 `sql.result` 的 `data.sql`，去重 append |
| `sql_results` | 每次 `sql.result` 的 `{columns, rows, sql, total_count, round_index}`，沿用前端 dedup 规则（列数多的替换列数少的） |
| `chart_spec` | `chart.recommendation` 事件 data（后端自己注入，直接存） |
| `phase_history` | 按事件类型映射 `thinking / planning / querying / answering / done`，去重 append |
| `error` | `run.error` 或 `run.completed` status=failed 时的 message |
| `status` | `synthesis.done` → done；`run.error (recoverable=false)` → failed；context cancel → 保持 pending |

**流式展示照旧走 delta**（live 体验不变），落库走 blocks 只影响「done 后持久化取什么」。

**为什么落库不走 delta 累计**：`synthesis.delta` 流出的是 LLM 原始 JSON 输出（`{"answer": "..."}`），前端 `stripJsonWrapper` 是实时剥壳的临时逻辑（处理增量 / 截断续写）。`SynthesisResult.Blocks[type=text].Content` 是 synthesizer 自己 parse 完 JSON 后的最终纯文本（`moi-core/explore/synthesizer/synthesizer.go:87` 的 `buildResult`，已经处理了 `appendContinuationIfTruncated`）。两条路径最终文本应当等价，但后端走 blocks 意味着：
- 不用把 stripJsonWrapper 的字符串处理搬到 Go
- 不用关心 delta 增量拼接 / 截断续写 / 转义恢复
- 前端加载历史时 `msg.content` 直接是干净文本，不需要再跑 stripJsonWrapper

简言之：**后端要的是最终态，synthesizer 已经算好了，拿就是了**。

## 前端改造

### 删除

- `App.tsx` 的 `STORAGE_KEY` / `loadConversations` / `saveConversations` / `createConversation`
- `ChatPanel.tsx` 的 `sendingRef` / `loadingHistoryRef` / 两个 useEffect 同步体操
- `Sidebar.tsx` 的 `.filter((c) => c.messages.length > 0)`（后端不存空会话，语义天然正确）
- 前端 `uuidv4()` 造 message id 的全部调用
- `types.ts::Message._rawContent`（前端不再做 delta 聚合时就不需要）
- `types.ts::Conversation.sessionId`（合并进 `id`）、`Conversation.messages`（独立 fetch）

### 新增

- `web/src/api/conversations.ts` — 5 个 REST 端点的 fetch 封装
- `useExploreSSE.ts` 新增两个 case：`message.created`（拿到服务端 id → 更新占位消息）、`message.persisted`（置 `isStreaming=false`）

### 会话切换流程

```
用户点击会话 → App 调用 GET /api/conversations/:id/messages
            → setMessages 全量替换
            → ChatPanel 直接渲染（无 useEffect 同步）
```

### 发消息流程

```
用户输入 → ChatPanel 乐观插入 user（client_temp_id） + assistant（client_temp_id，isStreaming）
       → POST /api/conversations/:id/messages (SSE)
       → 收到 message.created → 用服务端 id 替换两条占位消息
       → 收到 sql.result / synthesis.delta / chart.recommendation → 更新 assistant 本地态
       → 收到 synthesis.done → isStreaming=false
       → 收到 message.persisted → 标记已持久化（前端仅作 debug 信号用）
```

## 风险与对策

| 风险 | 对策 |
|---|---|
| MO 3.0.8 对 `TEXT` 字段的实际上限未验证 | 动手前先查 MO 文档或用大 payload 试写；极端情况下单条 `sql_results` 超限时，聚合前截断（保最多 200 行） |
| 流中断后 pending 行堆积 | 前端列表显示灰态即可，不做 GC；加载时正常返回，用户自行删除 |
| POST 端点同时要返回 SSE 和写 DB | Handler 写完 user+assistant（反问分支一次写完/合并分支 pending）→ 推 `message.created` → 转发 SSE + Aggregator 聚合 → `synthesis.done` 后同步落库再推 `message.persisted` |
| 后端聚合内容与上游事件顺序耦合 | Aggregator 做成纯函数风格，每个 case 独立，不依赖事件顺序 |
| 旧 `/api/chat` 路由被前端 fallback 请求 | 直接删除，前端编译期即可发现依赖 |
| Go `net/http.ServeMux` 不支持路径变量 | 注册 `/api/conversations/` 前缀，handler 内用 `strings.TrimPrefix` + `strings.Split` 手动解析 `{id}` 和尾段（messages 子路径） |

## 不在本次范围

- 全文搜索 / 按 title 过滤
- 多用户 / 登录鉴权（POC 目前单租户）
- 会话导出 / 分享
- Catalog session 级联删除（orphan 无害，未来再考虑）
- 历史数据从 localStorage 导入（显式丢弃）
