-- HK SFC POC - 更新表注释和列注释（英文，便于 LLM 理解）
-- 用法: mysql -h ... -u ... -p... hk_sfc < scripts/05_update_comments.sql

-- ============================================================
-- 1. ms_t_stk_hsi - Hang Seng Index intraday & closing snapshots
-- ============================================================
ALTER TABLE ms_t_stk_hsi COMMENT='Hang Seng Index (HSI) intraday and closing snapshots. Contains main HSI and sector sub-indices. Use CLOSING=9 to filter for end-of-day closing records. Date format: DDMONYYYY:HH:MI:SS (e.g. 02JAN2025:09:20:00). To compare daily index changes, use closing records (CLOSING=9) and compare HSHSI between consecutive trading days.';

ALTER TABLE ms_t_stk_hsi MODIFY COLUMN HSTXDT VARCHAR(24) COMMENT 'Trading date and time. Format: DDMONYYYY:HH:MI:SS (e.g. 02JAN2025:09:20:00). Multiple snapshots per day; use CLOSING=9 for end-of-day record.';
ALTER TABLE ms_t_stk_hsi MODIFY COLUMN HSHSI DECIMAL(16,4) NULL COMMENT 'Hang Seng Index (HSI) main index value in points. Primary benchmark for Hong Kong stock market.';
ALTER TABLE ms_t_stk_hsi MODIFY COLUMN HSHSIX DECIMAL(16,4) NULL COMMENT 'HSI extended/composite variant index value.';
ALTER TABLE ms_t_stk_hsi MODIFY COLUMN HSFIN DECIMAL(16,4) NULL COMMENT 'Hang Seng Finance Sub-index (banks, insurance, financial sector).';
ALTER TABLE ms_t_stk_hsi MODIFY COLUMN HSFINX DECIMAL(16,4) NULL COMMENT 'Finance Sub-index extended variant.';
ALTER TABLE ms_t_stk_hsi MODIFY COLUMN HSUTL DECIMAL(16,4) NULL COMMENT 'Hang Seng Utilities Sub-index (power, gas, telecom).';
ALTER TABLE ms_t_stk_hsi MODIFY COLUMN HSUTLX DECIMAL(16,4) NULL COMMENT 'Utilities Sub-index extended variant.';
ALTER TABLE ms_t_stk_hsi MODIFY COLUMN HSPROP DECIMAL(16,4) NULL COMMENT 'Hang Seng Properties Sub-index (real estate, REITs).';
ALTER TABLE ms_t_stk_hsi MODIFY COLUMN HSPROPX DECIMAL(16,4) NULL COMMENT 'Properties Sub-index extended variant.';
ALTER TABLE ms_t_stk_hsi MODIFY COLUMN HSCANI DECIMAL(16,4) NULL COMMENT 'Hang Seng Commerce & Industry Sub-index (tech, consumer, industrial).';
ALTER TABLE ms_t_stk_hsi MODIFY COLUMN HSCANIX DECIMAL(16,4) NULL COMMENT 'Commerce & Industry Sub-index extended variant.';
ALTER TABLE ms_t_stk_hsi MODIFY COLUMN CLOSING TINYINT NULL COMMENT 'Closing flag: 0=intraday snapshot, 9=end-of-day closing record. Always filter CLOSING=9 for daily analysis.';

-- ============================================================
-- 2. ms_t_stk_sis - Individual stock daily trading data
-- ============================================================
ALTER TABLE ms_t_stk_sis COMMENT='Daily trading data for all individual stocks listed on HKEX. Each row = one stock on one trading day. Contains closing price, high, low, and TRADING VOLUME. Date format: DDMONYYYY:HH:MI:SS (e.g. 02JAN2025:00:00:00). This is the primary source for stock-level price and volume analysis.';

ALTER TABLE ms_t_stk_sis MODIFY COLUMN SITXDT VARCHAR(24) COMMENT 'Trading date. Format: DDMONYYYY:HH:MI:SS (e.g. 02JAN2025:00:00:00). One record per stock per trading day.';
ALTER TABLE ms_t_stk_sis MODIFY COLUMN SISTKC VARCHAR(10) COMMENT 'Stock code on HKEX (e.g. 00001, 00005). Use this to join with other tables by stock code.';
ALTER TABLE ms_t_stk_sis MODIFY COLUMN SISTKN VARCHAR(100) NULL COMMENT 'Stock name / company name in English.';
ALTER TABLE ms_t_stk_sis MODIFY COLUMN SIHIGH DECIMAL(16,4) NULL COMMENT 'Highest traded price during the day (HKD).';
ALTER TABLE ms_t_stk_sis MODIFY COLUMN SILOW DECIMAL(16,4) NULL COMMENT 'Lowest traded price during the day (HKD).';
ALTER TABLE ms_t_stk_sis MODIFY COLUMN SICLSE DECIMAL(16,4) NULL COMMENT 'Closing price / last traded price for the day (HKD). Use for moving average calculations.';
ALTER TABLE ms_t_stk_sis MODIFY COLUMN SIVOL BIGINT NULL COMMENT 'Trading volume = total number of shares traded during the day. Use SUM(SIVOL) to get total market volume.';

