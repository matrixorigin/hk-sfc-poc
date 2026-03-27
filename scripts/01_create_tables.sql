-- HK SFC POC - 建库建表脚本
-- MatrixOne 兼容 MySQL 语法

CREATE DATABASE IF NOT EXISTS hk_sfc;
USE hk_sfc;

-- ============================================================
-- 1. 恒生指数数据（HSI）
--    源文件: WORK_FILTER_FOR_MS_T_STK_HSI_0000.csv
--    日期格式: 02JAN2025:09:20:00
-- ============================================================
DROP TABLE IF EXISTS ms_t_stk_hsi;
CREATE TABLE ms_t_stk_hsi (
    HSTXDT   VARCHAR(24)    NOT NULL COMMENT 'Snapshot datetime. Format: DDMONYYYY:HH:MI:SS (e.g. 02JAN2025:09:20:00).',
    HSHSI    DECIMAL(16,4)  NULL     COMMENT 'Hang Seng Index (HSI) main index value in points.',
    HSHSIX   DECIMAL(16,4)  NULL     COMMENT 'HSI extended/composite variant.',
    HSFIN    DECIMAL(16,4)  NULL     COMMENT 'Hang Seng Finance Sub-index.',
    HSFINX   DECIMAL(16,4)  NULL     COMMENT 'Finance Sub-index variant.',
    HSUTL    DECIMAL(16,4)  NULL     COMMENT 'Hang Seng Utilities Sub-index.',
    HSUTLX   DECIMAL(16,4)  NULL     COMMENT 'Utilities Sub-index variant.',
    HSPROP   DECIMAL(16,4)  NULL     COMMENT 'Hang Seng Properties Sub-index.',
    HSPROPX  DECIMAL(16,4)  NULL     COMMENT 'Properties Sub-index variant.',
    HSCANI   DECIMAL(16,4)  NULL     COMMENT 'Hang Seng Commerce & Industry Sub-index.',
    HSCANIX  DECIMAL(16,4)  NULL     COMMENT 'Commerce & Industry Sub-index variant.',
    CLOSING  TINYINT        NULL     COMMENT 'Record type: 0=intraday tick (~11000 rows/day), 9=daily closing (1 row/day). For any daily-level analysis, MUST filter WHERE CLOSING = 9.',
    trade_date DATE          NULL     COMMENT 'Trading date (standardized from HSTXDT). Use this column for date filtering and comparison.'
);

-- ============================================================
-- 2. 个股行情数据（SIS）
--    源文件: WORK_FILTER_FOR_MS_T_STK_SIS.csv
--    日期格式: 02JAN2025:00:00:00
-- ============================================================
DROP TABLE IF EXISTS ms_t_stk_sis;
CREATE TABLE ms_t_stk_sis (
    SITXDT  VARCHAR(24)    NOT NULL COMMENT 'Trading date. Format: DDMONYYYY:HH:MI:SS (e.g. 02JAN2025:00:00:00).',
    SISTKC  VARCHAR(10)    NOT NULL COMMENT 'HKEX stock code (e.g. 00001, 00005).',
    SISTKN  VARCHAR(100)   NULL     COMMENT 'Stock name / company name in English.',
    SIHIGH  DECIMAL(16,4)  NULL     COMMENT 'Highest traded price of the day (HKD).',
    SILOW   DECIMAL(16,4)  NULL     COMMENT 'Lowest traded price of the day (HKD).',
    SICLSE  DECIMAL(16,4)  NULL     COMMENT 'Closing price of the day (HKD).',
    SIVOL   BIGINT         NULL     COMMENT 'Trading volume in number of shares traded.',
    trade_date DATE          NULL     COMMENT 'Trading date (standardized from SITXDT). Use this column for date filtering, JOIN, and window functions.',
    ma_20   DECIMAL(16,4)  NULL     COMMENT '20-day moving average of closing price. Pre-computed.',
    ma_50   DECIMAL(16,4)  NULL     COMMENT '50-day moving average of closing price. Pre-computed.',
    ma_100  DECIMAL(16,4)  NULL     COMMENT '100-day moving average of closing price. Pre-computed.',
    consecutive_above_ma50 INT NULL  COMMENT 'Number of consecutive trading days the closing price has been above the 50-day moving average (ma_50), as of this date. Pre-computed.',
    avg_vol_30d BIGINT     NULL     COMMENT '30-day average trading volume. Pre-computed. Use this column to detect volume anomalies (e.g. SIVOL > avg_vol_30d * 3) instead of correlated subqueries.'
);

-- ============================================================
-- 3. 股票市值数据（月末快照）
--    源文件: SFC.MS_V_STOCK_CAPITAL Dummy.csv
--    日期格式: 31-JAN-25
-- ============================================================
DROP TABLE IF EXISTS ms_v_stock_capital;
CREATE TABLE ms_v_stock_capital (
    STKCD   VARCHAR(10)      NOT NULL COMMENT 'Stock code, 5-digit zero-padded (e.g. 00001).',
    SIRXDT  VARCHAR(20)      NOT NULL COMMENT 'Month-end reference date. Format: DD-MON-YY (e.g. 31-JAN-25).',
    SLCSE   DECIMAL(16,4)    NULL     COMMENT 'Closing share price at month-end (HKD).',
    STTNIS  BIGINT           NULL     COMMENT 'Total shares in issue (outstanding).',
    SICAP   DECIMAL(24,4)    NULL     COMMENT 'Market capitalization = SLCSE * STTNIS.',
    ref_date DATE             NULL     COMMENT 'Month-end reference date (standardized from SIRXDT). Use this column for date filtering and comparison.'
);

