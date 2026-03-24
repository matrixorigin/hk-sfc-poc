# 语义知识库配置说明

## 概述

通过 moi-core 的 nl2sql-knowledge API 配置语义知识，注入到 Explore 引擎的 SQL 生成 prompt 中，帮助 LLM 理解数据模型并生成正确的 SQL。

Knowledge Base ID: `10001` (name: hk-sfc-semantic)

## 配置脚本

`scripts/07_configure_knowledge.sh` — 幂等执行，先删旧条目再重建。

## 设计原则

1. **描述数据，不指令化** — 告诉 LLM "HSI 表每天有 11000 条盘中记录"，而不是 "你必须加 WHERE CLOSING=9"
2. **分层组织** — Glossary 定义术语，Logic 描述数据特征和表间关系，Synonyms 做中英文映射
3. **关联表** — 每条知识通过 `associate_tables` 关联相关表，Explore 只在涉及相关表时注入

## 配置清单

### Glossary（术语定义）— 4 条

| key | 关联表 | 说明 |
|-----|--------|------|
| closing_field | ms_t_stk_hsi | CLOSING 字段含义：0=盘中快照，9=收盘记录 |
| material_news_definition | sehknews | 重大新闻定义：typeid IN (0,3,7,8,10,14,18,21,25,26,28,32) |
| fin_yr_format | profit_loss | 裁年格式：YYYYMM，如 202503 = 截至2025年3月的财年 |
| trade_date_column | ms_t_stk_hsi, ms_t_stk_sis, ms_v_stock_capital | 标准 DATE 列说明 |

### Logic（数据模型特征）— 5 条

| key | 关联表 | 说明 |
|-----|--------|------|
| hsi_data_granularity | ms_t_stk_hsi | HSI 每天约 11000 条盘中快照，仅 1 条 CLOSING=9 为收盘记录 |
| sis_data_granularity | ms_t_stk_sis | SIS 每只股票每天 1 条 |
| industry_classification_model | ds_t_int_hsicl_dtl | 只记录变更，Carry Forward 逻辑 |
| stock_capital_granularity | ms_v_stock_capital | 每只股票每月末 1 条 |
| profit_loss_stock_code_format | profit_loss | stock_code 无零填充 |

### Logic（表间关系）— 4 条

| key | 关联表 | 说明 |
|-----|--------|------|
| hsi_sis_relationship | ms_t_stk_hsi, ms_t_stk_sis | HSI 和 SIS 通过 trade_date 关联，HSI 必须先过滤到日级别再 JOIN |
| capital_industry_relationship | ms_v_stock_capital, ds_t_int_hsicl_dtl | 市值与行业通过 STKCD=STOCK_CODE 关联 |
| news_trading_relationship | sehknews, ms_t_stk_sis | 新闻与行情通过 securitycode=SISTKC + 日期关联 |
| ccass_comparison_model | ccass_holdings | CCASS 跨日对比通过 self-join on stock_code + participant_id |
| sql_dialect_constraints | 全部 7 张表 | MO SQL 限制：窗口函数不能在 WHERE 里、JOIN 不能用子查询、标量子查询不支持非等值聚合 |

### Synonyms（同义词）— 5 条

| key | 关联表 | 词汇 |
|-----|--------|------|
| volume_synonyms | ms_t_stk_sis | trading volume, 成交量, SIVOL |
| market_cap_synonyms | ms_v_stock_capital | market cap, 总市值, SICAP |
| revenue_synonyms | profit_loss | revenue, turnover, 营收 |
| hsi_synonyms | ms_t_stk_hsi | HSI, 恒生指数, HSHSI |
| price_synonyms | ms_t_stk_sis | closing price, 收盘价, SICLSE |

## 变更历史

### v3 (2026-03-24)
- 更新 fin_yr_format：明确不同公司裁年月份不同，不能假设 12 月
- 新增 sql_dialect_constraints：描述 MO SQL 方言限制（窗口函数不能在 WHERE、JOIN 不支持子查询等）
- 总计 19 条（glossary 4 + logic 10 + synonyms 5）

### v2 (2026-03-24)
- 重新组织：从"指令式"改为"描述式"
- 新增 hsi_data_granularity：描述 HSI 每天 11000 条盘中快照，解决 JOIN 爆炸问题
- 新增 hsi_sis_relationship：明确 HSI-SIS JOIN 的数据量风险
- 去掉了所有 SQL 指令（如"MUST filter WHERE CLOSING=9"），改为描述数据特征让 LLM 自行推导

### v1 (2026-03-23)
- 初始配置 16 条
- 问题：指令式写法，混合了 SQL 写法和数据描述
- 问题：knowledge_bases 参数导致 planner 误判为 mixed intent（已通过 moi-core 修复）