-- ============================================================
-- 3. ms_v_stock_capital - Monthly market capitalization snapshots
-- ============================================================
ALTER TABLE ms_v_stock_capital COMMENT='Month-end market capitalization snapshot for all stocks. 12 records per stock (one per month in 2025). Use to calculate industry-level market cap aggregations. Date format: DD-MON-YY (e.g. 31-JAN-25).';

ALTER TABLE ms_v_stock_capital MODIFY COLUMN STKCD VARCHAR(10) COMMENT 'Stock code, 5-digit zero-padded (e.g. 00001). Join key with ds_t_int_hsicl_dtl.STOCK_CODE.';
ALTER TABLE ms_v_stock_capital MODIFY COLUMN SIRXDT VARCHAR(20) COMMENT 'Month-end reference date. Format: DD-MON-YY (e.g. 31-JAN-25, 28-FEB-25).';
ALTER TABLE ms_v_stock_capital MODIFY COLUMN SLCSE DECIMAL(16,4) NULL COMMENT 'Stock closing price at month-end (HKD).';
ALTER TABLE ms_v_stock_capital MODIFY COLUMN STTNIS BIGINT NULL COMMENT 'Total shares in issue (outstanding shares) at month-end.';
ALTER TABLE ms_v_stock_capital MODIFY COLUMN SICAP DECIMAL(24,4) NULL COMMENT 'Market capitalization = SLCSE * STTNIS. Total market value of the stock at month-end.';

-- ============================================================
-- 4. ds_t_int_hsicl_dtl - Industry/sector classification history
-- ============================================================
ALTER TABLE ds_t_int_hsicl_dtl COMMENT='Industry and sector classification for stocks, with historical changes. Only records CHANGES (not monthly snapshots). Use Carry Forward logic: a stock keeps its most recent classification until a new change record appears. If multiple records exist in the same month, use the one with the latest MODIFIED_DATE. Join with ms_v_stock_capital on STOCK_CODE=STKCD to get market cap by industry.';

ALTER TABLE ds_t_int_hsicl_dtl MODIFY COLUMN STOCK_CODE VARCHAR(10) COMMENT 'Stock code, 5-digit zero-padded (e.g. 00001). Join key with ms_v_stock_capital.STKCD.';
ALTER TABLE ds_t_int_hsicl_dtl MODIFY COLUMN MODIFIED_DATE VARCHAR(20) COMMENT 'Date when this industry classification became effective (YYYY-MM-DD). Use Carry Forward: apply most recent classification to subsequent months.';
ALTER TABLE ds_t_int_hsicl_dtl MODIFY COLUMN INDUSTRY_CODE VARCHAR(10) NULL COMMENT 'High-level industry code (e.g. 70=Information Technology, 25=Consumer Staples).';
ALTER TABLE ds_t_int_hsicl_dtl MODIFY COLUMN INDUSTRY_NAME VARCHAR(100) NULL COMMENT 'Industry name (e.g. Information Technology, Energy, Healthcare).';
ALTER TABLE ds_t_int_hsicl_dtl MODIFY COLUMN SECTOR_CODE VARCHAR(10) NULL COMMENT 'Granular sector code within industry (4-digit, e.g. 7020=Software & Services).';
ALTER TABLE ds_t_int_hsicl_dtl MODIFY COLUMN SECTOR_NAME VARCHAR(100) NULL COMMENT 'Sector name (e.g. Software & Services, Oil & Gas, Travel & Leisure).';

-- ============================================================
-- 5. sehknews - HKEX news and announcements
-- ============================================================
ALTER TABLE sehknews COMMENT='News and corporate announcements from HKEX (Hong Kong Exchange). For detecting material news, filter by typeid IN (0,3,7,8,10,14,18,21,25,26,28,32). When news is released on non-trading day or after market hours, use the next available trading day for volume comparison.';

ALTER TABLE sehknews MODIFY COLUMN `timestamp` VARCHAR(30) NULL COMMENT 'News publication datetime (e.g. 2025-01-02 18:44:37). If on non-trading day, compare volume on next trading day.';
ALTER TABLE sehknews MODIFY COLUMN securitycode VARCHAR(10) NULL COMMENT 'Stock code the news relates to. Join with ms_t_stk_sis.SISTKC for trading data.';
ALTER TABLE sehknews MODIFY COLUMN typeid INT NULL COMMENT 'News category ID. Material news types: typeid IN (0,3,7,8,10,14,18,21,25,26,28,32).';
ALTER TABLE sehknews MODIFY COLUMN `type` VARCHAR(200) NULL COMMENT 'News category description (e.g. Announcements & Notices, Financial Statements).';
ALTER TABLE sehknews MODIFY COLUMN `text` TEXT NULL COMMENT 'News headline or content text.';

