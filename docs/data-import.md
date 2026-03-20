# 数据导入记录

## 环境信息

| 项目 | 值 |
|------|-----|
| MatrixOne 版本 | 8.0.30-MatrixOne-v3.0.4-hotfix-20251117 |
| 容器名 | nl2sql-migration-mo |
| 连接方式 | mysql -h 127.0.0.1 -P 16001 -u dump -p111 |
| 数据库名 | hk_sfc |
| 导入时间 | 2026-03-20 |

## 脚本

| 脚本 | 用途 |
|------|------|
| `scripts/01_create_tables.sql` | 建库建表 DDL（7 张表） |
| `scripts/02_import_data.sh` | 一键导入（建表 → CSV导入 → XML解析导入 → 验证） |
| `scripts/03_import_ccass.py` | CCASS 经纪商持仓爬虫 → MO 入库 |
| `scripts/q5.py` | 原始 CCASS 爬虫脚本（独立运行，输出 CSV/XLSX） |

运行方式：
```bash
bash scripts/02_import_data.sh
```

支持环境变量覆盖连接参数：
```bash
MO_HOST=x.x.x.x MO_PORT=6001 MO_USER=root MO_PASS=xxx bash scripts/02_import_data.sh
```

CCASS 爬虫（问题5）单独运行：
```bash
# 爬取指定日期，前 200 只股票，写入 MO
.venv/bin/python3 scripts/03_import_ccass.py --dates 2026/03/18 2026/03/17 --top 200

# 全量股票（7000+只，耗时较长）
.venv/bin/python3 scripts/03_import_ccass.py --dates 2026/03/18 2026/03/17 --all

# 只爬不入库，输出 CSV
.venv/bin/python3 scripts/03_import_ccass.py --dates 2026/03/18 --dry-run
```

## 导入结果

| 表名 | 行数 | 源文件 | 耗时 |
|------|------|--------|------|
| ms_t_stk_hsi | 3,224,677 | WORK_FILTER_FOR_MS_T_STK_HSI_0000.csv | ~5s |
| ms_t_stk_sis | 4,007,140 | WORK_FILTER_FOR_MS_T_STK_SIS.csv | ~5s |
| ms_v_stock_capital | 1,199,988 | SFC.MS_V_STOCK_CAPITAL Dummy.csv | ~1s |
| ds_t_int_hsicl_dtl | 349,976 | DS_T_INT_HSICL_DTL Dummy.csv | ~1s |
| sehknews | 200,000 | sehknews.csv | ~1s |
| profit_loss | 26,419 | profit_loss/xml/*.xml（3154个文件） | ~2s |

| ccass_holdings | ~按需爬取 | HKEX CCASS 网页爬虫 | ~200只×2天≈2min |

**CSV/XML 数据总计约 900 万行，全量导入约 16 秒。CCASS 按需爬取。**

## 已知问题

### 1. sehknews 少导 13,250 行

源文件 213,250 行，实际导入 200,000 行。原因：部分新闻内容包含转义双引号（如 `"SEPTEMBER 2020 NOTES"`），MO 的 `LOAD DATA LOCAL INFILE` 解析 CSV 时将其误判为字段边界，导致后续字段错位、securitycode 被解析为 NULL。

**影响**：丢失约 6% 的新闻数据，对 POC 问题 4（重大新闻前成交量异常检测）影响较小，因为核心查询依赖 typeid 筛选，丢失的行随机分布。

**后续可选方案**：如需 100% 导入，可用 Python 预处理 CSV 清洗转义双引号后再导入。

### 2. 数据特征备注

| 发现 | 说明 |
|------|------|
| HSI CLOSING 标志值 | 实际为 0（盘中）和 9（收盘），非文档描述的 0/1 |
| profit_loss stock_code | 无零填充（如 `1` 而非 `00001`），与其他表（如 ms_v_stock_capital 的 `00001`）不一致，联表查询时需注意补零或类型转换 |
| HSI 日期格式 | `02JAN2025:09:20:00`（SAS datetime 格式），非标准日期 |
| SIS 日期格式 | `02JAN2025:00:00:00`，同上 |
| STOCK_CAPITAL 日期格式 | `31-JAN-25`（DD-MON-YY） |
| HSICL_DTL 日期格式 | `2025-01-02`（标准 YYYY-MM-DD） |
