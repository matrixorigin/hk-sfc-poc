-- HK SFC POC - 表注释和列注释（纯数据描述，不含业务逻辑）
-- 用法: mysql -h ... -u ... -p... hk_sfc < scripts/05_update_comments.sql

-- ============================================================
-- 1. ms_t_stk_hsi - Hang Seng Index snapshots
-- ============================================================
ALTER TABLE ms_t_stk_hsi COMMENT='Hang Seng Index (HSI) and sector sub-index snapshots. Multiple intraday records per day plus one closing record per day.';

ALTER TABLE ms_t_stk_hsi MODIFY COLUMN HSTXDT VARCHAR(24) COMMENT 'Snapshot datetime. Format: DDMONYYYY:HH:MI:SS (e.g. 02JAN2025:09:20:00).';
ALTER TABLE ms_t_stk_hsi MODIFY COLUMN HSHSI DECIMAL(16,4) NULL COMMENT 'Hang Seng Index (HSI) main index value in points.';
ALTER TABLE ms_t_stk_hsi MODIFY COLUMN HSHSIX DECIMAL(16,4) NULL COMMENT 'HSI extended/composite variant.';
ALTER TABLE ms_t_stk_hsi MODIFY COLUMN HSFIN DECIMAL(16,4) NULL COMMENT 'Hang Seng Finance Sub-index.';
ALTER TABLE ms_t_stk_hsi MODIFY COLUMN HSFINX DECIMAL(16,4) NULL COMMENT 'Finance Sub-index variant.';
ALTER TABLE ms_t_stk_hsi MODIFY COLUMN HSUTL DECIMAL(16,4) NULL COMMENT 'Hang Seng Utilities Sub-index.';
ALTER TABLE ms_t_stk_hsi MODIFY COLUMN HSUTLX DECIMAL(16,4) NULL COMMENT 'Utilities Sub-index variant.';
ALTER TABLE ms_t_stk_hsi MODIFY COLUMN HSPROP DECIMAL(16,4) NULL COMMENT 'Hang Seng Properties Sub-index.';
ALTER TABLE ms_t_stk_hsi MODIFY COLUMN HSPROPX DECIMAL(16,4) NULL COMMENT 'Properties Sub-index variant.';
ALTER TABLE ms_t_stk_hsi MODIFY COLUMN HSCANI DECIMAL(16,4) NULL COMMENT 'Hang Seng Commerce & Industry Sub-index.';
ALTER TABLE ms_t_stk_hsi MODIFY COLUMN HSCANIX DECIMAL(16,4) NULL COMMENT 'Commerce & Industry Sub-index variant.';
ALTER TABLE ms_t_stk_hsi MODIFY COLUMN CLOSING TINYINT NULL COMMENT 'Record type flag. 0=intraday snapshot, 9=end-of-day closing record.';

-- ============================================================
-- 2. ms_t_stk_sis - Individual stock daily trading data
-- ============================================================
ALTER TABLE ms_t_stk_sis COMMENT='Daily trading data for individual stocks on HKEX. One record per stock per trading day. Contains price and volume data.';

ALTER TABLE ms_t_stk_sis MODIFY COLUMN SITXDT VARCHAR(24) COMMENT 'Trading date. Format: DDMONYYYY:HH:MI:SS (e.g. 02JAN2025:00:00:00).';
ALTER TABLE ms_t_stk_sis MODIFY COLUMN SISTKC VARCHAR(10) COMMENT 'HKEX stock code (e.g. 00001, 00005).';
ALTER TABLE ms_t_stk_sis MODIFY COLUMN SISTKN VARCHAR(100) NULL COMMENT 'Stock name / company name in English.';
ALTER TABLE ms_t_stk_sis MODIFY COLUMN SIHIGH DECIMAL(16,4) NULL COMMENT 'Highest traded price of the day (HKD).';
ALTER TABLE ms_t_stk_sis MODIFY COLUMN SILOW DECIMAL(16,4) NULL COMMENT 'Lowest traded price of the day (HKD).';
ALTER TABLE ms_t_stk_sis MODIFY COLUMN SICLSE DECIMAL(16,4) NULL COMMENT 'Closing price of the day (HKD).';
ALTER TABLE ms_t_stk_sis MODIFY COLUMN SIVOL BIGINT NULL COMMENT 'Trading volume in number of shares traded.';