-- ============================================================
-- 4. 行业分类数据
--    源文件: DS_T_INT_HSICL_DTL Dummy.csv
--    日期格式: 2025-01-02
-- ============================================================
DROP TABLE IF EXISTS ds_t_int_hsicl_dtl;
CREATE TABLE ds_t_int_hsicl_dtl (
    STOCK_CODE     VARCHAR(10)   NOT NULL COMMENT 'Stock code, 5-digit zero-padded (e.g. 00001).',
    MODIFIED_DATE  VARCHAR(20)   NOT NULL COMMENT 'Effective date of this classification (YYYY-MM-DD).',
    INDUSTRY_CODE  VARCHAR(10)   NULL     COMMENT 'Industry classification code.',
    INDUSTRY_NAME  VARCHAR(100)  NULL     COMMENT 'Industry name (e.g. Information Technology, Energy, Healthcare).',
    SECTOR_CODE    VARCHAR(10)   NULL     COMMENT 'Sector code within industry (4-digit).',
    SECTOR_NAME    VARCHAR(100)  NULL     COMMENT 'Sector name (e.g. Software & Services, Oil & Gas).'
);

-- ============================================================
-- 5. 新闻公告数据
--    源文件: sehknews.csv
--    注意: CSV 字段有双引号包裹
-- ============================================================
DROP TABLE IF EXISTS sehknews;
CREATE TABLE sehknews (
    `timestamp`    VARCHAR(30)   NULL COMMENT 'Publication datetime (e.g. 2025-01-02 18:44:37).',
    securitycode   VARCHAR(10)   NULL COMMENT 'Stock code the news relates to.',
    typeid         INT           NULL     COMMENT 'News category ID.',
    `type`         VARCHAR(200)  NULL     COMMENT 'News category description.',
    `text`         TEXT          NULL     COMMENT 'News headline or content.',
    trade_date     DATE          NULL     COMMENT 'Nearest trading day on or after the news timestamp. Pre-computed from ms_t_stk_sis. Use this column to JOIN with ms_t_stk_sis.trade_date instead of converting timestamp.'
);

-- ============================================================
-- 6. 利润表数据（从 XML 解析后导入）
--    源文件: profit_loss/xml/*.xml
-- ============================================================
DROP TABLE IF EXISTS profit_loss;
CREATE TABLE profit_loss (
    stock_code        VARCHAR(10)    NOT NULL COMMENT 'Stock code (not zero-padded, e.g. 1 instead of 00001).',
    company_name_en   VARCHAR(200)   NULL     COMMENT 'Company name in English.',
    company_name_sc   VARCHAR(200)   NULL     COMMENT 'Company name in Simplified Chinese.',
    company_name_tc   VARCHAR(200)   NULL     COMMENT 'Company name in Traditional Chinese.',
    fin_yr            VARCHAR(10)    NOT NULL COMMENT 'Financial year end in YYYYMM format (e.g. 202503 = FY ending March 2025).',
    quarter           VARCHAR(20)    NULL     COMMENT 'Report type: Final = full year, Interim = half year.',
    currency          VARCHAR(10)    NULL     COMMENT 'Reporting currency.',
    turnover          DECIMAL(20,2)  NULL     COMMENT 'Revenue / Turnover.',
    cost_of_sales     DECIMAL(20,2)  NULL     COMMENT 'Cost of sales.',
    gross_profit      DECIMAL(20,2)  NULL     COMMENT 'Gross profit.',
    plbt              DECIMAL(20,2)  NULL     COMMENT 'Profit/Loss before taxation.',
    taxation          DECIMAL(20,2)  NULL     COMMENT 'Tax expense.',
    pl_attr_to_shareholder DECIMAL(20,2) NULL COMMENT 'Net profit attributable to shareholders.',
    net_financial_costs    DECIMAL(20,2) NULL COMMENT 'Net finance costs.',
    deprec_amort      DECIMAL(20,2)  NULL     COMMENT 'Depreciation and amortization.',
    eps               DECIMAL(16,6)  NULL     COMMENT 'Earnings per share.',
    dps               DECIMAL(16,6)  NULL     COMMENT 'Dividends per share.',
    nbv_per_share     DECIMAL(16,6)  NULL     COMMENT 'Net book value per share.'
);

-- ============================================================
-- 7. CCASS 经纪商持仓数据（爬虫获取）
--    源: https://www3.hkexnews.hk/sdw/search/searchsdw.aspx
-- ============================================================
DROP TABLE IF EXISTS ccass_holdings;
CREATE TABLE ccass_holdings (
    holding_date    DATE           NOT NULL COMMENT 'Shareholding date.',
    stock_code      VARCHAR(10)    NOT NULL COMMENT 'Stock code (e.g. 00001).',
    stock_name      VARCHAR(200)   NULL     COMMENT 'Stock name.',
    participant_id  VARCHAR(20)    NOT NULL COMMENT 'CCASS participant (broker) ID, starts with B.',
    shareholding    BIGINT         NOT NULL COMMENT 'Number of shares held by this broker.'
);