-- ============================================================
-- 6. profit_loss - Company financial statements (P&L)
-- ============================================================
ALTER TABLE profit_loss COMMENT='Profit & Loss (income statement) data for listed companies. Each row = one company for one financial year/period. Contains revenue (turnover), profit, EPS etc. FinYr format: YYYYMM (e.g. 202503 = fiscal year ending March 2025). Quarter: Final=annual, Interim=half-year. Stock codes are NOT zero-padded (e.g. 1 not 00001).';

ALTER TABLE profit_loss MODIFY COLUMN stock_code VARCHAR(10) COMMENT 'Stock code (NOT zero-padded, e.g. 1 for CK Hutchison, 5 for HSBC). To join with other tables, use LPAD(stock_code, 5, ''0'').';
ALTER TABLE profit_loss MODIFY COLUMN company_name_en VARCHAR(200) NULL COMMENT 'Company name in English.';
ALTER TABLE profit_loss MODIFY COLUMN company_name_sc VARCHAR(200) NULL COMMENT 'Company name in Simplified Chinese.';
ALTER TABLE profit_loss MODIFY COLUMN company_name_tc VARCHAR(200) NULL COMMENT 'Company name in Traditional Chinese.';
ALTER TABLE profit_loss MODIFY COLUMN fin_yr VARCHAR(10) COMMENT 'Financial year end in YYYYMM format (e.g. 202503=FY ending Mar 2025, 202312=FY ending Dec 2023). Compare same month across years (e.g. 202503 vs 202303).';
ALTER TABLE profit_loss MODIFY COLUMN quarter VARCHAR(20) NULL COMMENT 'Report period type: Final=full year results, Interim=half-year results.';
ALTER TABLE profit_loss MODIFY COLUMN currency VARCHAR(10) NULL COMMENT 'Reporting currency (usually HKD).';
ALTER TABLE profit_loss MODIFY COLUMN turnover DECIMAL(20,2) NULL COMMENT 'Revenue / Turnover - total sales revenue for the period.';
ALTER TABLE profit_loss MODIFY COLUMN cost_of_sales DECIMAL(20,2) NULL COMMENT 'Cost of sales / Cost of goods sold.';
ALTER TABLE profit_loss MODIFY COLUMN gross_profit DECIMAL(20,2) NULL COMMENT 'Gross profit = turnover - cost_of_sales.';
ALTER TABLE profit_loss MODIFY COLUMN plbt DECIMAL(20,2) NULL COMMENT 'Profit/Loss before taxation.';
ALTER TABLE profit_loss MODIFY COLUMN taxation DECIMAL(20,2) NULL COMMENT 'Tax expense (usually negative).';
ALTER TABLE profit_loss MODIFY COLUMN pl_attr_to_shareholder DECIMAL(20,2) NULL COMMENT 'Net profit attributable to shareholders.';
ALTER TABLE profit_loss MODIFY COLUMN net_financial_costs DECIMAL(20,2) NULL COMMENT 'Net finance costs (interest expense minus income).';
ALTER TABLE profit_loss MODIFY COLUMN deprec_amort DECIMAL(20,2) NULL COMMENT 'Depreciation and amortization expense.';
ALTER TABLE profit_loss MODIFY COLUMN eps DECIMAL(16,6) NULL COMMENT 'Earnings per share.';
ALTER TABLE profit_loss MODIFY COLUMN dps DECIMAL(16,6) NULL COMMENT 'Dividends per share.';
ALTER TABLE profit_loss MODIFY COLUMN nbv_per_share DECIMAL(16,6) NULL COMMENT 'Net book value per share.';

-- ============================================================
-- 7. ccass_holdings - CCASS broker shareholding data
-- ============================================================
ALTER TABLE ccass_holdings COMMENT='CCASS (Central Clearing and Settlement System) daily broker shareholding data from HKEX. Each row = one broker holding for one stock on one date. To detect inter-broker movements >30%, compare shareholding for the same stock+broker between two consecutive dates: ABS((T_day - T_minus_1) / T_minus_1) > 0.30.';

ALTER TABLE ccass_holdings MODIFY COLUMN holding_date DATE COMMENT 'Shareholding date.';
ALTER TABLE ccass_holdings MODIFY COLUMN stock_code VARCHAR(10) COMMENT 'Stock code (e.g. 00001). Join with ms_t_stk_sis.SISTKC.';
ALTER TABLE ccass_holdings MODIFY COLUMN stock_name VARCHAR(200) NULL COMMENT 'Stock name.';
ALTER TABLE ccass_holdings MODIFY COLUMN participant_id VARCHAR(20) COMMENT 'CCASS participant (broker) ID, starts with B for brokers.';
ALTER TABLE ccass_holdings MODIFY COLUMN shareholding BIGINT COMMENT 'Number of shares held by this broker for this stock on this date.';