-- ============================================================
-- 3. ms_v_stock_capital - Monthly market capitalization
-- ============================================================
ALTER TABLE ms_v_stock_capital COMMENT='Month-end market capitalization for all stocks. One record per stock per month (12 months in 2025).';

ALTER TABLE ms_v_stock_capital MODIFY COLUMN STKCD VARCHAR(10) COMMENT 'Stock code, 5-digit zero-padded (e.g. 00001).';
ALTER TABLE ms_v_stock_capital MODIFY COLUMN SIRXDT VARCHAR(20) COMMENT 'Month-end reference date. Format: DD-MON-YY (e.g. 31-JAN-25).';
ALTER TABLE ms_v_stock_capital MODIFY COLUMN SLCSE DECIMAL(16,4) NULL COMMENT 'Closing share price at month-end (HKD).';
ALTER TABLE ms_v_stock_capital MODIFY COLUMN STTNIS BIGINT NULL COMMENT 'Total shares in issue (outstanding).';
ALTER TABLE ms_v_stock_capital MODIFY COLUMN SICAP DECIMAL(24,4) NULL COMMENT 'Market capitalization = SLCSE * STTNIS.';

-- ============================================================
-- 4. ds_t_int_hsicl_dtl - Industry/sector classification
-- ============================================================
ALTER TABLE ds_t_int_hsicl_dtl COMMENT='Industry and sector classification for stocks. Records classification changes only (not monthly snapshots). A stock retains its most recent classification until a new record appears.';

ALTER TABLE ds_t_int_hsicl_dtl MODIFY COLUMN STOCK_CODE VARCHAR(10) COMMENT 'Stock code, 5-digit zero-padded (e.g. 00001).';
ALTER TABLE ds_t_int_hsicl_dtl MODIFY COLUMN MODIFIED_DATE VARCHAR(20) COMMENT 'Effective date of this classification (YYYY-MM-DD).';
ALTER TABLE ds_t_int_hsicl_dtl MODIFY COLUMN INDUSTRY_CODE VARCHAR(10) NULL COMMENT 'Industry classification code.';
ALTER TABLE ds_t_int_hsicl_dtl MODIFY COLUMN INDUSTRY_NAME VARCHAR(100) NULL COMMENT 'Industry name (e.g. Information Technology, Energy, Healthcare).';
ALTER TABLE ds_t_int_hsicl_dtl MODIFY COLUMN SECTOR_CODE VARCHAR(10) NULL COMMENT 'Sector code within industry (4-digit).';
ALTER TABLE ds_t_int_hsicl_dtl MODIFY COLUMN SECTOR_NAME VARCHAR(100) NULL COMMENT 'Sector name (e.g. Software & Services, Oil & Gas).';

-- ============================================================
-- 5. sehknews - HKEX news and announcements
-- ============================================================
ALTER TABLE sehknews COMMENT='News and corporate announcements published on HKEX.';

ALTER TABLE sehknews MODIFY COLUMN `timestamp` VARCHAR(30) NULL COMMENT 'Publication datetime (e.g. 2025-01-02 18:44:37).';
ALTER TABLE sehknews MODIFY COLUMN securitycode VARCHAR(10) NULL COMMENT 'Stock code the news relates to.';
ALTER TABLE sehknews MODIFY COLUMN typeid INT NULL COMMENT 'News category ID.';
ALTER TABLE sehknews MODIFY COLUMN `type` VARCHAR(200) NULL COMMENT 'News category description.';
ALTER TABLE sehknews MODIFY COLUMN `text` TEXT NULL COMMENT 'News headline or content.';

