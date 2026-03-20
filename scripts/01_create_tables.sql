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
    HSTXDT   VARCHAR(24)    NOT NULL COMMENT '交易日期/快照时间 (如 02JAN2025:09:20:00)',
    HSHSI    DECIMAL(16,4)  NULL     COMMENT '恒生指数（主指数）',
    HSHSIX   DECIMAL(16,4)  NULL     COMMENT '恒生指数变体',
    HSFIN    DECIMAL(16,4)  NULL     COMMENT '恒生金融分类指数',
    HSFINX   DECIMAL(16,4)  NULL     COMMENT '恒生金融分类指数变体',
    HSUTL    DECIMAL(16,4)  NULL     COMMENT '恒生公用事业分类指数',
    HSUTLX   DECIMAL(16,4)  NULL     COMMENT '恒生公用事业分类指数变体',
    HSPROP   DECIMAL(16,4)  NULL     COMMENT '恒生地产分类指数',
    HSPROPX  DECIMAL(16,4)  NULL     COMMENT '恒生地产分类指数变体',
    HSCANI   DECIMAL(16,4)  NULL     COMMENT '恒生工商业分类指数',
    HSCANIX  DECIMAL(16,4)  NULL     COMMENT '恒生工商业分类指数变体',
    CLOSING  TINYINT        NULL     COMMENT '收盘标志 (0=盘中, 1=收盘)'
);

-- ============================================================
-- 2. 个股行情数据（SIS）
--    源文件: WORK_FILTER_FOR_MS_T_STK_SIS.csv
--    日期格式: 02JAN2025:00:00:00
-- ============================================================
DROP TABLE IF EXISTS ms_t_stk_sis;
CREATE TABLE ms_t_stk_sis (
    SITXDT  VARCHAR(24)    NOT NULL COMMENT '交易日期 (如 02JAN2025:00:00:00)',
    SISTKC  VARCHAR(10)    NOT NULL COMMENT '股票代码 (港交所编号)',
    SISTKN  VARCHAR(100)   NULL     COMMENT '股票名称/公司名称',
    SIHIGH  DECIMAL(16,4)  NULL     COMMENT '最高价 (HKD)',
    SILOW   DECIMAL(16,4)  NULL     COMMENT '最低价 (HKD)',
    SICLSE  DECIMAL(16,4)  NULL     COMMENT '收盘价 (HKD)',
    SIVOL   BIGINT         NULL     COMMENT '成交量 (股数)'
);

-- ============================================================
-- 3. 股票市值数据（月末快照）
--    源文件: SFC.MS_V_STOCK_CAPITAL Dummy.csv
--    日期格式: 31-JAN-25
-- ============================================================
DROP TABLE IF EXISTS ms_v_stock_capital;
CREATE TABLE ms_v_stock_capital (
    STKCD   VARCHAR(10)      NOT NULL COMMENT '股票代码 (5位零填充)',
    SIRXDT  VARCHAR(20)      NOT NULL COMMENT '月末参考日期 (如 31-JAN-25)',
    SLCSE   DECIMAL(16,4)    NULL     COMMENT '月末收盘价',
    STTNIS  BIGINT           NULL     COMMENT '已发行股份数',
    SICAP   DECIMAL(24,4)    NULL     COMMENT '市值 (SLCSE × STTNIS)'
);

-- ============================================================
-- 4. 行业分类数据
--    源文件: DS_T_INT_HSICL_DTL Dummy.csv
--    日期格式: 2025-01-02
-- ============================================================
DROP TABLE IF EXISTS ds_t_int_hsicl_dtl;
CREATE TABLE ds_t_int_hsicl_dtl (
    STOCK_CODE     VARCHAR(10)   NOT NULL COMMENT '股票代码 (5位零填充)',
    MODIFIED_DATE  VARCHAR(20)   NOT NULL COMMENT '行业分类生效日期 (YYYY-MM-DD)',
    INDUSTRY_CODE  VARCHAR(10)   NULL     COMMENT '行业分类代码',
    INDUSTRY_NAME  VARCHAR(100)  NULL     COMMENT '行业名称',
    SECTOR_CODE    VARCHAR(10)   NULL     COMMENT '板块分类代码',
    SECTOR_NAME    VARCHAR(100)  NULL     COMMENT '板块名称'
);

-- ============================================================
-- 5. 新闻公告数据
--    源文件: sehknews.csv
--    注意: CSV 字段有双引号包裹
-- ============================================================
DROP TABLE IF EXISTS sehknews;
CREATE TABLE sehknews (
    `timestamp`    VARCHAR(30)   NULL COMMENT '新闻发布时间',
    securitycode   VARCHAR(10)   NULL COMMENT '证券代码',
    typeid         INT           NULL     COMMENT '新闻类型ID',
    `type`         VARCHAR(200)  NULL     COMMENT '新闻类型描述',
    `text`         TEXT          NULL     COMMENT '新闻内容'
);

-- ============================================================
-- 6. 利润表数据（从 XML 解析后导入）
--    源文件: profit_loss/xml/*.xml
-- ============================================================
DROP TABLE IF EXISTS profit_loss;
CREATE TABLE profit_loss (
    stock_code        VARCHAR(10)    NOT NULL COMMENT '股票代码',
    company_name_en   VARCHAR(200)   NULL     COMMENT '公司英文名',
    company_name_sc   VARCHAR(200)   NULL     COMMENT '公司简体中文名',
    company_name_tc   VARCHAR(200)   NULL     COMMENT '公司繁体中文名',
    fin_yr            VARCHAR(10)    NOT NULL COMMENT '裁年 (如 202503)',
    quarter           VARCHAR(20)    NULL     COMMENT '报告类型 (Final/Interim)',
    currency          VARCHAR(10)    NULL     COMMENT '币种',
    turnover          DECIMAL(20,2)  NULL     COMMENT '营收',
    cost_of_sales     DECIMAL(20,2)  NULL     COMMENT '销售成本',
    gross_profit      DECIMAL(20,2)  NULL     COMMENT '毛利',
    plbt              DECIMAL(20,2)  NULL     COMMENT '税前利润',
    taxation          DECIMAL(20,2)  NULL     COMMENT '税项',
    pl_attr_to_shareholder DECIMAL(20,2) NULL COMMENT '归属股东利润',
    net_financial_costs    DECIMAL(20,2) NULL COMMENT '净财务费用',
    deprec_amort      DECIMAL(20,2)  NULL     COMMENT '折旧摊销',
    eps               DECIMAL(16,6)  NULL     COMMENT '每股收益',
    dps               DECIMAL(16,6)  NULL     COMMENT '每股股息',
    nbv_per_share     DECIMAL(16,6)  NULL     COMMENT '每股净资产'
);

-- ============================================================
-- 7. CCASS 经纪商持仓数据（爬虫获取）
--    源: https://www3.hkexnews.hk/sdw/search/searchsdw.aspx
-- ============================================================
DROP TABLE IF EXISTS ccass_holdings;
CREATE TABLE ccass_holdings (
    holding_date    DATE           NOT NULL COMMENT '持仓日期',
    stock_code      VARCHAR(10)    NOT NULL COMMENT '股票代码 (如 00001)',
    stock_name      VARCHAR(200)   NULL     COMMENT '股票名称',
    participant_id  VARCHAR(20)    NOT NULL COMMENT '经纪商 ID (以B开头)',
    shareholding    BIGINT         NOT NULL COMMENT '持股数量'
);
