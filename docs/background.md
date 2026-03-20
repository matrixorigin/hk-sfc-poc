# HK SFC POC 项目背景

## 项目目标

为**香港证监会(SFC)**做一个 POC，展示通过 AI 对话的方式查询和分析香港股市结构化数据的能力。用户用自然语言提问，系统自动查数据库、计算、生成答案和图表。

## 技术方案

- **数据库**：**MatrixOne**（复用现有实例 16001），将 CSV/XML 数据导入为结构化表
- **Explore 引擎**：独立部署一套 moi-core（Catalog 8082 + Workers），直连 MO
- **前端**：轻量级 Web UI，支持中英双语，支持对话和图表展示
- **可选后端**：如 Explore 引擎无法直接满足需求，增加 Go 薄后端做适配（见下方架构说明）

## 需要支撑的 6 类问题

| # | 场景 | 数据表 | 核心计算 |
|---|------|--------|---------|
| **1** | 指数跌幅>2%时全市场成交量 | `ms_t_stk_hsi` + `ms_t_stk_sis` | 指数日跌幅→筛选交易日→汇总成交量 |
| **2** | 3个市值下降最大的行业(2025.1-6月) | `ms_v_stock_capital` + `ds_t_int_hsicl_dtl` | 行业分类(随时间变)×月末市值→聚合对比 |
| **3** | 收盘价连续10日>50日均线 + 图表 | `ms_t_stk_sis` | 滚动50日MA→连续检测→折线图 |
| **4** | 重大新闻前成交量>30日均值×3 | `ms_t_stk_sis` + `sehknews` | 新闻日关联→成交量异常检测 |
| **5** | CCASS跨券商持仓变动>30% | `ccass_data`(爬虫数据) | T vs T-1 持仓变动 |
| **6** | 股票营收增长(2023-2025) | `profit_loss`(XML→表) | 按裁年汇总Turnover→计算增幅 |
| **7** | 追问/反问（多轮对话） | - | 未指定时间范围时反问；基于上下文追问 |

### 问题详细说明

#### 问题1：市场指数单日跌幅>2%时的全市场总成交量

- 用户须指定日期范围（如近6个月或1个月），若未指定需反问确认
- 跌幅计算：当日收盘指数(CLOSING=1)与前一交易日收盘指数对比
- 不仅展示总成交量，还要展示相关股票名称和跌幅

#### 问题2：哪三个行业总市值下降幅度最大（2025年1月至6月）

- 同一股票在不同时间点的行业归属可能不同，以当月所属行业为准
- 比较基于所选范围的首尾日期（如 2025-01 vs 2025-06 月末市值）
- 市值数据来自 `ms_v_stock_capital`，行业分类来自 `ds_t_int_hsicl_dtl`

#### 问题3：收盘价连续10个交易日高于50日移动均线的股票

- 50日移动均线包含当天（T日 + 前49个交易日的收盘价平均值）
- 用户须指定日期范围
- 输出：股票代码、连续天数、收盘价趋势图（折线图）

#### 问题4：重大新闻公告发布前成交量异常的股票

- 重大新闻定义：typeid in (0, 3, 7, 8, 10, 14, 18, 21, 25, 26, 28, 32)
- 30日平均成交量计算时排除公告日(T日)
- 如新闻发布在非交易日/盘后，使用下一个交易日的成交量
- 输出：公告日期、公告内容、股票代码、股票名称

#### 问题5：CCASS跨券商持仓变动>30%

- 比较 T 日与 T-1 日之间每只股票的每个经纪商持仓变动
- 减少也算变动
- 数据来源：HKEX 公开网页（RPA/爬虫获取，已跑通）

#### 问题6：股票营收增长（2023-2025年）

- 数据源为 profit_loss XML 文件中的 Turnover 字段
- 按 FinYr（裁年）维度分析，裁年类型要对应（如 202512 vs 202312）
- 如有季度/月度数据，同时展示

#### 问题7：基于上下文的追问/反问

- 反问：未指定时间范围时 AI 主动反问
- 追问：如问题1回答后，用户可继续问"那超过3%的呢？"

## 数据源清单