-- ============================================================
-- 6. profit_loss - Company financial statements (P&L)
-- ============================================================
ALTER TABLE profit_loss COMMENT='Profit and Loss statements for listed companies. Revenue, profit, EPS and other financial metrics by financial year.';

ALTER TABLE profit_loss MODIFY COLUMN stock_code VARCHAR(10) COMMENT 'Stock code (not zero-padded, e.g. 1 instead of 00001).';
ALTER TABLE profit_loss MODIFY COLUMN company_name_en VARCHAR(200) NULL COMMENT 'Company name in English.';
ALTER TABLE profit_loss MODIFY COLUMN company_name_sc VARCHAR(200) NULL COMMENT 'Company name in Simplified Chinese.';
ALTER TABLE profit_loss MODIFY COLUMN company_name_tc VARCHAR(200) NULL COMMENT 'Company name in Traditional Chinese.';
ALTER TABLE profit_loss MODIFY COLUMN fin_yr VARCHAR(10) COMMENT 'Financial year end in YYYYMM format (e.g. 202503 = FY ending March 2025).';
ALTER TABLE profit_loss MODIFY COLUMN quarter VARCHAR(20) NULL COMMENT 'Report type: Final = full year, Interim = half year.';
ALTER TABLE profit_loss MODIFY COLUMN currency VARCHAR(10) NULL COMMENT 'Reporting currency.';
ALTER TABLE profit_loss MODIFY COLUMN turnover DECIMAL(20,2) NULL COMMENT 'Revenue / Turnover.';
ALTER TABLE profit_loss MODIFY COLUMN cost_of_sales DECIMAL(20,2) NULL COMMENT 'Cost of sales.';
ALTER TABLE profit_loss MODIFY COLUMN gross_profit DECIMAL(20,2) NULL COMMENT 'Gross profit.';
ALTER TABLE profit_loss MODIFY COLUMN plbt DECIMAL(20,2) NULL COMMENT 'Profit/Loss before taxation.';
ALTER TABLE profit_loss MODIFY COLUMN taxation DECIMAL(20,2) NULL COMMENT 'Tax expense.';
ALTER TABLE profit_loss MODIFY COLUMN pl_attr_to_shareholder DECIMAL(20,2) NULL COMMENT 'Net profit attributable to shareholders.';
ALTER TABLE profit_loss MODIFY COLUMN net_financial_costs DECIMAL(20,2) NULL COMMENT 'Net finance costs.';
ALTER TABLE profit_loss MODIFY COLUMN deprec_amort DECIMAL(20,2) NULL COMMENT 'Depreciation and amortization.';
ALTER TABLE profit_loss MODIFY COLUMN eps DECIMAL(16,6) NULL COMMENT 'Earnings per share.';
ALTER TABLE profit_loss MODIFY COLUMN dps DECIMAL(16,6) NULL COMMENT 'Dividends per share.';
ALTER TABLE profit_loss MODIFY COLUMN nbv_per_share DECIMAL(16,6) NULL COMMENT 'Net book value per share.';

-- ============================================================
-- 7. ccass_holdings - CCASS broker shareholding
-- ============================================================
ALTER TABLE ccass_holdings COMMENT='CCASS daily broker shareholding data from HKEX. One record per broker per stock per date.';

ALTER TABLE ccass_holdings MODIFY COLUMN holding_date DATE COMMENT 'Shareholding date.';
ALTER TABLE ccass_holdings MODIFY COLUMN stock_code VARCHAR(10) COMMENT 'Stock code (e.g. 00001).';
ALTER TABLE ccass_holdings MODIFY COLUMN stock_name VARCHAR(200) NULL COMMENT 'Stock name.';
ALTER TABLE ccass_holdings MODIFY COLUMN participant_id VARCHAR(20) COMMENT 'CCASS participant (broker) ID, starts with B.';
ALTER TABLE ccass_holdings MODIFY COLUMN shareholding BIGINT COMMENT 'Number of shares held by this broker.';