| 数据 | 格式 | 大小 | 导入目标表 |
|------|------|------|-----------|
| WORK_FILTER_FOR_MS_T_STK_HSI_0000.csv | CSV | ~42MB | `ms_t_stk_hsi` |
| WORK_FILTER_FOR_MS_T_STK_SIS.csv | CSV | ~60MB | `ms_t_stk_sis` |
| SFC.MS_V_STOCK_CAPITAL Dummy.csv | CSV | ~55MB | `ms_v_stock_capital` |
| DS_T_INT_HSICL_DTL Dummy.csv | CSV | ~22MB | `ds_t_int_hsicl_dtl` |
| sehknews.csv | CSV | ~29MB | `sehknews` |
| profit_loss/xml/*.xml | XML | ~数百文件 | `profit_loss` |
| financial_ratio/xml/*.xml | XML | 暂不使用 | - |
| CCASS 网页数据 | 爬虫获取 | - | `ccass_data` |

### 表结构元数据

#### ms_t_stk_hsi（恒生指数数据）

| 字段 | 含义 | 类型 |
|------|------|------|
| HSTXDT | 交易日期/快照时间 | Character/Date |
| HSHSI | 恒生指数（主指数） | Numeric |
| HSHSIX | 恒生指数变体 | Numeric |
| HSFIN | 恒生金融分类指数 | Numeric |
| HSFINX | 恒生金融分类指数变体 | Numeric |
| HSUTL | 恒生公用事业分类指数 | Numeric |
| HSUTLX | 恒生公用事业分类指数变体 | Numeric |
| HSPROP | 恒生地产分类指数 | Numeric |
| HSPROPX | 恒生地产分类指数变体 | Numeric |
| HSCANI | 恒生工商业分类指数 | Numeric |
| HSCANIX | 恒生工商业分类指数变体 | Numeric |
| CLOSING | 收盘标志（0=盘中，1=收盘） | Numeric (flag) |

#### ms_t_stk_sis（个股行情数据）

| 字段 | 含义 | 类型 |
|------|------|------|
| SITXDT | 交易日期 | Character/Date |
| SISTKC | 股票代码 | Numeric/Character |
| SISTKN | 股票名称 | Character |
| SIHIGH | 最高价 | Numeric (HKD) |
| SILOW | 最低价 | Numeric (HKD) |
| SICLSE | 收盘价 | Numeric (HKD) |
| SIVOL | 成交量 | Numeric (shares) |

#### ms_v_stock_capital（股票市值数据，月末快照）

| 字段 | 含义 | 类型 |
|------|------|------|
| STKCD | 股票代码（5位零填充） | Character |
| SIRXDT | 月末参考日期 | Character/Date |
| SLCSE | 月末收盘价 | Numeric |
| STTNIS | 已发行股份数 | Numeric |
| SICAP | 市值 (SLCSE × STTNIS) | Numeric |

#### ds_t_int_hsicl_dtl（行业分类数据）

| 字段 | 含义 | 类型 |
|------|------|------|
| STOCK_CODE | 股票代码（5位零填充） | Character |
| MODIFIED_DATE | 行业分类生效日期 | Date |
| INDUSTRY_CODE | 行业分类代码 | Numeric/Character |
| INDUSTRY_NAME | 行业名称 | Character |
| SECTOR_CODE | 板块分类代码（4位） | Character |
| SECTOR_NAME | 板块名称 | Character |

#### sehknews（新闻公告数据）

| 字段 | 含义 | 类型 |
|------|------|------|
| timestamp | 新闻发布时间 | Timestamp |
| securitycode | 证券代码 | Character/Integer |
| typeid | 新闻类型ID | Integer |
| type | 新闻类型描述 | Character |
| text | 新闻内容 | Character |

#### profit_loss（利润表数据，来自 XML）

| 字段 | 含义 | 类型 |
|------|------|------|
| StockCode | 股票代码 | Character |
| CompanyNameEN | 公司英文名 | Character |
| CompanyNameSC | 公司简体中文名 | Character |
| FinYr | 裁年（如 202503） | Character |
| Quarter | 报告类型（Final/Interim） | Character |
| Currency | 币种 | Character |
| Turnover | 营收 | Numeric |
| GrossProfit | 毛利 | Numeric |
| PLBT | 税前利润 | Numeric |
| PLAttrtoShHolder | 归属股东利润 | Numeric |
| EPS | 每股收益 | Numeric |
| ... | 其他财务指标 | ... |

## 前端需求

- 对话界面（类 ChatGPT）
- 中英文双语切换（默认英文）
- 支持中英文与 AI 对话
- 表格结果展示
- 图表展示（折线图等，问题3必需）
- 流式输出（打字机效果）

## 架构方案

### 方案 A：前端直连 Explore（首选，最简）

```
前端 ──→ Catalog API (8082) ──→ Explore 引擎 ──→ MatrixOne
         POST /api/v1/explore/query/stream         ↓
前端 ←── SSE 事件流 ←──────────────────────── LLM 合成答案
```

前端直接调 Catalog 的 Explore HTTP API，无需额外后端。

### 方案 B：加 Go 薄后端做适配（兜底）

```
前端 ──→ Go 后端 (8083) ──→ Catalog API (8082) ──→ Explore 引擎 ──→ MO
              │                                                      ↓
              │ 补充处理:                                      LLM 合成答案
              │ - 预处理问题（注入日期格式提示等）
              │ - 后处理结果（图表数据整理）
              │ - Explore 搞不定时直接执行 SQL
              │ - 会话管理
              │
前端 ←── SSE ←┘
```

**什么时候需要方案 B：**
- Explore 生成的 SQL 无法正确处理非标准日期格式（如 `02JAN2025:09:20:00`）
- 复杂计算逻辑（50日均线、连续天数检测）LLM 写不对 SQL
- 需要对 Explore 结果做二次加工（如图表数据格式化）
- 多轮对话的上下文处理不够精准

### 方案 C：修改 moi-core 代码（必要时）

如果需要从引擎层面解决问题（而非在外层绕过），可能需要改 moi-core：

| 可能的改动点 | 场景 | moi-core 位置 |
|-------------|------|--------------|
| SQL Planner prompt 注入 | 让 LLM 理解非标日期格式 | `explore/planner/planner.go` |
| Schema 注释增强 | 给表/列加业务说明帮助 LLM 写 SQL | `explore/retriever/sql_schema.go` |
| Few-shot 示例 | 给 Explore 提供领域 SQL 示例 | `explore/fewshot/` |
| 合成 prompt 定制 | 控制答案格式（表格、图表标记等） | `explore/synthesizer/prompt.go` |
| SQL 修复策略 | 针对 MO 方言的特殊处理 | `explore/retriever/sql_repair.go` |

**moi-core 代码位置**：`/Users/zhangqq/Documents/pythonProject/matrixflow/moi-core/explore/`

### 推荐路径

**先 A → 测试 → 不行补 B → 极端情况 C**

1. 先用方案 A 快速搭起来，逐个测试 6 类问题
2. 哪个问题 Explore 搞不定，针对性地在 Go 后端加适配逻辑（方案 B）
3. 如果是 Explore 引擎本身的通用能力缺陷，才改 moi-core 代码（方案 C）

## Explore 可能遇到的风险点

| 问题 | 风险 | 应对方案 |
|------|------|---------|
| **日期格式** | HSI/SIS 用 SAS 格式 `02JAN2025:09:20:00`，LLM 可能不认识 | 在 schema comment 里标注格式；或后端预处理问题时注入提示 |
| **CLOSING 标志** | 实际值是 0/9 非文档说的 0/1 | schema comment 标注正确值 |
| **stock_code 不一致** | profit_loss 无零填充 (`1`)，其他表有 (`00001`) | schema comment 标注；或建视图做 LPAD |
| **50日均线计算** | 窗口函数 + 连续天数检测，SQL 复杂 | LLM 可能写不对，需 few-shot 或后端兜底 |
| **跨表日期 JOIN** | 各表日期格式不同，无法直接 JOIN | 可能需要建视图统一日期列 |
| **图表** | Explore 返回文本+表格，不直接生成图表 | 前端根据 SQL 结果数据自行绘图 |
| **反问逻辑** | 用户没给时间范围时 AI 应反问 | Explore 的 synthesizer 可以做到，但需要 prompt 调优 |

## 独立部署环境

```
现有 MatrixOne (16001) ── hk_sfc 库（POC 数据）
       ↑                   moi_poc 库（独立系统库）
POC Catalog (8082) ────┘
  ├── Go Worker
  ├── Python Worker
  └── Explore 引擎 → LLM (qwen3-max via dashscope)
```

配置文件：
- `docker-compose.yaml` — 独立 Catalog + Workers
- `config/catalog.toml` — 连接现有 MO (host.docker.internal:16001)
- `.env` — API Key + Workspace ID
- `scripts/04_init_poc_env.sh` — 一键初始化

## go-sdk 调用示例（方案 B 用）

```go
client, _ := moi.New(endpoint, apiKey)
defer client.Close()

explore := client.Explore()

req := &moi.ExploreRequest{
    Query: moi.QueryDomain{
        Question: "What was the total trading volume on days when HSI dropped by over 2% in the last 6 months?",
    },
    Session: moi.SessionDomain{
        SessionID:   sessionID,
        WorkspaceID: workspaceID,
    },
    DataSources: moi.DataSourceDomain{
        Tables: &moi.TableSource{
            DBName:    "hk_sfc",
            TableList: []string{"ms_t_stk_hsi", "ms_t_stk_sis"},
        },
    },
    Options: moi.ExploreOptions{
        PlanningMode: "sql_only",
    },
}

events, _ := explore.QueryStream(ctx, req)
for event := range events {
    switch event.EventType {
    case moi.EventSynthesisDelta:
        // 流式输出答案片段
    case moi.EventRetrieverSQLResult:
        // SQL 查询结果（表格数据）
    case moi.EventCompleted:
        // 完成
    }
}
```
